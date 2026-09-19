Tampermonkey userscript for `music.youtube.com`. Buffers audio for the current track and the next two tracks in memory, using the existing YouTube session and native player. Selects audio-only formats and downloads directly from YouTube.

## Installation

1. In a browser with Tampermonkey, open [the userscript](https://raw.githubusercontent.com/sashokey/ytm-metro/master/ytm-metro.user.js) and install it. If the browser displays the source, paste it into **Tampermonkey → Dashboard → Create a new script** and save.
2. Reload `music.youtube.com` and start playback.

Updates are fetched from this repository through Tampermonkey. Keep automatic update checks enabled. If you previously installed version 1.0.0 by copying the code, reinstall once using the link above to configure future updates.

## Usage

Wait for **Metro 2/2** before losing connectivity: both upcoming audio files are fully buffered. Use the site's playback controls. The reserve replenishes during playback when connectivity is available. Tap **Metro** to retry incomplete downloads.

## Limits

- Audio only; live streams and files larger than 16 MiB are not buffered.
- Reloading, closing, or discarding the tab clears the buffer. Uncached tracks require connectivity.
- Native ads can delay offline transitions; delays of approximately 20 seconds were observed. Browser background-playback restrictions still apply.
- Uses internal YouTube APIs and the UMP media format; site changes may require updates.

Tested on the live mobile site in Chromium with Android emulation and networking disabled: two automatic track transitions, seeking, Play/Pause, and reserve replenishment after reconnection. Physical phones and installation through Tampermonkey have not been tested.
