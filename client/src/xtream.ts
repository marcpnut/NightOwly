export type XtreamCredentials = { baseUrl: string; username: string; password: string };
type RecordValue = Record<string, unknown>;
type Section = 'movies' | 'series' | 'live';
type AppItem = {
  kind: 'movie' | 'series' | 'live' | 'episode'; id: string; title: string; description?: string;
  posterUrl?: string; backdropUrl?: string; genre?: string; releaseYear?: number;
  durationSeconds?: number; rating?: number; streamId?: string; seriesId?: string; seriesTitle?: string;
  positionSeconds?: number;
  seasonNumber?: number; episodeNumber?: number; canonicalId?: string; streams?: Array<{ id: string; providerId: string; extension?: string; language?: string; languageCode?: string }>;
  streamExtension?: string;
};

const sectionCache: Record<Section, Map<string, AppItem[]>> = {
  movies: new Map(), series: new Map(), live: new Map()
};
const rawCache = new Map<string, RecordValue>();
const episodeExtensions = new Map<string, string>();
let credentials: XtreamCredentials | null = null;
let profileId = 'local';
const memoryStorage = new Map<string, string>();
const getStorage = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return memoryStorage.get(key) ?? null; } };
const setStorage = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { memoryStorage.set(key, value); } };
const removeStorage = (key: string): void => { try { localStorage.removeItem(key); } catch { memoryStorage.delete(key); } };
const idString = (value: unknown): string => value == null ? '' : String(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : undefined; };
const readArray = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter((entry): entry is RecordValue => !!entry && typeof entry === 'object') : [];

