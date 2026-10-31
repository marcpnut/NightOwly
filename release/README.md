# NightOwl for LG webOS TV

Version 0.3.5 is packaged for LG webOS TVs including the C9. Choosing a category from the left jump panel now scrolls its shelf to the top, keeps the selected card focused, and preserves that row while it loads. Settings let you hide or show Movie and Show categories, and the jump panel lists only categories enabled in Settings. Shelf focus and scrolling stay synchronized. Arrows move focus to a language or category dropdown without changing its value; press OK/Enter to open it. Movie detail headings reuse the selected card's normalized title, and descriptions prefer English, then Dutch, then Polish when available.

Download [`NightOwl-webos-c9-0.3.5.ipk`](NightOwl-webos-c9-0.3.5.ipk) and install it using the webOS TV CLI after pairing the TV in Developer Mode:

```powershell
ares-install --device <your-device-name> .\NightOwl-webos-c9-0.3.5.ipk
```

The app connects to `https://[redacted]`. Sign in with the NightOwl account created by the administrator. Xtream credentials remain in the server Settings page.

This package uses the same NightOwl interface as the browser app and the TV's HTML video playback pipeline. webOS TV 4.5 lists MKV with MPEG-2, MPEG-4, H.264, VP8, VP9, or HEVC video, and Dolby Digital, Dolby Digital Plus, AAC, PCM, DTS, or MPEG audio. Playback still depends on the exact stream codec/profile and the TV; packaging does not add codecs or guarantee every MKV file will play.

Build command: `pnpm package:webos`.
