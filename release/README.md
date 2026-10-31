# NightOwl for LG webOS TV

Version 0.2.9 is packaged for LG webOS TVs including the C9. The fullscreen control is removed from the TV player. Shelf cards stay on one horizontal line, advance with a smooth card-sized scroll, and preload five cards at a time. Pointer hover moves focus to the hovered tile and uses the single cyan focus treatment. This includes the audible preview, Live TV row spacing, vertical row positioning, exit focus trap, styled dropdowns, and Settings and Search compatibility fixes.

Download [`NightOwl-webos-c9-0.2.9.ipk`](NightOwl-webos-c9-0.2.9.ipk) and install it using the webOS TV CLI after pairing the TV in Developer Mode:

```powershell
ares-install --device <your-device-name> .\NightOwl-webos-c9-0.2.9.ipk
```

The app connects to `https://[redacted]`. Sign in with the NightOwl account created by the administrator. Xtream credentials remain in the server Settings page.

This package uses the same NightOwl interface as the browser app and the TV's HTML video playback pipeline. webOS TV 4.5 lists MKV with MPEG-2, MPEG-4, H.264, VP8, VP9, or HEVC video, and Dolby Digital, Dolby Digital Plus, AAC, PCM, DTS, or MPEG audio. Playback still depends on the exact stream codec/profile and the TV; packaging does not add codecs or guarantee every MKV file will play.

Build command: `pnpm package:webos`.
