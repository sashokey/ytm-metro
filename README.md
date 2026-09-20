Tampermonkey userscript for `music.youtube.com`. Buffers audio for the current track and the next two tracks in memory, using the existing YouTube session and native player. Selects audio-only formats and downloads directly from YouTube.

## Installation

1. Install `ytm-metro.user.js` with Tampermonkey, or paste its contents into **Tampermonkey → Dashboard → Create a new script** and save.
2. Reload `music.youtube.com` and start playback.

## Usage

Use the site's normal playback controls. The script adds no buttons, indicators, styles, or other UI.

Keep connectivity available while the upcoming audio files are downloaded. Fully buffered tracks remain available after the connection is lost. The reserve replenishes during playback when connectivity is available; failed downloads are eligible for another attempt when the browser reports that the connection has returned.

Repeat all includes tracks at the beginning of the queue. Already buffered tracks are reused, including repeated entries in the queue.

## Limits

- Audio only; live streams and files larger than 16 MiB are not buffered.
- The two upcoming tracks must finish downloading before connectivity is lost. There is no visible readiness indicator.
- Reloading, closing, or discarding the tab clears the buffer. Uncached tracks require connectivity.
- Native ads can delay offline transitions. Browser background-playback restrictions still apply.
