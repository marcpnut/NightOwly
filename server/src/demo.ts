import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mapCatalogItem, mapEpisodes, playbackUrl, providerPlaybackInfo, requestProvider, type CatalogRecord, type ProviderCredentials } from './provider.js';
import { curatedHome, hasTmdbToken, setTmdbToken, type HomeMedia } from './tmdb.js';

type Item = { kind: 'movie' | 'series' | 'live' | 'episode'; id: string; title: string; description: string;
  genre?: string; releaseYear?: number; rating?: number; seasonNumber?: number; episodeNumber?: number;
  posterUrl?: string; backdropUrl?: string; positionSeconds?: number; durationSeconds?: number; categoryId?: string;
  streamExtension?: string; parentId?: string; metadata?: Record<string, unknown> };
type Profile = { id: string; name: string; deviceId: string };
const movieTitles = ['The Quiet Signal', 'Northern Light', 'The Last Station', 'Deep Blue Hour', 'A City at Dawn',
  'Across the Valley', 'Before Tomorrow', 'Paper Skies', 'The Hidden Road', 'Winter Current', 'Parallel Days', 'Open Water',
  'Golden Echo', 'After the Rain', 'Silent Orbit', 'The Far Shore', 'Second Horizon', 'A Thousand Steps', 'Night Passage',
  'The Long Summer', 'The Seventh Door', 'Under the Pines', 'The Glass Bridge', 'Morning Tide'];
const seriesTitles = ['The Long Route', 'Beneath the Surface', 'Northbound', 'Small Worlds', 'The District', 'Memory Lane',
  'Beyond the Line', 'Wild Earth', 'The Archives', 'Harbor Lights', 'Last Call', 'Another Season'];
const channels = ['World News', 'Cinema One', 'Nature Live', 'City Sports', 'The Music Room', 'Travel Now'];
const movieGenres = ['Drama', 'Adventure', 'Mystery', 'Science Fiction'];
const colors = ['#b51d31', '#e65d2f', '#2d6f8e', '#6d469e', '#287f70', '#c18b29', '#555c88', '#8a4f55'];
const synopses: Record<string, string> = {
  'The Quiet Signal': 'When a vanished radio transmission returns after twenty years, a city engineer follows its trail into a mystery that could change everything she remembers.',
  'A City at Dawn': 'At sunrise, a stranger arrives in the city with one night to find the family she has never known.',
  'Across the Valley': 'Two old friends cross an unforgiving mountain range to keep a promise made long ago.',
  'Before Tomorrow': 'A late-night drive along the coast becomes a race against time when the past starts to catch up.'
};
const art = (id: string, wide = false) => `/demo-art/${id}${wide ? '?wide=1&v=2' : '?v=2'}`;
const movies: Item[] = movieTitles.map((title, index) => ({ kind: 'movie', id: String(1001 + index), title,
  description: synopses[title] || `An original fictional ${movieGenres[index % movieGenres.length].toLowerCase()} story from the local sample catalog.`,
  genre: movieGenres[index % movieGenres.length], releaseYear: 2025 - (index % 8), rating: 8.5 - (index % 6) * .3,
  posterUrl: art(String(1001 + index)), backdropUrl: art(String(1001 + index), true) }));
const series: Item[] = seriesTitles.map((title, index) => ({ kind: 'series', id: String(2001 + index), title,
  description: `A fictional episodic series created for the local StreamCinema demo.`, genre: movieGenres[index % movieGenres.length],
  releaseYear: 2024 - (index % 6), rating: 8.6 - (index % 5) * .3,
  posterUrl: art(String(2001 + index)), backdropUrl: art(String(2001 + index), true) }));
const live: Item[] = channels.map((title, index) => ({ kind: 'live', id: String(3001 + index), title,
  description: 'Fictional live channel for testing navigation.', posterUrl: art(String(3001 + index)), backdropUrl: art(String(3001 + index), true) }));
const episodes: Item[] = series.flatMap((show) => Array.from({ length: 7 }, (_, index) => ({ kind: 'episode' as const,
  id: String(Number(show.id) * 100 + index + 1), title: `Episode ${index + 1}: ${['Arrival', 'The Crossing', 'Signs', 'After Dark', 'The Choice', 'Turning Point', 'Homecoming'][index]}`,
  description: `Season 1 of ${show.title}. Fictional episode for local testing.`, seasonNumber: 1, episodeNumber: index + 1,
  posterUrl: art(show.id) })));
