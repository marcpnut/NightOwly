# REST API

Base path: `/api/v1`. Except `GET /health`, `GET /auth/status`, and `POST /auth/login`, send `Authorization: Bearer <session token>` and `X-Device-Id: <TV UUID>`. Initial account setup additionally requires `Authorization: Bearer <API_TOKEN>` from the protected server environment. Sessions are bound to a device and slide for 30 days while in use. Profiles and their data are scoped to that device ID. Responses use JSON. Validation failures use `400` with `{ "error": { "code", "message", "details" } }`. Unauthorized requests use `401`. Catalog pages are capped at 20.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Database-backed health check |
| GET | `/auth/status` | Report whether the one-time NightOwl account setup is complete |
| POST | `/auth/setup` | Admin-only: create the initial NightOwl account and issue a device-bound app session |
| POST | `/auth/login` | Verify NightOwl account credentials and issue a device-bound app session |
| GET | `/home?profileId=<uuid>` | Featured title and small home rows |
| GET | `/tmdb/artwork-status` | Progress for the low-rate, landscape-artwork-only TMDB backfill |
| GET | `/movies?page=1&limit=20&category=<id>` | Paged movies |
| GET | `/movies/categories` | Canonical movie categories; `id` is the category filter ID and each item includes `type` and `itemCount` |
| GET | `/movies/:id?language=en` | Movie details with localized metadata and available streams; `:id` is a provider stream ID |
| GET | `/movies/:id/streams` | Canonical movie and its provider streams grouped by detected language and categories; `:id` is a provider movie stream ID |
| GET | `/series?page=1&limit=20&category=<id>` | Paged series |
| GET | `/series/categories` | Canonical series categories; `id` is the category filter ID and each item includes `type` and `itemCount` |
| GET | `/series/:id?language=en` | Series details with localized metadata; `:id` is a provider stream ID |
| GET | `/series/:id/seasons` | Season numbers and episode counts |
| GET | `/series/:id/seasons/:season/episodes?page=1&limit=20&language=en` | Paged episodes; requests and caches TMDB episode descriptions the first time that season is opened |
| GET | `/live?page=1&limit=20&category=<id>` | Paged live channels |
| GET | `/live/categories` | Original provider Live TV categories, unchanged |
| GET | `/search?q=<text>&page=1&limit=20` | Search movies and series |
| GET/POST | `/profiles` | List/create profiles |
| GET | `/profiles/:id/continue-watching` | Recent unfinished items |
| GET/POST | `/profiles/:id/my-list` | List/update favorites |
| POST | `/profiles/:id/progress` | Save watch position |
| POST | `/playback/resolve` | Resolve `{kind,id,format?}` to direct stream URL |
| GET | `/sync/status` | Last sync attempt, success, cursor, and count |
| POST | `/provider/connect` | Save encrypted provider credentials without checking the provider or starting a catalog import |
| POST | `/provider/sync` | Disabled for client use; catalog refresh belongs to a server background job |
| GET | `/tmdb/status` | Whether the server has TMDB application credentials configured |
| POST | `/tmdb/config` | Set `{ "token": "..." }` or clear with an empty token; encrypted at rest using `CREDENTIAL_KEY` |

Example progress body: `{ "kind": "movie", "id": "55", "positionSeconds": 120, "durationSeconds": 5400, "completed": false }`.

Example favorite body: `{ "kind": "movie", "id": "55", "saved": true }`.

When the normalized catalog is available, detail requests fetch TMDB metadata only on first open. Movie/series details request translations, keywords, genres, and videos together, then cache them in PostgreSQL. Opening a season requests that season's localized episode list and stores descriptions by episode and language. Repeated opens use cached rows; `429` responses are respected and delayed for a later open. A token entered in Settings is encrypted in `sc_tmdb_settings` using `CREDENTIAL_KEY`. Without a configured TMDB token, the API returns the imported provider metadata.

The playback response contains a credential-bearing provider URL and must never be cached, shared, or included in diagnostics. For normalized streams, `/playback/resolve` uses a saved resolved-source URL first when present, otherwise it builds the provider URL from server-side credentials.

The streams endpoint reads only the local database. It does not contact Xtream. Each stream response exposes its provider stream ID, extension, detected language labels, and category names; playback credentials remain server-side until `/playback/resolve` builds the direct provider URL.

Saving provider credentials does not contact Xtream. In the normalized-catalog deployment, the existing PostgreSQL catalog remains the source of browsing data; a separate server-managed background job is required for future provider refreshes.

Movie and series categories are served from the additive `sc_browse_categories` layer. Category filters use those canonical IDs and match all mapped provider category aliases. The original `sc_categories` and `sc_stream_categories` rows remain available for auditing. The Live TV endpoints continue using the original provider category IDs and names; they are not mapped into the movie/series taxonomy.

Wide movie/show shelves use `sc_titles.backdrop_url`; portrait artwork remains in `poster_url` and localized poster fields. A server background worker fills missing backdrops only for titles with a known TMDB ID, at one request per second. It does not fetch episode artwork or descriptions. Check `/tmdb/artwork-status` to see pending, completed, unavailable, retrying, and unmatched counts.

The setup and login request body is `{ "username": "...", "password": "..." }`; send a UUID in `X-Device-Id`. Setup requires the server API token and is allowed only until the first account is created; the public client has no account creation flow. NightOwl passwords are stored as salted scrypt hashes. Xtream credentials are configured separately in Settings and encrypted at rest. Account login does not request catalog lists or trigger a catalog sync. The returned opaque session token is stored only as a hash in `sc_client_sessions`; the browser stores the token for subsequent API requests.

OpenSubtitles integration uses the current REST API at `api.opensubtitles.com`. Configure the API key in Settings; it is encrypted in `sc_opensubtitles_settings` with `CREDENTIAL_KEY`. `POST /opensubtitles/search` accepts a movie or episode, title/TMDB ID, language code, and season/episode numbers. `POST /opensubtitles/download` accepts a search-result file ID and returns WebVTT for playback. OpenSubtitles account login is not configured yet, so downloads use its anonymous allowance; authenticated downloads require additional account credentials and are a later extension.
