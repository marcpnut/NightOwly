type MediaKind = 'movie' | 'series';
export type HomeMedia = { kind: MediaKind; id: string; title: string; description?: string; posterUrl?: string;
  backdropUrl?: string; genre?: string; releaseYear?: number; rating?: number; tmdbId?: string; [key: string]: unknown };
type TmdbResult = { title?: string; name?: string; original_title?: string; original_name?: string; overview?: string;
  poster_path?: string | null; backdrop_path?: string | null; release_date?: string; first_air_date?: string;
  media_type?: 'movie' | 'tv' | 'person';
  vote_average?: number; id?: number };
type TmdbResponse = { results?: TmdbResult[] };
type Row = { id: string; title: string; items: HomeMedia[] };

const cache = new Map<string, { until: number; results: TmdbResult[] }>();
const inFlight = new Map<string, Promise<TmdbResult[]>>();
const cacheMs = 6 * 60 * 60 * 1000;
let configuredToken = process.env.TMDB_API_READ_ACCESS_TOKEN?.trim() || '';
let configuredAuthMode: 'bearer' | 'v3' | undefined;
export function setTmdbToken(token: string): void {
  const next = token.trim();
  if (next !== configuredToken) { cache.clear(); inFlight.clear(); configuredAuthMode = undefined; }
  configuredToken = next;
}
export function hasTmdbToken(): boolean { return configuredToken.length > 0; }
export function getTmdbToken(): string { return configuredToken; }
export async function tmdbFetch(input: string | URL, token = configuredToken, signal?: AbortSignal): Promise<Response> {
  const url = new URL(input.toString());
  const knownMode = token === configuredToken ? configuredAuthMode : undefined;
  const primaryUrl = new URL(url);
  if (knownMode === 'v3') primaryUrl.searchParams.set('api_key', token);
  const primaryResponse = await fetch(primaryUrl, {
    headers: { ...(knownMode === 'v3' ? {} : { Authorization: `Bearer ${token}` }), accept: 'application/json' }, signal
  });
  if (knownMode === 'v3') return primaryResponse;
  if (primaryResponse.ok) { if (token === configuredToken) configuredAuthMode = 'bearer'; return primaryResponse; }
  if (primaryResponse.status !== 401 && primaryResponse.status !== 403) return primaryResponse;
  const v3Url = new URL(url);
  v3Url.searchParams.set('api_key', token);
  const v3Response = await fetch(v3Url, { headers: { accept: 'application/json' }, signal });
  if (v3Response.ok && token === configuredToken) configuredAuthMode = 'v3';
  return v3Response;
}
const img = (path: string | null | undefined, size: 'w500' | 'w1280') => path?.startsWith('/') ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
const dateYear = (date?: string) => date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;

function normalizeTitle(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(2160p|4k|1080p|720p|480p|web[- .]?dl|bluray|brrip|hdrip|x264|x265|hevc|h264|h265|aac|dts)\b/g, ' ')
    .replace(/[([]?\b(?:19|20)\d{2}\b[)\]]?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

async function getList(path: string, token: string, params: Record<string, string> = {}, locale = 'nl-NL'): Promise<TmdbResult[]> {
  const query = new URLSearchParams({ language: locale, ...params });
  const key = `${path}?${query}`;
  const saved = cache.get(key);
  if (saved && saved.until > Date.now()) return saved.results;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const response = await tmdbFetch(`https://api.themoviedb.org/3/${path}?${query}`, token, AbortSignal.timeout(12_000));
    if (!response.ok) throw new Error(`TMDB returned HTTP ${response.status}.`);
    const body = await response.json() as TmdbResponse;
    const results = Array.isArray(body.results) ? body.results : [];
    cache.set(key, { until: Date.now() + cacheMs, results });
    return results;
  })();
  inFlight.set(key, request);
  try { return await request; } finally { inFlight.delete(key); }
}

async function pages(path: string, token: string, query: Record<string, string>, count: number, locale = 'nl-NL'): Promise<TmdbResult[]> {
  const responses = await Promise.all(Array.from({ length: count }, (_, index) =>
    getList(path, token, { ...query, page: String(index + 1) }, locale).catch(() => [])));
  return responses.flat();
}

function matchFeed(feed: TmdbResult[], library: HomeMedia[], kind: MediaKind, max = 20): HomeMedia[] {
  const byTitle = new Map<string, HomeMedia[]>();
  const byTmdbId = new Map<string, HomeMedia>();
  for (const item of library) {
    const key = normalizeTitle(item.title);
    if (item.tmdbId) byTmdbId.set(String(item.tmdbId), item);
    if (!key) continue;
    const entries = byTitle.get(key) ?? [];
    entries.push(item); byTitle.set(key, entries);
  }
  const output: HomeMedia[] = [], seen = new Set<string>();
  for (const result of feed) {
    const title = kind === 'movie' ? result.title || result.original_title : result.name || result.original_name;
    if (!title) continue;
    const direct = result.id == null ? undefined : byTmdbId.get(String(result.id));
    const candidates = direct ? [direct] : byTitle.get(normalizeTitle(title)) ?? byTitle.get(normalizeTitle(kind === 'movie' ? result.original_title || title : result.original_name || title)) ?? [];
    const year = dateYear(kind === 'movie' ? result.release_date : result.first_air_date);
    const item = [...candidates].sort((a, b) => {
      const score = (candidate: HomeMedia) => candidate.releaseYear && year ? Math.abs(candidate.releaseYear - year) : 0;
      return score(a) - score(b);
    })[0];
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    output.push({ ...item, title, description: result.overview || item.description,
      posterUrl: img(result.poster_path, 'w500') || item.posterUrl,
      backdropUrl: img(result.backdrop_path, 'w1280') || item.backdropUrl,
      releaseYear: year || item.releaseYear, rating: result.vote_average || item.rating,
      metadata: { ...(typeof item.metadata === 'object' && item.metadata ? item.metadata as Record<string, unknown> : {}), tmdbId: result.id }
    });
    if (output.length >= max) break;
  }
  return output;
}