const all = movies.concat(series, live, episodes);
let movieCatalog: Item[] = movies;
let seriesCatalog: Item[] = series;
let liveCatalog: Item[] = live;
let episodeCatalog: Item[] = episodes;
let categories: Array<{ id: string; name: string; kind: 'movie' | 'series' | 'live' }> = [];
let provider: ProviderCredentials | null = null;
let providerState: { status: string; lastSuccessAt?: string; lastError?: string; rowCount?: number } = { status: 'demo' };
let syncRunning = false;
const asItem = (record: CatalogRecord): Item => ({ ...record, description: record.description || '' });
const providerRecords = async (credentials: ProviderCredentials, action: string): Promise<Record<string, unknown>[]> => {
  const value = await requestProvider(credentials, action);
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];
};
async function syncProviderCatalog(): Promise<void> {
  if (!provider || syncRunning) return;
  syncRunning = true; providerState = { ...providerState, status: 'syncing', lastError: undefined };
  try {
    const credentials = provider;
    const mapped = (kind: 'live' | 'movie' | 'series', entries: Record<string, unknown>[]) => {
      const unique = new Map<string, Item>();
      for (const entry of entries) {
        const item = mapCatalogItem(kind, entry);
        if (item && !unique.has(item.id)) unique.set(item.id, asItem(item));
      }
      return Array.from(unique.values());
    };
    const categoryRecords = (kind: 'live' | 'movie' | 'series', entries: Record<string, unknown>[]) => entries
      .filter((entry) => entry.category_id !== undefined && entry.category_id !== null)
      .map((entry) => ({ id: String(entry.category_id), name: String(entry.category_name || entry.name || (kind === 'live' ? 'Live' : kind === 'movie' ? 'Movies' : 'Shows')), kind }));
    const liveGroups = await providerRecords(credentials, 'get_live_categories');
    const liveStreams = await providerRecords(credentials, 'get_live_streams');
    liveCatalog = mapped('live', liveStreams);
    categories = categoryRecords('live', liveGroups);
    const movieGroups = await providerRecords(credentials, 'get_vod_categories');
    const movieStreams = await providerRecords(credentials, 'get_vod_streams');
    movieCatalog = mapped('movie', movieStreams);
    categories = categories.concat(categoryRecords('movie', movieGroups));
    const seriesGroups = await providerRecords(credentials, 'get_series_categories');
    const seriesStreams = await providerRecords(credentials, 'get_series');
    seriesCatalog = mapped('series', seriesStreams);
    categories = categories.concat(categoryRecords('series', seriesGroups));
    if (!liveCatalog.length && !movieCatalog.length && !seriesCatalog.length) throw new Error('Provider returned no catalog items. Check account access and provider response.');
    const info = providerPlaybackInfo(credentials, await requestProvider(credentials, ''));
    provider = { ...credentials, ...info };
    episodeCatalog = [];
    providerState = { status: 'success', lastSuccessAt: new Date().toISOString(), rowCount: liveCatalog.length + movieCatalog.length + seriesCatalog.length };
  } catch (error) {
    providerState = { ...providerState, status: 'error', lastError: error instanceof Error ? error.message.slice(0, 160) : 'Catalog sync failed.' };
  } finally { syncRunning = false; }
}
const profiles: Profile[] = [];
const favorites = new Set<string>();
const progress = new Map<string, { kind: string; id: string; positionSeconds: number; durationSeconds?: number; completed: boolean; updatedAt: number }>();
const profileKey = (profileId: string, kind: string, id: string) => `${profileId}:${kind}:${id}`;
const page = (items: Item[], query: Record<string, unknown>) => {
  const number = Math.max(1, Number(query.page) || 1), limit = Math.min(20, Math.max(1, Number(query.limit) || 20));
  const offset = (number - 1) * limit;
  return { items: items.slice(offset, offset + limit), page: number, limit, hasMore: items.length > offset + limit };
};
const xml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] || character);