function apiUrl(path: string): URL {
  if (!credentials) throw new Error('Enter your Xtream provider details to connect.');
  const base = credentials.baseUrl.replace(/\/+$/, '');
  const endpoint = /\/player_api\.php$/i.test(base) ? base : `${base}/player_api.php`;
  return new URL(endpoint);
}
async function request(action?: string, params: Record<string, string> = {}): Promise<unknown> {
  if (!credentials) throw new Error('Enter your Xtream provider details to connect.');
  const url = apiUrl(credentials.baseUrl);
  url.searchParams.set('username', credentials.username);
  url.searchParams.set('password', credentials.password);
  if (action) url.searchParams.set('action', action);
  Object.keys(params).forEach((key) => url.searchParams.set(key, params[key]));
  let response: Response;
  try { response = await fetch(url.toString(), { cache: 'no-store' }); }
  catch { throw new Error('Could not reach the Xtream provider. Check the server URL and whether the provider allows direct app connections.'); }
  if (!response.ok) throw new Error(`Xtream provider returned HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const userInfo = (payload as RecordValue).user_info as RecordValue | undefined;
    if (userInfo && (String(userInfo.auth) === '0' || text(userInfo.status).toLowerCase() === 'disabled')) throw new Error('The Xtream username or password is incorrect or inactive.');
  }
  return payload;
}
export async function loginXtream(input: XtreamCredentials): Promise<void> {
  const normalized = { ...input, baseUrl: input.baseUrl.trim().replace(/\/+$/, '') };
  if (!normalized.baseUrl || !normalized.username || !normalized.password) throw new Error('Enter your provider URL, username, and password.');
  try { new URL(normalized.baseUrl); } catch { throw new Error('Enter a valid provider URL, including http:// or https://.'); }
  const previous = credentials;
  credentials = normalized;
  try {
    const result = await request() as RecordValue;
    if (!result?.user_info || String((result.user_info as RecordValue).auth) !== '1') throw new Error('The provider did not accept these Xtream credentials.');
  } catch (error) { credentials = previous; throw error; }
}
export function setXtreamCredentials(input: XtreamCredentials): void { credentials = input; }
export function clearXtreamCache(): void {
  [sectionCache.movies, sectionCache.series, sectionCache.live].forEach((cache) => cache.clear()); rawCache.clear(); episodeExtensions.clear();
}
export function currentXtreamCredentials(): XtreamCredentials | null { return credentials; }
function categoryAction(section: Section): string { return section === 'movies' ? 'get_vod_categories' : section === 'series' ? 'get_series_categories' : 'get_live_categories'; }
function streamAction(section: Section): string { return section === 'movies' ? 'get_vod_streams' : section === 'series' ? 'get_series' : 'get_live_streams'; }
function inferredLanguages(names: string[]): Array<{ code: string; name: string }> {
  const available = new Set<string>();
  names.forEach((name) => {
    const match = name.match(/^\s*([A-Z]{2,3})\s*[|:]/i);
    if (!match) return;
    const code = match[1].toUpperCase();
    if (['NL', 'BE'].includes(code)) available.add('nl');
    if (code === 'PL') available.add('pl');
    if (['EN', 'UK', 'US', 'USA', 'IR', 'IE', 'GB'].includes(code)) available.add('en');
  });
  if (!available.size) available.add('en');
  return ['en', 'nl', 'pl'].filter((code) => available.has(code)).map((code) => ({
    code, name: code === 'en' ? 'English' : code === 'nl' ? 'Dutch' : 'Polish'
  }));
}
function categoryRecords(section: Section): Promise<RecordValue[]> {
  const key = `categories:${section}`;
  if (!rawCache.has(key)) rawCache.set(key, { promise: request(categoryAction(section)) } as unknown as RecordValue);
  const cached = rawCache.get(key) as unknown as { promise?: Promise<unknown>; value?: RecordValue[] };
  return cached.value ? Promise.resolve(cached.value) : cached.promise!.then((value) => {
    cached.value = readArray(value); return cached.value;
  });
}
function convertItem(section: Section, row: RecordValue): AppItem {
  const movie = section === 'movies', live = section === 'live';
  const id = idString(row.stream_id ?? row.series_id ?? row.id);
  const extension = text(row.container_extension) || (live ? 'm3u8' : 'mp4');
  const poster = text(row.stream_icon ?? row.cover ?? row.cover_big ?? row.movie_image);
  const title = text(row.name ?? row.title) || `Stream ${id}`;
  const year = number(row.year) ?? (() => { const found = title.match(/\b(19|20)\d{2}\b/); return found ? Number(found[0]) : undefined; })();
  const stream: NonNullable<AppItem['streams']>[number] = { id, providerId: id, extension };
  return {
    kind: live ? 'live' : movie ? 'movie' : 'series', id, streamId: id, title,
    description: text(row.plot ?? row.description), posterUrl: poster || undefined,
    backdropUrl: text(row.backdrop_path) || undefined, genre: text(row.genre), releaseYear: year,
    durationSeconds: number(row.duration_secs) ?? (number(row.duration) ? Number(row.duration) * 60 : undefined),
    rating: number(row.rating), streams: [stream], streamExtension: extension
  };
}
async function getSectionItems(section: Section, category = ''): Promise<AppItem[]> {
  const key = category || '*';
  const cache = sectionCache[section];
  const old = cache.get(key); if (old) return old;
  const response = await request(streamAction(section), category ? { category_id: category } : {});
  const items = readArray(response).map((record) => convertItem(section, record));
  cache.set(key, items); return items;
}
async function itemsAcrossCategories(section: Section, categories: RecordValue[]): Promise<AppItem[]> {
  const results: AppItem[][] = new Array(categories.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < categories.length) {
      const index = next++;
      results[index] = await getSectionItems(section, idString(categories[index].category_id));
    }
  };
  const workerCount = Math.min(4, categories.length);
  const workers: Promise<void>[] = [];
  for (let index = 0; index < workerCount; index += 1) workers.push(worker());
  await Promise.all(workers);
  return results.reduce((all, items) => all.concat(items || []), [] as AppItem[]);
}
function paged(items: AppItem[], path: string): { items: AppItem[]; hasMore: boolean } {
  const query = new URLSearchParams(path.split('?')[1] || '');
  const page = Math.max(1, Number(query.get('page') || 1));
  const limit = Math.max(1, Math.min(100, Number(query.get('limit') || 20)));
  const start = (page - 1) * limit;
  return { items: items.slice(start, start + limit), hasMore: start + limit < items.length };
}
function localRows(key: string): AppItem[] {
  try { const result = JSON.parse(getStorage(`nightowly.${key}`) || '[]') as unknown; return Array.isArray(result) ? result as AppItem[] : []; }
  catch { return []; }
}
function saveLocalRows(key: string, rows: AppItem[]): void { setStorage(`nightowly.${key}`, JSON.stringify(rows)); }
function providerStreamUrl(kind: string, id: string, extension?: string): string {
  if (!credentials) throw new Error('Sign in to the Xtream provider first.');
  const segment = kind === 'live' ? 'live' : kind === 'episode' || kind === 'series' ? 'series' : 'movie';
  const ext = kind === 'live' ? (extension === 'ts' ? 'ts' : 'm3u8') : (extension || 'mp4').replace(/^\./, '');
  const base = credentials.baseUrl.replace(/\/player_api\.php$/i, '').replace(/\/+$/, '');
  const root = new URL(base);
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = `${prefix}/${segment}/${encodeURIComponent(credentials.username)}/${encodeURIComponent(credentials.password)}/${encodeURIComponent(id)}.${ext}`;
  root.search = ''; return root.toString();
}
async function seriesInfo(id: string): Promise<RecordValue> {
  const key = `seriesInfo:${id}`;
  const cached = rawCache.get(key) as unknown as { promise?: Promise<unknown>; value?: RecordValue } | undefined;
  if (cached?.value) return cached.value;
  if (cached?.promise) return cached.promise as Promise<RecordValue>;
  const entry: { promise?: Promise<unknown>; value?: RecordValue } = { promise: request('get_series_info', { series_id: id }).then((v) => v as RecordValue) };
  rawCache.set(key, entry as unknown as RecordValue);
  entry.value = await entry.promise as RecordValue; return entry.value;
}
function itemFromEpisode(row: RecordValue, seriesId: string, seriesTitle: string, season: number): AppItem {
  const id = idString(row.id ?? row.episode_id);
  const extension = text(row.container_extension) || 'mp4';
  episodeExtensions.set(id, extension);
  const episodeNumber = number(row.episode_num);
  const title = text(row.title) || `Episode ${episodeNumber ?? ''}`;
  return { kind: 'episode', id, streamId: id, title, seriesId, seriesTitle, seasonNumber: season,
    episodeNumber, description: text((row.info as RecordValue | undefined)?.plot),
    streams: [{ id, providerId: id, extension }], streamExtension: extension };
}

export async function xtreamApi(path: string, body?: unknown): Promise<unknown> {
  const [route, queryString = ''] = path.split('?');
  const q = new URLSearchParams(queryString); const parts = route.split('/').filter(Boolean);
  const json = body && typeof body === 'object' ? body as RecordValue : {};
  if (route === '/health') return { status: 'ok' };
  if (route === '/languages') {
    const categories = await Promise.all([categoryRecords('movies'), categoryRecords('series'), categoryRecords('live')]);
    const names = categories.reduce((all, rows) => all.concat(rows.map((entry) => text(entry.category_name))), [] as string[]);
    return { items: inferredLanguages(names) };
  }
  if (route === '/provider/status') return { configured: Boolean(credentials), status: 'success' };
  if (route === '/provider/connect') {
    const next = { baseUrl: text(json.baseUrl), username: text(json.username), password: text(json.password) };
    await loginXtream(next); setStorage('nightowly.xtream', JSON.stringify(next)); clearXtreamCache();
    return { connected: true, catalogSyncStarted: false };
  }
  if (route === '/provider/sync') { clearXtreamCache(); return { refresh: { status: 'success', message: 'Provider catalog cache cleared; titles will refresh as you browse.' } }; }
  if (route === '/sync/status') return { source: 'xtream_provider', datasets: [] };
  if (route === '/whats-new') return { rows: [] };
  if (route === '/database/summary') {
    const count = (section: Section): number => Array.from(sectionCache[section].values()).reduce((sum, items) => sum + items.length, 0);
    return { counts: { movies: count('movies'), series: count('series'), liveTv: count('live'), episodes: episodeExtensions.size }, refresh: { status: 'idle', phase: '', processed: 0, total: 0 }, lastRefreshed: null };
  }
  if (route === '/tmdb/status') return { configured: Boolean(getStorage('nightowly.tmdb-key')) };
  if (route === '/tmdb/config') { setStorage('nightowly.tmdb-key', text(json.token)); return { configured: Boolean(text(json.token)) }; }
  if (route === '/opensubtitles/status') return { configured: Boolean(getStorage('nightowly.opensubtitles-key')) };
  if (route === '/opensubtitles/config') { setStorage('nightowly.opensubtitles-key', text(json.apiKey)); return { configured: Boolean(text(json.apiKey)) }; }
  if (route === '/opensubtitles/search') {
    const key = getStorage('nightowly.opensubtitles-key');
    if (!key) throw new Error('Add your OpenSubtitles API key in Settings first.');
    const url = new URL('https://api.opensubtitles.com/api/v1/subtitles');
    url.searchParams.set('query', text(json.query));
    url.searchParams.set('languages', text(json.language));
    url.searchParams.set('type', text(json.kind) === 'episode' ? 'episode' : 'movie');
    if (text(json.tmdbId)) url.searchParams.set('tmdb_id', text(json.tmdbId));
    if (number(json.seasonNumber)) url.searchParams.set('season_number', String(json.seasonNumber));
    if (number(json.episodeNumber)) url.searchParams.set('episode_number', String(json.episodeNumber));
    const response = await fetch(url.toString(), { headers: { 'Api-Key': key, 'User-Agent': 'NightOwly v1.0.0' } });
    if (!response.ok) throw new Error(`OpenSubtitles returned HTTP ${response.status}.`);
    const payload = await response.json() as RecordValue;
    const items: Array<{ fileId: number; language: string; release: string; fileName: string; downloadCount: number; hearingImpaired: boolean }> = [];
    readArray(payload.data).forEach((entry) => {
      const attributes = entry.attributes as RecordValue || {};
      readArray(attributes.files).forEach((file) => items.push({ fileId: Number(file.file_id), language: text(attributes.language),
        release: text(attributes.release) || text(file.file_name) || 'Subtitle', fileName: text(file.file_name),
        downloadCount: number(attributes.download_count) || 0, hearingImpaired: Boolean(attributes.hearing_impaired) }));
    });
    const validItems = items.filter((entry) => Number.isFinite(entry.fileId) && entry.fileId > 0);
    return { items: validItems };
  }
  if (route === '/opensubtitles/download') {
    const key = getStorage('nightowly.opensubtitles-key');
    if (!key) throw new Error('Add your OpenSubtitles API key in Settings first.');
    const response = await fetch('https://api.opensubtitles.com/api/v1/download', { method: 'POST',
      headers: { 'Api-Key': key, 'User-Agent': 'NightOwly v1.0.0', 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: Number(json.fileId) }) });
    if (!response.ok) throw new Error(`OpenSubtitles returned HTTP ${response.status}.`);
    const payload = await response.json() as RecordValue;
    const downloadUrl = text(payload.link);
    if (!downloadUrl) throw new Error('OpenSubtitles did not return a subtitle download link.');
    const fileResponse = await fetch(downloadUrl);
    if (!fileResponse.ok) throw new Error(`Subtitle download returned HTTP ${fileResponse.status}.`);
    let vtt = (await fileResponse.text()).replace(/^\uFEFF/, '');
    if (!/^WEBVTT/m.test(vtt.slice(0, 20))) vtt = `WEBVTT\n\n${vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
    return { vtt };
  }
  if (route === '/auth/logout') {
    credentials = null; clearXtreamCache(); removeStorage('nightowly.xtream'); removeStorage('nightowly.config');
    return { success: true };
  }
  if (route === '/profiles') {
    if (body) { profileId = 'local'; return { id: profileId, name: text(json.name) || credentials?.username || 'My Profile' }; }
    return { items: localProfiles() };
  }
  if (parts[0] === 'profiles') {
    if (parts.length === 1 && !body) return { items: localProfiles() };
    if (parts.length === 1 && body) {
      const name = text(json.name).trim() || 'Profile';
      const list = localProfiles(); const next = { id: `profile-${Date.now()}`, name };
      list.push(next); setStorage('nightowly.profiles', JSON.stringify(list)); return next;
    }
    const selectedProfile = parts[1] || profileId;
    const key = parts[2] === 'progress' ? 'progress' : 'my-list';
    const rows = localRows(`${selectedProfile}.${key}`);
    if (body && parts[2] === 'my-list') {
      const itemKey = `${text(json.kind)}:${text(json.id)}`;
      const next = rows.filter((entry) => `${entry.kind}:${entry.id}` !== itemKey);
      if (json.saved) next.push(json as unknown as AppItem);
      saveLocalRows(`${selectedProfile}.${key}`, next); return { saved: Boolean(json.saved) };
    }
    if (body && parts[2] === 'progress') {
      const itemKey = `${text(json.kind)}:${text(json.id)}`;
      const next = rows.filter((entry) => `${entry.kind}:${entry.id}` !== itemKey);
      if (!json.completed) next.push({ ...json, id: text(json.id), kind: text(json.kind) as AppItem['kind'] } as AppItem);
      saveLocalRows(`${selectedProfile}.${key}`, next); return { saved: true };
    }
    if (parts[2] === 'my-list' && rows.length) {
      const resolved: AppItem[] = [];
      for (const entry of rows) {
        try { resolved.push(await detailItem(text(entry.kind), text(entry.id))); } catch { /* Skip titles removed by the provider. */ }
      }
      return { items: resolved };
    }
    return { items: rows };
  }
  if (parts.length === 2 && parts[1] === 'categories') {
    const section = parts[0] as Section;
    const rows = await categoryRecords(section);
    return { items: rows.map((row) => ({ id: idString(row.category_id), name: text(row.category_name) || 'Uncategorized', itemCount: 1, type: 'other' })) };
  }
  if (['movies', 'series', 'live'].includes(parts[0])) {
    const section = parts[0] as Section;
    if (parts.length === 1) {
      const category = q.get('category') || '';
      const rows = await getSectionItems(section, category);
      const search = (q.get('q') || '').toLowerCase().replace(/\s+/g, '');
      const country = q.get('country') || '';
      const filtered = rows.filter((item) => (!search || item.title.toLowerCase().replace(/\s+/g, '').includes(search))
        && (!country || item.title.toUpperCase().startsWith(`${country}|`) || item.title.toUpperCase().startsWith(`${country} `)));
      return paged(filtered, path);
    }
    if (parts.length === 2 && parts[0] === 'movies') {
      return detailItem('movie', parts[1]);
    }
    if (parts.length === 2 && parts[0] === 'series') {
      return detailItem('series', parts[1]);
    }
  }
  if (route === '/home' || route.startsWith('/home?')) {
    profileId = q.get('profileId') || profileId;
    const [movieCats, seriesCats] = await Promise.all([categoryRecords('movies'), categoryRecords('series')]);
    const groups: Array<{ id: string; title: string; items: AppItem[] }> = [];
    const loadTop = async (section: Section, record: RecordValue, title: string): Promise<void> => {
      const id = idString(record.category_id); const items = (await getSectionItems(section, id)).slice(0, 12);
      if (items.length) groups.push({ id: `category-${section}-${id}`, title: text(record.category_name) || title, items });
    };
    await Promise.all([...movieCats.slice(0, 3).map((row) => loadTop('movies', row, 'Movies')),
      ...seriesCats.slice(0, 2).map((row) => loadTop('series', row, 'Shows'))]);
    const all = groups.reduce((items, group) => items.concat(group.items), [] as AppItem[]);
    const progress = localRows(`${profileId}.progress`).filter((entry) => number(entry.positionSeconds));
    const continueItems: AppItem[] = [];
    for (const entry of progress.slice(0, 20)) {
      const cached = all.find((item) => item.kind === entry.kind && item.id === entry.id);
      if (cached) continueItems.push({ ...cached, positionSeconds: number(entry.positionSeconds) });
      else if (entry.kind === 'episode' && text(entry.seriesId)) {
        try {
          const show = await detailItem('series', text(entry.seriesId));
          continueItems.push({ ...entry, kind: 'episode', title: text(entry.title) || 'Episode',
            seriesId: text(entry.seriesId), seriesTitle: text(entry.seriesTitle) || show.title,
            posterUrl: text(entry.posterUrl) || show.posterUrl, backdropUrl: text(entry.backdropUrl) || show.backdropUrl,
            positionSeconds: number(entry.positionSeconds) } as AppItem);
        } catch { /* Skip progress for a show removed by the provider. */ }
      }
      else { try { continueItems.push({ ...await detailItem(text(entry.kind), text(entry.id)), positionSeconds: number(entry.positionSeconds) }); } catch { /* Removed provider item. */ } }
    }
    const saved = localRows(`${profileId}.my-list`);
    const myList: AppItem[] = [];
    for (const entry of saved.slice(0, 20)) {
      const cached = all.find((item) => item.kind === entry.kind && item.id === entry.id);
      if (cached) myList.push(cached);
      else { try { myList.push(await detailItem(text(entry.kind), text(entry.id))); } catch { /* Removed provider item. */ } }
    }
    const featured = all.find((item) => item.kind === 'series') ?? all[0] ?? null;
    return { featured, discoverySource: 'xtream_provider', rows: [
      ...(continueItems.length ? [{ id: 'continue', title: 'Continue Watching', items: continueItems }] : []),
      ...groups,
      ...(myList.length ? [{ id: 'my-list', title: 'My List', items: myList }] : [])
    ] };
  }
  if (parts[0] === 'series' && parts.length === 3 && parts[2] === 'seasons') {
    const response = await seriesInfo(parts[1]); const episodes = response.episodes as Record<string, unknown> || {};
    return { seasons: Object.keys(episodes).map((key) => ({ number: Number(key), count: readArray(episodes[key]).length })).sort((a, b) => a.number - b.number) };
  }
  if (parts[0] === 'series' && parts.length === 5 && parts[2] === 'seasons' && parts[4] === 'episodes') {
    const info = await seriesInfo(parts[1]); const episodes = (info.episodes as Record<string, unknown> || {})[parts[3]];
    const detail = info.info as RecordValue || {};
    return { items: readArray(episodes).map((row) => itemFromEpisode(row, parts[1], text(detail.name) || 'Series', Number(parts[3]))), hasMore: false };
  }
  if (parts[0] === 'episodes' && parts.length === 3 && parts[2] === 'streams') {
    const id = parts[1]; return { items: [{ id, providerId: id, extension: episodeExtensions.get(id) || 'mp4', language: 'Provider stream', languageCode: 'und' }] };
  }
  if (route === '/playback/resolve') {
    const itemKind = text(json.kind), id = text(json.id);
    let extension = text(json.format) || '';
    if (itemKind === 'movie') {
      try { const data = await request('get_vod_info', { vod_id: id }) as RecordValue; extension = text((data.movie_data as RecordValue | undefined)?.container_extension) || 'mp4'; } catch { extension = 'mp4'; }
    } else if (itemKind === 'episode') extension = episodeExtensions.get(id) || 'mp4';
    return { url: providerStreamUrl(itemKind, id, extension) };
  }
  if (route === '/playback/remux-ticket') throw new Error('This provider stream must use a browser-compatible format; server-side remuxing is not available in NightOwly.');
  if (route.includes('/seasons/') && route.endsWith('/episodes')) return { items: [], hasMore: false };
  if (route === '/search') {
    const query = (q.get('q') || '').toLowerCase().replace(/\s+/g, '');
    if (query.length < 1) return { movies: [], series: [], hasMore: false };
    const [mc, sc] = await Promise.all([categoryRecords('movies'), categoryRecords('series')]);
    const [movies, shows] = await Promise.all([itemsAcrossCategories('movies', mc), itemsAcrossCategories('series', sc)]);
    const match = (entry: AppItem): boolean => entry.title.toLowerCase().replace(/\s+/g, '').includes(query);
    const foundMovies = movies.filter(match), foundShows = shows.filter(match);
    const page = Math.max(1, Number(q.get('page') || 1)), limit = Number(q.get('limit') || 50), offset = (page - 1) * limit;
    const pageItems = foundMovies.concat(foundShows).slice(offset, offset + limit);
    return { movies: pageItems.filter((entry) => entry.kind === 'movie'), series: pageItems.filter((entry) => entry.kind === 'series'), hasMore: offset + limit < foundMovies.length + foundShows.length };
  }
  return {};
}

function localProfiles(): Array<{ id: string; name: string }> {
  try {
    const parsed = JSON.parse(getStorage('nightowly.profiles') || 'null') as unknown;
    if (Array.isArray(parsed) && parsed.length) return parsed as Array<{ id: string; name: string }>;
  } catch { /* Use the local default below. */ }
  return [{ id: 'local', name: credentials?.username || 'My Profile' }];
}
async function detailItem(kind: string, id: string): Promise<AppItem> {
  if (kind === 'movie') {
    const response = await request('get_vod_info', { vod_id: id }) as RecordValue;
    const movie = response.movie_data as RecordValue || {}, info = response.info as RecordValue || {};
    const item = convertItem('movies', { ...movie, ...info, stream_id: id });
    item.description = text(info.plot); item.posterUrl = text(info.movie_image) || item.posterUrl;
    item.backdropUrl = text(readArray(info.backdrop_path)[0]);
    const extension = text(movie.container_extension) || 'mp4';
    item.streamExtension = extension; item.streams = [{ id, providerId: id, extension, language: 'Provider stream', languageCode: 'und' }];
    return enrichFromTmdb(item, text(movie.tmdb_id ?? info.tmdb_id), 'movie');
  }
  const response = await seriesInfo(id), info = response.info as RecordValue || {};
  const item = convertItem('series', { ...info, series_id: id });
  item.description = text(info.plot); item.posterUrl = text(info.cover) || item.posterUrl;
  item.backdropUrl = text(readArray(info.backdrop_path)[0]); return enrichFromTmdb(item, text(info.tmdb_id), 'tv');
}
async function enrichFromTmdb(item: AppItem, rawId: string, type: 'movie' | 'tv'): Promise<AppItem> {
  const key = getStorage('nightowly.tmdb-key');
  if (!key || !/^\d+$/.test(rawId)) return item;
  try {
    const response = await fetch(`https://api.themoviedb.org/3/${type}/${rawId}?api_key=${encodeURIComponent(key)}&language=en-US`);
    if (!response.ok) return item;
    const data = await response.json() as RecordValue;
    item.description = text(data.overview) || item.description;
    item.posterUrl = text(data.poster_path) ? `https://image.tmdb.org/t/p/w500${text(data.poster_path)}` : item.posterUrl;
    item.backdropUrl = text(data.backdrop_path) ? `https://image.tmdb.org/t/p/original${text(data.backdrop_path)}` : item.backdropUrl;
    const genres = readArray(data.genres).map((genre) => text(genre.name)).filter(Boolean);
    if (genres.length) item.genre = genres.join(' · ');
    const date = text(data.release_date ?? data.first_air_date);
    if (date) item.releaseYear = Number(date.slice(0, 4)) || item.releaseYear;
    item.rating = number(data.vote_average) ?? item.rating;
  } catch { /* Keep provider metadata if TMDB cannot be reached. */ }
  return item;
}