function matchMixedFeed(feed: TmdbResult[], movies: HomeMedia[], series: HomeMedia[], max = 20): HomeMedia[] {
  const order = new Map(feed.map((entry, index) => [`${entry.media_type}:${entry.id}`, index]));
  const matched = [
    ...matchFeed(feed.filter((entry) => entry.media_type === 'movie'), movies, 'movie', max),
    ...matchFeed(feed.filter((entry) => entry.media_type === 'tv'), series, 'series', max)
  ];
  const seen = new Set<string>();
  return matched
    .sort((a, b) => (order.get(`${a.kind === 'series' ? 'tv' : 'movie'}:${String((a.metadata as Record<string, unknown> | undefined)?.tmdbId)}`) ?? Infinity)
      - (order.get(`${b.kind === 'series' ? 'tv' : 'movie'}:${String((b.metadata as Record<string, unknown> | undefined)?.tmdbId)}`) ?? Infinity))
    .filter((item) => { const key = `${item.kind}:${item.id}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, max);
}

export async function curatedHome(movies: HomeMedia[], series: HomeMedia[], token = configuredToken, languageCode = 'en'): Promise<{
  source: 'tmdb' | 'catalog'; featured: HomeMedia | null; rows: Row[];
}> {
  if (!token) return { source: 'catalog', featured: movies[0] ?? series[0] ?? null, rows: [
    { id: 'new-movies', title: 'Recently Added Movies', items: movies.slice(0, 12) },
    { id: 'new-series', title: 'Recently Added Series', items: series.slice(0, 12) }
  ] };
  const today = new Date().toISOString().slice(0, 10);
  const localeByCode: Record<string, string> = { en: 'en-US', nl: 'nl-NL', pl: 'pl-PL', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', ru: 'ru-RU', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', tr: 'tr-TR', ar: 'ar-SA', hi: 'hi-IN', sv: 'sv-SE', da: 'da-DK', no: 'nb-NO', fi: 'fi-FI', cs: 'cs-CZ', el: 'el-GR', hu: 'hu-HU', ro: 'ro-RO', uk: 'uk-UA' };
  const locale = localeByCode[languageCode] || `${languageCode}-${languageCode.toUpperCase()}`;
  const localizedList = (path: string, params: Record<string, string> = {}) => getList(path, token, params, locale);
  const localizedPages = (path: string, params: Record<string, string>, count: number) => pages(path, token, params, count, locale);
  const recentStart = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  const sources = await Promise.all([
    localizedList('trending/all/week').catch(() => []),
    localizedList('trending/movie/week').catch(() => []),
    localizedPages('movie/top_rated', {}, 13),
    localizedPages('discover/movie', { region: 'NL', sort_by: 'primary_release_date.desc', 'primary_release_date.gte': recentStart, 'primary_release_date.lte': today, 'vote_count.gte': '10' }, 3),
    localizedList('movie/now_playing', { region: 'NL' }).catch(() => []),
    localizedList('trending/tv/week').catch(() => []),
    localizedList('tv/popular').catch(() => []),
    localizedPages('tv/top_rated', {}, 3),
    localizedList('tv/on_the_air').catch(() => [])
  ]);
  const [trendingAll, trendingMovies, topMovies, newMovies, inCinemas, trendingShows, popularShows, topShows, onAirShows] = sources;
  const topPicks = matchMixedFeed([
    ...trendingAll,
    ...topMovies.slice(0, 40).map((entry) => ({ ...entry, media_type: 'movie' as const })),
    ...trendingShows.map((entry) => ({ ...entry, media_type: 'tv' as const }))
  ], movies, series);
  const rows: Row[] = [
    { id: 'top-picks', title: 'Top Picks for You', items: topPicks },
    { id: 'top-250', title: 'Top 250', items: matchFeed(topMovies.slice(0, 250), movies, 'movie') },
    { id: 'new-releases', title: 'New Releases', items: matchFeed(newMovies, movies, 'movie') },
    { id: 'in-cinemas', title: 'In Cinemas', items: matchFeed(inCinemas, movies, 'movie') },
    { id: 'trending-movies', title: 'Trending Movies', items: matchFeed(trendingMovies, movies, 'movie') },
    { id: 'trending-series', title: 'Trending Series', items: matchFeed(trendingShows, series, 'series') },
    { id: 'popular-series', title: 'Popular Series', items: matchFeed(popularShows, series, 'series') },
    { id: 'top-series', title: 'Top Rated Series', items: matchFeed(topShows, series, 'series') },
    { id: 'on-air', title: 'On the Air', items: matchFeed(onAirShows, series, 'series') }
  ].filter((row) => row.items.length);
  const featured = matchMixedFeed(trendingAll, movies, series, 1)[0] || topPicks[0] || movies[0] || series[0] || null;
  return { source: 'tmdb', featured, rows };
}
