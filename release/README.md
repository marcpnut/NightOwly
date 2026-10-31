# NightOwl for LG webOS TV

Version 0.2.6 is packaged for LG webOS TVs including the C9. Horizontal shelf navigation advances through cards, preloads upcoming pages, and keeps focus off shelf controls. The exit prompt traps focus on Stay and Exit. It also includes the Settings, Live TV, Search, and title row compatibility fixes from 0.2.5. Preview sizing keeps a centered 16:9 ratio. Previews start muted so TV autoplay restrictions do not block the video.

Download [`NightOwl-webos-c9-0.2.6.ipk`](NightOwl-webos-c9-0.2.6.ipk) and install it using the webOS TV CLI after pairing the TV in Developer Mode:

```powershell
ares-install --device <your-device-name> .\NightOwl-webos-c9-0.2.6.ipk
```

The app connects to `https://[redacted]`. Sign in with the NightOwl account created by the administrator. Xtream credentials remain in the server Settings page.

This package uses the same NightOwl interface as the browser app and the TV's HTML video playback pipeline. webOS TV 4.5 lists MKV with MPEG-2, MPEG-4, H.264, VP8, VP9, or HEVC video, and Dolby Digital, Dolby Digital Plus, AAC, PCM, DTS, or MPEG audio. Playback still depends on the exact stream codec/profile and the TV; packaging does not add codecs or guarantee every MKV file will play.

Build command: `pnpm package:webos`.
