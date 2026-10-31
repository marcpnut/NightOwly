# NightOwly

NightOwly is a standalone client for people who have an Xtream Codes provider account. It uses the NightOwl interface and navigation model, but connects directly to the provider. It does not require or connect to the NightOwl server, catalog, or browser application.

## Sign in

Enter your provider's base URL (for example, `http://provider.example:8080`), Xtream username, and password. The credentials are stored in this browser or TV's local storage. Stream URLs are generated on the device and connect directly to the provider.

Providers must permit direct connections from the device. Browser use also requires the provider to allow cross-origin requests (CORS); when a provider blocks browser connections, use the webOS client if it can connect, or ask the provider to allow the NightOwly origin. NightOwly does not proxy or relay streams.

NightOwly uses provider-supplied titles, categories, artwork, descriptions, and stream IDs as available. It does not normalize provider titles or merge equivalent categories. Optional TMDB and OpenSubtitles keys are stored locally.

## Build

Requirements: Node.js and pnpm.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm package:webos
```

The browser build is in `client/dist`. The LG webOS IPK is generated under `packages/`; install it with `ares-install --device <device-name> <ipk-file>` after pairing the TV in Developer Mode.

The client targets Chromium 53 for LG webOS 4.5 and does not depend on the copied development server directory. The app package ID is `com.nightowly.iptv`.
