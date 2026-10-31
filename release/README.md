# NightOwl for LG webOS TV

Version 0.3.3 is packaged for LG webOS TVs including the C9. Shelf focus and vertical scrolling now start together so the focused card moves with its row. Arrows move focus to a language or category dropdown without changing its value; press OK/Enter to open it. Dropdown options render above clipped panels with consistent styling. Movie detail headings reuse the selected card's normalized title. Movie posters keep a portrait 2:3 size on C9. Pointer hover transfers focus to the hovered card so only one tile shows the cyan focus ring. The series view shows scroll arrows independently for the season and episode lists, only when each list can scroll in that direction. Descriptions prefer English, then Dutch, then Polish when the translation exists.

Download [`NightOwl-webos-c9-0.3.3.ipk`](NightOwl-webos-c9-0.3.3.ipk) and install it using the webOS TV CLI after pairing the TV in Developer Mode:

```powershell
ares-install --device <your-device-name> .\NightOwl-webos-c9-0.3.3.ipk
```

The app connects to `https://[redacted]`. Sign in with the NightOwl account created by the administrator. Xtream credentials remain in the server Settings page.

This package uses the same NightOwl interface as the browser app and the TV's HTML video playback pipeline. webOS TV 4.5 lists MKV with MPEG-2, MPEG-4, H.264, VP8, VP9, or HEVC video, and Dolby Digital, Dolby Digital Plus, AAC, PCM, DTS, or MPEG audio. Playback still depends on the exact stream codec/profile and the TV; packaging does not add codecs or guarantee every MKV file will play.

Build command: `pnpm package:webos`.
