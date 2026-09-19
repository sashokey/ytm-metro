// ==UserScript==
// @name         YouTube Music Metro Buffer
// @namespace    local.ytm.metro
// @version      1.0.1
// @description  Keep the current song and two upcoming songs in memory for network gaps.
// @homepageURL  https://github.com/sashokey/ytm-metro
// @updateURL    https://raw.githubusercontent.com/sashokey/ytm-metro/master/ytm-metro.user.js
// @downloadURL  https://raw.githubusercontent.com/sashokey/ytm-metro/master/ytm-metro.user.js
// @match        https://music.youtube.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    if (window.top !== window || window.__ytmMetro) return;
    const ahead = 2;
    const maximum = 16 * 1024 * 1024;
    const originalFetch = window.fetch;
    const entries = new Map();
    const resources = new Map();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const listeners = new AbortController();
    let wanted = [];
    let upcoming = [];
    let controller;
    let unsubscribe;
    let originalLoad;
    let button;
    let busy;
    let timer;
    let stopped = false;
    let queueKey = '';
    let localHits = 0;

    const varint = number => {
        const bytes = [];
        do {
            const byte = number % 128;
            number = Math.floor(number / 128);
            bytes.push(byte | (number ? 128 : 0));
        } while (number);
        return bytes;
    };
    const umpInt = number => {
        if (number < 128) return [number];
        if (number < 16384) return [(number & 63) | 128, number >> 6];
        if (number < 2097152) return [(number & 31) | 192, number >> 5 & 255, number >> 13];
        return [(number & 15) | 224, number >> 4 & 255, number >> 12 & 255, number >> 20];
    };
    const numeric = (field, number) => [...varint(field * 8), ...varint(number)];
    const bytes = (field, value) => [...varint(field * 8 + 2), ...varint(value.length), ...value];
    const part = (type, blob) => new Blob([new Uint8Array([...umpInt(type), ...umpInt(blob.size)]), blob]);

    function readUmp(data, cursor) {
        const first = data[cursor.pos++];
        if (first === undefined) throw Error('Incomplete UMP');
        let count = 1;
        while (count <= 5 && first & (128 >> (count - 1))) count++;
        if (count > 5 || cursor.pos + count - 1 > data.length) throw Error('Incomplete UMP');
        let value = count === 5 ? 0 : first & (255 >> count);
        let shift = count === 5 ? 0 : 8 - count;
        for (let i = 1; i < count; i++, shift += 8) value += data[cursor.pos++] * 2 ** shift;
        return value;
    }

    function readProto(data) {
        let pos = 0;
        const fields = new Map();
        const read = () => {
            let value = 0;
            let shift = 0;
            for (;;) {
                if (pos >= data.length || shift > 56) throw Error('Invalid protobuf');
                const byte = data[pos++];
                value += (byte & 127) * 2 ** shift;
                if (!(byte & 128)) return value;
                shift += 7;
            }
        };
        while (pos < data.length) {
            const key = read();
            const type = key & 7;
            let value;
            if (type === 0) value = read();
            else if (type === 2) {
                const length = read();
                if (length > data.length - pos) throw Error('Invalid protobuf length');
                value = data.slice(pos, pos + length);
                pos += length;
            } else if (type === 1) pos += 8;
            else if (type === 5) pos += 4;
            else throw Error('Unsupported protobuf');
            fields.set(Math.floor(key / 8), value);
        }
        return fields;
    }

    function mediaURL(input) {
        const text = input instanceof Request ? input.url : String(input);
        if (!text.includes('.googlevideo.com/videoplayback')) return;
        const url = new URL(text);
        if (!url.hostname.endsWith('.googlevideo.com') || url.pathname !== '/videoplayback') return;
        if (!url.searchParams.get('mime')?.startsWith('audio/') || !url.searchParams.has('range')) return;
        const size = Number(url.searchParams.get('clen'));
        if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) return;
        return url;
    }

    const resourceKey = url => ['id', 'itag', 'lmt', 'clen', 'xtags'].map(key => url.searchParams.get(key) || '').join('|');
    const entryFor = id => {
        if (!entries.has(id)) entries.set(id, {id, attempted: false, preloaded: false});
        return entries.get(id);
    };

    async function inspectMedia(response, url) {
        if (!response.ok || !response.headers.get('Content-Type')?.includes('yt-ump')) return;
        const reader = response.clone().body.getReader();
        let data = new Uint8Array();
        let protection;
        try {
            while (data.length < 32768) {
                const result = await reader.read();
                if (result.done) break;
                const combined = new Uint8Array(data.length + result.value.length);
                combined.set(data);
                combined.set(result.value, data.length);
                data = combined;
                const cursor = {pos: 0};
                try {
                    while (cursor.pos < data.length) {
                        const type = readUmp(data, cursor);
                        const size = readUmp(data, cursor);
                        if (size > data.length - cursor.pos) break;
                        const payload = data.slice(cursor.pos, cursor.pos + size);
                        cursor.pos += size;
                        if (type === 58) protection = payload;
                        if (type !== 20) continue;
                        const fields = readProto(payload);
                        const id = decoder.decode(fields.get(2));
                        if (!wanted.includes(id) || !protection || fields.get(7)) return;
                        const entry = entryFor(id);
                        if (!entry.url) {
                            entry.url = url;
                            entry.protection = protection;
                            entry.itag = fields.get(3);
                            entry.lmt = fields.get(4);
                            entry.xtags = fields.get(5);
                            entry.size = Number(url.searchParams.get('clen'));
                            resources.set(resourceKey(url), entry);
                            schedule();
                        }
                        return;
                    }
                } catch {}
            }
        } finally {
            reader.cancel().catch(() => {});
        }
    }

    function cachedResponse(entry, url, input, init) {
        const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
        if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        const range = /^(\d+)-(\d*)$/.exec(url.searchParams.get('range'));
        if (!range) return;
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) + 1 : entry.blob.size, entry.blob.size);
        if (start >= end) return;
        let body = entry.blob.slice(start, end);
        let type = entry.blob.type;
        if (url.searchParams.get('ump') === '1') {
            const format = [...numeric(1, entry.itag), ...numeric(2, entry.lmt)];
            if (entry.xtags?.length) format.push(...bytes(3, entry.xtags));
            const header = [
                ...numeric(1, 0), ...bytes(2, encoder.encode(entry.id)), ...numeric(3, entry.itag),
                ...numeric(4, entry.lmt), ...numeric(6, start), ...bytes(13, format), ...numeric(14, end - start)
            ];
            if (entry.xtags?.length) header.push(...bytes(5, entry.xtags));
            body = new Blob([
                part(58, new Blob([entry.protection])), part(20, new Blob([new Uint8Array(header)])),
                part(21, new Blob([new Uint8Array([0]), body])), part(22, new Blob([new Uint8Array([0])]))
            ]);
            type = 'application/vnd.yt-ump';
        }
        localHits++;
        return Promise.resolve(new Response(body, {status: 200, headers: {'Content-Type': type}}));
    }

    function interceptedFetch(input, init) {
        let url;
        try { url = mediaURL(input); } catch {}
        if (url) {
            const entry = resources.get(resourceKey(url));
            if (entry?.blob) {
                const cached = cachedResponse(entry, url, input, init);
                if (cached) return cached;
            }
        }
        const request = originalFetch.apply(this, arguments);
        const text = input instanceof Request ? input.url : String(input);
        if (url) request.then(response => inspectMedia(response, url)).catch(() => {});
        else if (text.includes('/youtubei/v1/player')) {
            return request.then(async response => {
                if (!response.ok) return response;
                try {
                    const data = await response.clone().json();
                    const id = data.videoDetails?.videoId;
                    const queued = wanted.includes(id) || document.getElementById('queue')?.getState?.().queue?.items?.some(item => renderer(item)?.videoId === id);
                    if (!queued) return response;
                    const audio = data.streamingData?.adaptiveFormats?.filter(format => format.mimeType?.startsWith('audio/'));
                    if (!audio?.length || data.videoDetails.isLiveContent) return response;
                    data.streamingData.adaptiveFormats = audio;
                    delete data.streamingData.formats;
                    if (wanted.includes(id)) entryFor(id).response = data;
                    const headers = new Headers(response.headers);
                    headers.delete('Content-Length');
                    headers.delete('Content-Encoding');
                    const result = new Response(JSON.stringify(data), {status: response.status, statusText: response.statusText, headers});
                    Object.defineProperty(result, 'url', {value: response.url});
                    return result;
                } catch { return response; }
            });
        }
        return request;
    }

    function render() {
        if (!button) return;
        const ready = upcoming.filter(id => entries.get(id)?.blob).length;
        const text = `Metro ${ready}/${upcoming.length}`;
        const color = ready === upcoming.length && ready ? 'rgb(143, 218, 155)' : 'rgb(238, 238, 238)';
        if (button.textContent !== text) button.textContent = text;
        if (button.style.color !== color) button.style.color = color;
        const total = [...entries.values()].reduce((sum, entry) => sum + (entry.blob?.size || 0), 0);
        const failed = [...entries.values()].some(entry => entry.error && !entry.blob);
        const title = `${navigator.onLine ? 'Online' : 'Offline'} · ${(total / 1048576).toFixed(1)} MB in memory\n${busy ? 'Buffering audio' : failed ? 'Some audio could not be buffered' : ready ? 'Upcoming audio ready' : 'Play a song to prepare the queue'}\nTap to retry incomplete downloads. Cache is cleared when this tab closes.`;
        if (button.title !== title) button.title = title;
    }

    function schedule() {
        if (!stopped && !timer) timer = setTimeout(() => { timer = 0; update(); }, 200);
    }

    async function download(entry) {
        const abort = new AbortController();
        busy = {entry, abort};
        entry.attempted = true;
        render();
        const timeout = setTimeout(() => abort.abort(), 90000);
        try {
            const url = new URL(entry.url);
            url.searchParams.set('range', `0-${entry.size - 1}`);
            url.searchParams.delete('ump');
            url.searchParams.delete('srfvp');
            const response = await originalFetch(url.href, {credentials: 'omit', signal: abort.signal});
            if (!response.ok || !response.headers.get('Content-Type')?.startsWith('audio/')) throw Error('Audio unavailable');
            const blob = await response.blob();
            if (blob.size !== entry.size) throw Error('Incomplete audio');
            if (entries.get(entry.id) === entry && wanted.includes(entry.id)) entry.blob = blob;
        } catch (error) {
            entry.error = error.name === 'AbortError' ? 'Interrupted' : 'Download unavailable';
        } finally {
            clearTimeout(timeout);
            busy = null;
            render();
            schedule();
        }
    }

    function renderer(item) {
        return item?.playlistPanelVideoRenderer || item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    }

    function update() {
        if (stopped) return;
        if (!controller) {
            const instance = document.getElementById('player')?.inst;
            controller = instance?.[Object.keys(instance).find(key => key.endsWith('_playerController'))];
            if (!controller?.store?.subscribe || !controller.playerApi?.preloadVideoByPlayerVars) {
                controller = null;
                return;
            }
            unsubscribe = controller.store.subscribe(schedule);
            originalLoad = controller.playerApi.loadVideoByPlayerVars;
            controller.playerApi.loadVideoByPlayerVars = function(vars, ...rest) {
                const entry = entries.get(vars.video_id || vars.videoId);
                if (entry?.blob && entry.response && !vars.autonav) vars = {...vars, audio_only: '1', raw_player_response: structuredClone(entry.response)};
                return originalLoad.call(this, vars, ...rest);
            };
            button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-label', 'Metro audio buffer status');
            button.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2200;background:#202020e8;color:#eee;border:1px solid #555;border-radius:12px;padding:4px 9px;font:11px system-ui;cursor:pointer;';
            button.addEventListener('click', retry, {signal: listeners.signal});
            document.body.append(button);
        }
        const state = controller.store.getState();
        const queue = state.queue;
        if (!queue?.items?.length) return;
        const index = queue.selectedItemIndex;
        const items = queue.items.slice(index, index + ahead + 1).map(renderer).filter(Boolean);
        const nextWanted = items.map(item => item.videoId);
        const key = nextWanted.join('|');
        if (key !== queueKey) {
            queueKey = key;
            wanted = nextWanted;
            upcoming = wanted.slice(1);
            if (busy && !wanted.includes(busy.entry.id)) busy.abort.abort();
            for (const [id, entry] of entries) if (!wanted.includes(id)) {
                if (entry.url) resources.delete(resourceKey(entry.url));
                entries.delete(id);
            }
        }
        if (!entries.get(wanted[0])?.response) {
            const current = controller.playerApi.getPlayerResponse?.();
            if (current?.videoDetails?.videoId === wanted[0]) entryFor(wanted[0]).response = current;
        }
        if (navigator.onLine && !state.player.adPlaying && (state.player.isPlaying || controller.playerApi.getPlayerState?.() === 1)) {
            const quality = window.ytcfg?.get('AUDIO_QUALITY');
            for (const item of items.slice(1)) {
                const entry = entryFor(item.videoId);
                const endpoint = item.navigationEndpoint;
                const watch = endpoint?.watchEndpoint;
                if (entry.preloaded || !watch) continue;
                entry.preloaded = true;
                const vars = {
                    video_id: watch.videoId, start: 0, player_params: watch.playerParams,
                    external_list: true, suppress_creator_endscreen: true,
                    aac_high: quality === 'AUDIO_QUALITY_HIGH' && !!window.ytcfg?.get('IS_SUBSCRIBER'),
                    prefer_low_quality_audio: quality === 'AUDIO_QUALITY_LOW',
                    csi_timer: controller.timerName || '', list: watch.playlistId, itct: endpoint.clickTrackingParams,
                    pause_at_start: false, autoplay: true, autonav: true, audio_only: '1'
                };
                try { controller.playerApi.preloadVideoByPlayerVars(vars); } catch { entry.error = 'Preload unavailable'; }
            }
            if (!busy) {
                const entry = [...upcoming, wanted[0]].map(id => entries.get(id)).find(entry => entry?.url && !entry.blob && !entry.attempted);
                if (entry) void download(entry);
            }
        }
        render();
    }

    function retry() {
        for (const entry of entries.values()) if (!entry.blob) {
            entry.attempted = false;
            entry.error = null;
        }
        schedule();
    }

    function stop() {
        stopped = true;
        clearTimeout(timer);
        busy?.abort.abort();
        unsubscribe?.();
        listeners.abort();
        if (window.fetch === interceptedFetch) window.fetch = originalFetch;
        if (controller && originalLoad) controller.playerApi.loadVideoByPlayerVars = originalLoad;
        button?.remove();
        entries.clear();
        resources.clear();
        delete window.__ytmMetro;
    }

    window.fetch = interceptedFetch;
    window.__ytmMetro = {
        stop,
        status: () => ({wanted: [...wanted], ready: [...entries.values()].filter(entry => entry.blob).map(entry => entry.id), localHits, downloading: busy?.entry.id || null, entries: [...entries.values()].map(entry => ({id: entry.id, source: !!entry.url, metadata: !!entry.response, bytes: entry.blob?.size || 0, error: entry.error || null}))})
    };
    for (const event of ['yt-navigate-finish', 'yt-player-updated', 'DOMContentLoaded']) document.addEventListener(event, schedule, {signal: listeners.signal});
    document.addEventListener('playing', schedule, {capture: true, signal: listeners.signal});
    window.addEventListener('online', retry, {signal: listeners.signal});
    window.addEventListener('offline', render, {signal: listeners.signal});
    window.addEventListener('pagehide', event => { if (!event.persisted) stop(); }, {signal: listeners.signal});
    schedule();
})();