export function createDemoServer() {
  const app = Fastify({ logger: false });
  const dist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
  const file = (name: string) => readFile(fileURLToPath(new URL(name, `file:///${dist.replace(/\\/g, '/')}/`)));
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await file('index.html')));
  app.get('/assets/app.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(await file('assets/app.js')));
  app.get('/icon.png', async (_request, reply) => reply.type('image/png').send(await file('icon.png')));
  app.get('/demo-video', async (request, reply) => {
    const bytes = await readFile(new URL('../../demo-assets/flower.mp4', import.meta.url));
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    reply.header('Accept-Ranges', 'bytes').type('video/mp4');
    if (!match) return reply.header('Content-Length', bytes.length).send(bytes);
    const start = Number(match[1]);
    const end = Math.min(bytes.length - 1, match[2] ? Number(match[2]) : bytes.length - 1);
    if (start >= bytes.length || end < start) return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
      .header('Content-Length', end - start + 1).send(bytes.subarray(start, end + 1));
  });
  app.get('/demo-art/:id', async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    const item = all.find((entry) => entry.id === id);
    if (!item) return reply.code(404).send();
    const wide = (request.query as { wide?: string }).wide === '1';
    const photo = ({ '1001': 'quiet-signal.png', '1005': 'city-at-dawn.png',
      '1006': 'across-valley.png', '1007': 'before-tomorrow.png' } as Record<string, string>)[id];
    if (photo && wide) return reply.type('image/png').header('Cache-Control', 'public,max-age=3600')
      .send(await readFile(new URL(`../../demo-assets/${photo}`, import.meta.url)));
    const width = wide ? 1000 : 350, height = wide ? 570 : 500;
    const color = colors[Number(id) % colors.length];
    const title = xml(item.title);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#101013"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${wide ? 740 : 240}" cy="130" r="180" fill="#ffffff" opacity=".10"/><circle cx="${wide ? 700 : 200}" cy="310" r="270" fill="#000000" opacity=".15"/><path d="M0 ${height * .58} Q${width * .5} ${height * .15} ${width} ${height * .75} V${height} H0Z" fill="#000000" opacity=".28"/><text x="${wide ? 60 : 25}" y="${height - 100}" fill="white" font-family="Arial,sans-serif" font-size="${wide ? 62 : 39}" font-weight="bold">${title}</text><text x="${wide ? 60 : 25}" y="${height - 48}" fill="#eeeeee" font-family="Arial,sans-serif" font-size="${wide ? 22 : 18}">STREAMCINEMA ORIGINAL DEMO</text></svg>`;
    return reply.type('image/svg+xml').header('Cache-Control', 'public,max-age=3600').send(svg);
  });
  app.get('/api/v1/health', async () => ({ status: 'ok', mode: 'local-demo' }));
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') || request.url === '/api/v1/health') return;
    if (request.headers.authorization !== 'Bearer local-demo-only' || typeof request.headers['x-device-id'] !== 'string') {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Local demo access required.' } });
    }
  });
  const device = (request: { headers: Record<string, unknown> }) => String(request.headers['x-device-id']);
  const ownedProfile = (request: { headers: Record<string, unknown> }, id: string) => profiles.find((entry) => entry.id === id && entry.deviceId === device(request));
  app.get('/api/v1/debug/database', async (request) => {
    const query = request.query as { q?: string; kind?: string; page?: string; limit?: string };
    const q = String(query.q || '').trim().toLocaleLowerCase();
    const allowedKinds = new Set(['movie', 'series', 'live', 'episode']);
    const kind = allowedKinds.has(String(query.kind)) ? String(query.kind) : '';
    const pageNumber = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const allItems = movieCatalog.concat(seriesCatalog, liveCatalog, episodeCatalog);
    const filtered = allItems.filter((item) => (!kind || item.kind === kind)
      && (!q || `${item.title} ${item.description} ${item.id} ${item.categoryId || ''}`.toLocaleLowerCase().includes(q)));
    const counts = {
      movie: movieCatalog.length, series: seriesCatalog.length, live: liveCatalog.length,
      episode: episodeCatalog.length, categories: categories.length
    };
    return {
      backingStore: 'in-memory local demo server', providerStatus: providerState.status,
      counts, page: pageNumber, limit, total: filtered.length,
      items: filtered.slice((pageNumber - 1) * limit, pageNumber * limit).map(({ kind: itemKind, id, title, categoryId, genre, releaseYear, posterUrl }) =>
        ({ kind: itemKind, id, title, categoryId, genre, releaseYear, hasArtwork: !!posterUrl })),
      schema: [
        { table: 'provider_config', purpose: 'Encrypted Xtream connection settings', primaryKey: 'id', fields: ['base_url', 'playback_base_url', 'allowed_live_formats', 'username_cipher', 'password_cipher', 'updated_at'] },
        { table: 'categories', purpose: 'Provider categories by content type', primaryKey: 'kind, id', fields: ['kind', 'id', 'name', 'active', 'last_seen_at'] },
        { table: 'catalog', purpose: 'Movies, series, live channels, and episodes', primaryKey: 'kind, id', fields: ['kind', 'id', 'parent_id', 'season_number', 'episode_number', 'category_id', 'title', 'description', 'poster_url', 'backdrop_url', 'genre', 'release_year', 'duration_seconds', 'rating', 'added_at', 'stream_extension', 'metadata', 'detail_synced_at', 'active', 'last_seen_at'] },
        { table: 'profiles', purpose: 'Per-device viewer profiles and preferences', primaryKey: 'id', fields: ['id', 'device_id', 'name', 'preferences', 'created_at'] },
        { table: 'my_list', purpose: 'Saved titles per profile', primaryKey: 'profile_id, kind, catalog_id', fields: ['profile_id', 'kind', 'catalog_id', 'created_at'] },
        { table: 'watch_progress', purpose: 'Resume position and completion state', primaryKey: 'profile_id, kind, catalog_id', fields: ['profile_id', 'kind', 'catalog_id', 'position_seconds', 'duration_seconds', 'completed', 'updated_at'] },
        { table: 'sync_state', purpose: 'Per-dataset sync status and checkpoints', primaryKey: 'dataset', fields: ['dataset', 'status', 'cursor', 'last_attempt_at', 'last_success_at', 'last_error', 'row_count'] }
      ]
    };
  });
  app.post('/api/v1/provider/connect', async (request, reply) => {
    const body = request.body as { baseUrl?: string; username?: string; password?: string };
    if (!body?.baseUrl || !body.username || !body.password) return reply.code(400).send({ error: { message: 'Server URL, username, and password are required.' } });
    let baseUrl: string;
    try {
      const url = new URL(body.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      baseUrl = url.origin + url.pathname.replace(/\/+$/, '');
    } catch { return reply.code(400).send({ error: { message: 'Enter a valid provider URL.' } }); }
    const credentials = { baseUrl, username: body.username.trim(), password: body.password };
    if (!credentials.username || credentials.username.length > 128 || credentials.password.length > 256) return reply.code(400).send({ error: { message: 'Username or password is invalid.' } });
    try {
      const auth = await requestProvider(credentials, '');
      const root = auth && typeof auth === 'object' ? auth as Record<string, unknown> : {};
      const user = root.user_info && typeof root.user_info === 'object' ? root.user_info as Record<string, unknown> : {};
      if (user.auth === 0 || String(user.status || '').toLowerCase() === 'disabled') return reply.code(401).send({ error: { message: 'Provider rejected this login.' } });
      provider = { ...credentials, ...providerPlaybackInfo(credentials, auth) };
      // Do not leave fictional sample titles on screen while the real catalog syncs.
      movieCatalog = []; seriesCatalog = []; liveCatalog = []; episodeCatalog = []; categories = [];
      providerState = { status: 'connected' };
      void syncProviderCatalog();
      return { connected: true, username: credentials.username, status: 'syncing' };
    } catch (error) {
      const code = error instanceof Error && /HTTP 401|HTTP 403/.test(error.message) ? 401 : 502;
      return reply.code(code).send({ error: { message: code === 401 ? 'Provider rejected this login.' : 'Could not reach the provider. Check the URL and network connection.' } });
    }
  });
  app.get('/api/v1/provider/status', async () => ({ configured: !!provider, username: provider?.username, ...providerState }));
  app.get('/api/v1/tmdb/status', async () => ({ configured: hasTmdbToken() }));
  app.post('/api/v1/tmdb/config', async (request, reply) => {
    const token = String((request.body as { token?: unknown })?.token ?? '').trim();
    if (token.length > 4096) return reply.code(400).send({ error: { message: 'TMDB token is too long.' } });
    setTmdbToken(token);
    return { configured: hasTmdbToken() };
  });
  app.post('/api/v1/provider/sync', async (_request, reply) => {
    if (!provider) return reply.code(409).send({ error: { message: 'Connect the provider first.' } });
    if (syncRunning) return { status: 'syncing' };
    void syncProviderCatalog(); return { status: 'syncing' };
  });
  app.get('/api/v1/profiles', async (request) => ({ items: profiles.filter((entry) => entry.deviceId === device(request)).map(({ id, name }) => ({ id, name })) }));
  app.post('/api/v1/profiles', async (request, reply) => {
    const name = String((request.body as { name?: string })?.name || '').trim().slice(0, 24);
    if (!name) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Enter a profile name.' } });
    const profile = { id: randomUUID(), name, deviceId: device(request) }; profiles.push(profile);
    return reply.code(201).send({ id: profile.id, name });
  });
  app.get('/api/v1/home', async (request) => {
    const profileId = String((request.query as { profileId?: string }).profileId || '');
    const activeItems = movieCatalog.concat(seriesCatalog, liveCatalog, episodeCatalog);
    const history = Array.from(progress.entries()).filter(([key, value]) => key.startsWith(`${profileId}:`) && !value.completed)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .map(([, value]) => ({ ...activeItems.find((entry) => entry.id === value.id && entry.kind === value.kind)!, positionSeconds: value.positionSeconds }))
      .filter((item) => item.id && item.kind !== 'live');
    const saved = Array.from(favorites).filter((key) => key.startsWith(`${profileId}:`)).map((key) => {
      const [kind, id] = key.slice(profileId.length + 1).split(':'); return activeItems.find((entry) => entry.kind === kind && entry.id === id);
    }).filter((item): item is Item => !!item);
    const libraryMovies = (provider && providerState.status !== 'demo' ? movieCatalog : movies)
      .filter((item) => item.kind === 'movie').map((item) => ({ ...item, kind: 'movie' as const } satisfies HomeMedia));
    const librarySeries = (provider && providerState.status !== 'demo' ? seriesCatalog : series)
      .filter((item) => item.kind === 'series').map((item) => ({ ...item, kind: 'series' as const } satisfies HomeMedia));
    const discovered = await curatedHome(libraryMovies, librarySeries);
    return { featured: discovered.featured, discoverySource: discovered.source,
      attribution: discovered.source === 'tmdb', rows: [
        { id: 'continue', title: 'Continue Watching', items: history.slice(0, 12) },
        { id: 'my-list', title: 'My List', items: saved.filter((item) => item?.kind === 'movie' || item?.kind === 'series').slice(0, 12) },
        ...discovered.rows
      ].filter((row) => row.items.length) };
  });
  const selected = (items: Item[], query: Record<string, unknown>) => {
    const category = typeof query.category === 'string' ? query.category : '';
    return category ? items.filter((item) => item.categoryId === category) : items;
  };
  app.get('/api/v1/movies', async (request) => page(selected(movieCatalog, request.query as Record<string, unknown>), request.query as Record<string, unknown>));
  app.get('/api/v1/series', async (request) => page(selected(seriesCatalog, request.query as Record<string, unknown>), request.query as Record<string, unknown>));
  app.get('/api/v1/live', async (request) => page(selected(liveCatalog, request.query as Record<string, unknown>), request.query as Record<string, unknown>));
  app.get('/api/v1/movies/:id', async (request, reply) => movieCatalog.find((item) => item.id === (request.params as { id: string }).id) ?? reply.code(404).send({ error: { message: 'Title not found.' } }));
  app.get('/api/v1/series/:id', async (request, reply) => seriesCatalog.find((item) => item.id === (request.params as { id: string }).id) ?? reply.code(404).send({ error: { message: 'Title not found.' } }));
  app.get('/api/v1/series/:id/seasons', async (request) => {
    const id = (request.params as { id: string }).id;
    if (provider && !episodeCatalog.some((item) => item.parentId === id)) {
      try {
        const info = await requestProvider(provider, 'get_series_info', { series_id: id });
        if (info && typeof info === 'object') episodeCatalog.push(...mapEpisodes(id, info as Record<string, unknown>).map(asItem));
      } catch { /* Catalog details remain available without episodes. */ }
    }
    const seasons = new Map<number, number>();
    episodeCatalog.filter((item) => item.parentId === id).forEach((item) => seasons.set(item.seasonNumber || 0, (seasons.get(item.seasonNumber || 0) || 0) + 1));
    return { seasons: Array.from(seasons.entries()).map(([number, count]) => ({ number, count })) };
  });
  app.get('/api/v1/series/:id/seasons/:season/episodes', async (request) => page(episodeCatalog.filter((item) => item.parentId === (request.params as { id: string }).id && String(item.seasonNumber) === String((request.params as { season: string }).season)), request.query as Record<string, unknown>));
  app.get('/api/v1/movies/categories', async () => ({ items: categories.filter((item) => item.kind === 'movie') }));
  app.get('/api/v1/series/categories', async () => ({ items: categories.filter((item) => item.kind === 'series') }));
  app.get('/api/v1/live/categories', async () => ({ items: categories.filter((item) => item.kind === 'live') }));
  app.get('/api/v1/search', async (request) => {
    const q = String((request.query as { q?: string }).q || '').toLowerCase();
    return { movies: movieCatalog.filter((item) => item.title.toLowerCase().includes(q)).slice(0, 10),
      series: seriesCatalog.filter((item) => item.title.toLowerCase().includes(q)).slice(0, 10), page: 1 };
  });
  app.get('/api/v1/profiles/:id/my-list', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!ownedProfile(request, id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    return { items: Array.from(favorites).filter((key) => key.startsWith(`${id}:`)).map((key) => {
      const [kind, itemId] = key.slice(id.length + 1).split(':'); return movieCatalog.concat(seriesCatalog, liveCatalog, episodeCatalog).find((item) => item.kind === kind && item.id === itemId);
    }).filter(Boolean) };
  });
  app.post('/api/v1/profiles/:id/my-list', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!ownedProfile(request, id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const body = request.body as { kind: string; id: string; saved: boolean };
    const key = profileKey(id, body.kind, body.id);
    if (body.saved) favorites.add(key); else favorites.delete(key);
    return { saved: body.saved };
  });
  app.get('/api/v1/profiles/:id/continue-watching', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!ownedProfile(request, id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    return { items: Array.from(progress.entries()).filter(([key, value]) => key.startsWith(`${id}:`) && !value.completed)
      .map(([, value]) => value).slice(0, 20) };
  });
  app.post('/api/v1/profiles/:id/progress', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!ownedProfile(request, id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const body = request.body as { kind: string; id: string; positionSeconds: number; durationSeconds?: number; completed: boolean };
    progress.set(profileKey(id, body.kind, body.id), { ...body, updatedAt: Date.now() });
    return { saved: true };
  });
  app.post('/api/v1/playback/resolve', async (request, reply) => {
    const body = request.body as { kind: 'live' | 'movie' | 'episode'; id: string; format?: 'm3u8' | 'ts' };
    if (provider) {
      const item = movieCatalog.concat(seriesCatalog, liveCatalog, episodeCatalog).find((entry) => entry.kind === body.kind && entry.id === body.id);
      if (!item) return reply.code(404).send({ error: { message: 'Stream not found.' } });
      return { url: playbackUrl(provider, item, body.format), format: body.format || item.streamExtension || 'm3u8' };
    }
    return { url: 'http://127.0.0.1:8080/demo-video', format: 'mp4' };
  });
  app.get('/api/v1/sync/status', async () => ({ datasets: provider ? [
    { dataset: 'catalog', status: providerState.status, rowCount: providerState.rowCount, lastSuccessAt: providerState.lastSuccessAt, lastError: providerState.lastError }
  ] : [
    { dataset: 'movie', status: 'demo', rowCount: movies.length }, { dataset: 'series', status: 'demo', rowCount: series.length },
    { dataset: 'live', status: 'demo', rowCount: live.length }, { dataset: 'episodes', status: 'demo', rowCount: episodes.length }
  ] }));
  return app;
}
