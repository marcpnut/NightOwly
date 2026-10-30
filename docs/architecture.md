# StreamCinema architecture

StreamCinema is a standalone LG webOS IPTV client and a central catalog server. It does not import or package the existing NextFlix application. The original repository was inspected as a compatibility reference only.

```text
Xtream provider → catalog refresh → PostgreSQL catalog → authenticated /api/v1 → LG TVs
                     metadata only                              ↘ direct provider playback URL
```

## Server

- Node.js/TypeScript, Fastify, PostgreSQL, Zod. PostgreSQL is bound only to the private Compose network.
- Provider username/password are encrypted with AES-256-GCM in `provider_config`. The key comes from a protected environment variable. No provider administration API is exposed.
- In normalized-catalog mode, the Database page and a nightly 03:00 Europe/Amsterdam job compare an M3U playlist snapshot with known provider IDs. The importer downloads the playlist to a private temporary file, streams through its entries, enriches only unseen movies and affected series, records additions in an import batch, and removes the temporary file on completion or failure. Existing streams are not replaced or deleted. “What’s New” shows all items imported in successful batches during the last seven days.
- Refresh retries transient failures and uses a PostgreSQL advisory lock to avoid overlapping sync jobs. Cached catalog data remains available while it runs. Favorites and progress are stored separately and are preserved.
- Catalog upserts operate in 100-item batches. Movie/series/live listing endpoints limit pages to 20 items. Episode browsing uses a separate 20-item page per season.
- Cached catalog data remains available while sync runs. Favorites and progress are stored in separate tables, so catalog refreshes preserve them.
- Home discovery uses TMDB movie/TV feeds (trending, top rated, recent releases, theatrical now playing, popular/on-air shows), then title/year-matches results back to the Xtream catalog. Only matching provider items are playable. Live TV and provider category dumps stay out of Home; Live TV remains in its own navigation section. TMDB feed responses are cached in the API process for six hours.
- Home features a playable trending TMDB match, then Continue Watching, Top Picks, Top 250, New Releases, In Cinemas, and Trending Series. Movies and Shows use horizontal shelves with up to ten rows initially, combining TMDB shelves with normalized provider categories. Each shelf fetches 20 items per page and loads another page when scrolled near its end. Live TV keeps its existing category and listing flow.
- TMDB authentication accepts either a v3 API key or a v4 Read Access Token. The server attempts bearer authentication first and falls back to v3 query authentication only when TMDB rejects the bearer credential; it remembers the working mode for the current token.
- The server stores stream IDs and metadata, never media files. Playback resolution returns a provider URL to the authenticated TV. The TV streams directly from the provider.
- The imported `sc_*` catalog is the read source when present. It separates canonical titles, localized translations, provider streams, episode relationships, categories, genres, and keywords. The original `streams` import table remains an untouched source archive.
- TMDB title details are fetched only when a movie or series detail is opened. A season endpoint is fetched only when that season is opened; its localized episode descriptions are stored per episode and language. PostgreSQL cache rows prevent repeated requests, and the server respects TMDB `429` responses.

## Client

- Standalone `com.streamcinema.iptv` webOS web app. A single Chrome 53-targeted package is intended for Nano and C9, but only compilation has been verified.
- The client keeps its same-origin server URL, opaque device-bound session token, device ID, and selected profile ID locally. A separate NightOwl username/password authenticates the website; Xtream provider credentials are configured separately in Settings and encrypted on the server. Profiles, favorites, and progress are scoped by device ID. It fetches one home payload and 20-item catalog pages on demand. Artwork is lazy-loaded.
- D-pad and Magic Remote pointer interactions use ordinary focusable buttons. Back closes playback, then details, then returns Home. The client saves progress centrally every 15 seconds and on exit.
- TMDB metadata is attributed in Settings. Configure the access token from Settings; the server encrypts it in PostgreSQL using `CREDENTIAL_KEY`. Do not run a bulk metadata pull.
- Playback uses the HTML video element, with available native text/audio tracks. Stream format and codec support require device testing.

## Security and current limitation

API requests require a bearer token and device ID except health, account status, and login. Initial account setup additionally requires the server API token; the public sign-in page never creates accounts. The first account is created once; subsequent logins use a salted scrypt password hash. Sign-in does not synchronize catalog data or validate Xtream credentials. Session tokens are random, stored only as SHA-256 hashes, bound to the device ID, and extended for 30 days while active. Fastify redacts the Authorization header, and stream URLs are never logged by application code. The API and database are not automatically exposed to the internet. The provided Compose file binds the API to loopback until a LAN address is deliberately configured.

Direct Xtream playback embeds provider credentials in the URL delivered to the TV. A nominal short-lived API response cannot revoke a provider URL, so this implementation does **not** claim short-lived playback access. Hiding those credentials would require a video proxy or provider-issued temporary tokens. The TV token is also stored in app-local storage and would traverse HTTP if the LAN API is configured without TLS. Internal TLS and physical-TV trust compatibility should be resolved before production deployment.
