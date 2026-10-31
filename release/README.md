# NightOwl for LG webOS TV

Version 0.3.10 is packaged for LG webOS TVs including the C9. Focusing the Categories tab opens the menu and focuses the category of the last focused shelf card. Arrow Right or Back closes the menu and returns to that card without selecting or scrolling; press OK on a category to jump to it. Horizontal shelf scrolling now keeps the focused card and focus ring synchronized in the browser and webOS app. This behavior is the same in both. Category jumps fetch only the selected shelf and up to two above and three below; other shelves stay lightweight until near the viewport.

Download [`NightOwl-webos-c9-0.3.10.ipk`](NightOwl-webos-c9-0.3.10.ipk) and install it using the webOS TV CLI after pairing the TV in Developer Mode:

```powershell
ares-install --device <your-device-name> .\NightOwl-webos-c9-0.3.10.ipk
```

The app connects to `https://[redacted]`. Sign in with the NightOwl account created by the administrator. Xtream credentials remain in the server Settings page.

This package uses the same NightOwl interface as the browser app and the TV's HTML video playback pipeline. webOS TV 4.5 lists MKV with MPEG-2, MPEG-4, H.264, VP8, VP9, or HEVC video, and Dolby Digital, Dolby Digital Plus, AAC, PCM, DTS, or MPEG audio. Playback still depends on the exact stream codec/profile and the TV; packaging does not add codecs or guarantee every MKV file will play.

Build command: `pnpm package:webos`.
