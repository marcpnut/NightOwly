# NightOwly for LG webOS TV

NightOwly connects directly to an Xtream provider. No NightOwl account or server is required. At first launch, enter the provider URL, Xtream username, and password. These values are saved on the TV.

Version 1.0.1 adds a Netflix-style next-episode prompt during the final ten seconds of an episode, with a filling progress bar, Play now, and Cancel. Detail-page Back and My List actions now stay above nearby content, and scroll indicators no longer receive keyboard or remote focus.

Build the IPK with `pnpm package:webos`; the package is written to `packages/`. Install using the webOS TV CLI after pairing the TV in Developer Mode:

```powershell
ares-install --device <your-device-name> .\packages\com.nightowly.iptv_1.0.1_all.ipk
```

Provider connections and playback are direct from the TV. Availability depends on provider reachability and the formats/codecs supported by the device. NightOwly does not use the NightOwl server or browser application.
