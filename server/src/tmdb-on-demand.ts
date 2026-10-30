import { pool } from './database.js';
import { decrypt } from './security.js';
import { getTmdbToken, hasTmdbToken, setTmdbToken, tmdbFetch } from './tmdb.js';

type TmdbObject = Record<string, any>;
type TmdbFetchResult = { kind: 'data'; body: TmdbObject } | { kind: 'not_found' } | { kind: 'retry'; afterSeconds: number };
type DescriptionLookupStatus = 'available' | 'none' | 'unavailable';
const titleFlights = new Map<string, Promise<DescriptionLookupStatus>>();
const seasonFlights = new Map<string, Promise<void>>();
let nextRequestAt = 0;
let artworkWorkerRunning = false;
let artworkWorkerTimer: NodeJS.Timeout | undefined;
const minimumGapMs = 300;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const imageUrl = (path: unknown, size: 'w500' | 'w1280'): string | null =>
  typeof path === 'string' && path.startsWith('/') ? `https://image.tmdb.org/t/p/${size}${path}` : null;

async function pacedRequest(url: URL): Promise<TmdbFetchResult> {
  const token = getTmdbToken();
  if (!token) return { kind: 'retry', afterSeconds: 3600 };
  const wait = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Date.now() + wait + minimumGapMs;
  if (wait) await pause(wait);
  let response: Response;
  try {
    response = await tmdbFetch(url, token, AbortSignal.timeout(10_000));
  } catch { return { kind: 'retry', afterSeconds: 300 }; }
  if (response.status === 404) return { kind: 'not_found' };
  if (response.status === 429) {
    const retrySeconds = Number(response.headers.get('retry-after'));
    const afterSeconds = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.ceil(retrySeconds) : 60;
    nextRequestAt = Math.max(nextRequestAt, Date.now() + afterSeconds * 1_000);
    return { kind: 'retry', afterSeconds };
  }
  if (!response.ok) return { kind: 'retry', afterSeconds: 3600 };
  try { return { kind: 'data', body: await response.json() as TmdbObject }; }
  catch { return { kind: 'retry', afterSeconds: 3600 }; }
}

export async function loadTmdbToken(key: Buffer): Promise<void> {
  const { rows } = await pool.query<{ token_cipher: string }>(`SELECT token_cipher FROM sc_tmdb_settings WHERE id='primary'`);
  if (rows[0]) setTmdbToken(decrypt(rows[0].token_cipher, key));
}

function chooseTranslations(detail: TmdbObject, languageCodes: Set<string>) {
  const byLanguage = new Map<string, { region: string; data: TmdbObject }>();
  const preferredRegions: Record<string, string> = { en: 'US', nl: 'NL', pl: 'PL', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'PT' };
  const entries = Array.isArray(detail.translations?.translations) ? detail.translations.translations : [];
  for (const entry of entries) {
    const code = String(entry.iso_639_1 || '').toLowerCase();
    const data = entry.data && typeof entry.data === 'object' ? entry.data as TmdbObject : {};
    if (!languageCodes.has(code) || !text(data.title || data.name)) continue;
    const region = String(entry.iso_3166_1 || '').toUpperCase();
    const existing = byLanguage.get(code);
    if (!existing || region === preferredRegions[code]) byLanguage.set(code, { region, data });
  }
  if (!byLanguage.has('en') && languageCodes.has('en')) {
    const title = text(detail.title || detail.name);
    if (title) byLanguage.set('en', { region: 'US', data: { title, overview: detail.overview, tagline: detail.tagline } });
  }
  return [...byLanguage.entries()].map(([code, selected]) => ({ code, data: selected.data }));
}

function trailerFor(videos: unknown, languageCode: string): string | null {
  const rows = Array.isArray(videos) ? videos.filter((video) => video && video.site === 'YouTube' && video.type === 'Trailer' && text(video.key)) : [];
  rows.sort((a, b) => Number(Boolean(b.official)) - Number(Boolean(a.official)));
  return rows.find((video) => video.iso_639_1 === languageCode)?.key
    || rows.find((video) => video.iso_639_1 === 'en')?.key || rows[0]?.key || null;
}

async function saveTitleDetail(titleId: string, kind: 'movie' | 'series', detail: TmdbObject, tmdbId?: string): Promise<void> {
  const languageResult = await pool.query<{ id: number; code: string }>('SELECT id,code FROM sc_languages');
  const languageIds = new Map(languageResult.rows.map((row) => [row.code.toLowerCase(), row.id]));
  const translations = chooseTranslations(detail, new Set(languageIds.keys()));
  const posterUrl = imageUrl(detail.poster_path, 'w500');
  const backdropUrl = imageUrl(detail.backdrop_path, 'w1280');
  const yearString = kind === 'movie' ? detail.release_date : detail.first_air_date;
  const year = typeof yearString === 'string' && /^\d{4}/.test(yearString) ? Number(yearString.slice(0, 4)) : null;
  const runtime = kind === 'movie' ? detail.runtime : detail.episode_run_time?.[0];
  const runtimeSeconds = Number.isInteger(runtime) && runtime > 0 ? runtime * 60 : null;
  const rating = typeof detail.vote_average === 'number' && detail.vote_average >= 0 && detail.vote_average <= 10 ? detail.vote_average : null;
  const genreRows = (Array.isArray(detail.genres) ? detail.genres : []).filter((row) => row?.id != null && text(row.name))
    .map((row) => ({ id: String(row.id), name: text(row.name) }));
  const keywordBlock = detail.keywords;
  const keywordRows = (Array.isArray(keywordBlock) ? keywordBlock : Array.isArray(keywordBlock?.keywords) ? keywordBlock.keywords
    : Array.isArray(keywordBlock?.results) ? keywordBlock.results : []).filter((row: TmdbObject) => row?.id != null && text(row.name))
    .map((row: TmdbObject) => ({ id: String(row.id), name: text(row.name) }));
  const videos = detail.videos?.results || [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE sc_titles SET tmdb_id=COALESCE(tmdb_id,$9),original_title=COALESCE(NULLIF($2,''),original_title),
      release_year=COALESCE($3,release_year),runtime_seconds=COALESCE($4,runtime_seconds),rating=COALESCE($5::numeric(5,2),rating),
      poster_url=COALESCE($6,poster_url),backdrop_url=COALESCE($7,backdrop_url),metadata=metadata||$8::jsonb,
      metadata_source='tmdb',updated_at=now() WHERE id=$1`, [titleId,
      text(detail.original_title || detail.original_name), year, runtimeSeconds, rating, posterUrl, backdropUrl,
      JSON.stringify({ tmdb: { original_language: detail.original_language || null, vote_count: detail.vote_count ?? null,
        popularity: detail.popularity ?? null, status: text(detail.status) } }), tmdbId ?? null]);

    const translationRows = translations.map(({ code, data }) => ({ language_id: languageIds.get(code),
      display_title: text(data.title || data.name), description: text(data.overview) || (code === 'en' ? text(detail.overview) : null), tagline: text(data.tagline),
      trailer_id: trailerFor(videos, code), poster_url: posterUrl })).filter((row) => row.language_id && row.display_title);
    if (translationRows.length) await client.query(`INSERT INTO sc_title_translations
      (title_id,language_id,display_title,description,tagline,trailer_id,poster_url,source)
      SELECT $1,x.language_id,x.display_title,x.description,x.tagline,x.trailer_id,x.poster_url,'tmdb'
      FROM jsonb_to_recordset($2::jsonb) AS x(language_id smallint,display_title text,description text,tagline text,trailer_id text,poster_url text)
      ON CONFLICT(title_id,language_id) DO UPDATE SET
        display_title=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.display_title ELSE EXCLUDED.display_title END,
        description=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.description ELSE COALESCE(EXCLUDED.description,sc_title_translations.description) END,
        tagline=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.tagline ELSE COALESCE(EXCLUDED.tagline,sc_title_translations.tagline) END,
        trailer_id=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.trailer_id ELSE COALESCE(EXCLUDED.trailer_id,sc_title_translations.trailer_id) END,
        poster_url=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.poster_url ELSE COALESCE(EXCLUDED.poster_url,sc_title_translations.poster_url) END,
        source=CASE WHEN sc_title_translations.source='manual' THEN 'manual' ELSE 'tmdb' END,updated_at=now()`,
    [titleId, JSON.stringify(translationRows)]);

    if (genreRows.length) await client.query(`WITH items AS (SELECT DISTINCT id,name FROM jsonb_to_recordset($1::jsonb) AS x(id text,name text)),
      added AS (INSERT INTO sc_genres(source,external_id,name) SELECT 'tmdb',id,name FROM items ON CONFLICT DO NOTHING RETURNING id)
      INSERT INTO sc_title_genres(title_id,genre_id) SELECT DISTINCT $2,g.id FROM items i JOIN sc_genres g
      ON g.source='tmdb' AND (g.external_id=i.id OR g.name=i.name) ON CONFLICT DO NOTHING`, [JSON.stringify(genreRows), titleId]);
    if (keywordRows.length) await client.query(`WITH items AS (SELECT DISTINCT id,name FROM jsonb_to_recordset($1::jsonb) AS x(id text,name text)),
      added AS (INSERT INTO sc_keywords(source,external_id,name) SELECT 'tmdb',id,name FROM items ON CONFLICT DO NOTHING RETURNING id)
      INSERT INTO sc_title_keywords(title_id,keyword_id) SELECT DISTINCT $2,k.id FROM items i JOIN sc_keywords k
      ON k.source='tmdb' AND (k.external_id=i.id OR k.name=i.name) ON CONFLICT DO NOTHING`, [JSON.stringify(keywordRows), titleId]);
    await client.query(`INSERT INTO sc_tmdb_title_cache(title_id,status,fetched_at,retry_after,last_error)
      VALUES($1,'complete',now(),NULL,NULL) ON CONFLICT(title_id) DO UPDATE SET status='complete',fetched_at=now(),retry_after=NULL,last_error=NULL`, [titleId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function cleanSearchTitle(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/^(?:NL|EN|PL|DE|FR|IT|ES|PT|NF|D\+)\s*[-:]\s*/i, '')
    .replace(/\b(?:MULTI[- ]?SUB|DUAL[- ]?AUDIO|2160P|1080P|720P|4K|HDR|HEVC|X265|X264)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/[()[\]{}]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function normalizedTitle(value: string): string {
  return cleanSearchTitle(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function titleYear(value: string): number | undefined {
  const match = value.match(/\b((?:19|20)\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

async function searchTmdbId(kind: 'movie' | 'series', title: string, year?: number): Promise<string | null | 'retry'> {
  const query = cleanSearchTitle(title);
  if (!query) return null;
  const endpoint = kind === 'movie' ? 'movie' : 'tv';
  const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
  url.searchParams.set('query', query); url.searchParams.set('language', 'en-US'); url.searchParams.set('include_adult', 'false');
  if (year) url.searchParams.set(kind === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(year));
  const result = await pacedRequest(url);
  if (result.kind === 'retry') return 'retry';
  if (result.kind === 'not_found') return null;
  const expected = normalizedTitle(title);
  const matches = Array.isArray(result.body.results) ? result.body.results as TmdbObject[] : [];
  const matched = matches.find((candidate) => {
    const names = kind === 'movie' ? [candidate.title, candidate.original_title] : [candidate.name, candidate.original_name];
    if (!names.some((name) => typeof name === 'string' && normalizedTitle(name) === expected)) return false;
    if (!year) return true;
    const releaseDate = kind === 'movie' ? candidate.release_date : candidate.first_air_date;
    const match = typeof releaseDate === 'string' ? releaseDate.match(/^(?:19|20)\d{2}/) : null;
    return !match || Number(match[0]) === year;
  });
  return matched?.id == null ? null : String(matched.id);
}

async function ensureTitleMetadataImpl(titleId: string, kind: 'movie' | 'series', displayTitle?: string, releaseYear?: number): Promise<DescriptionLookupStatus> {
  const { rows } = await pool.query<{ tmdb_id: string | null; original_title: string; release_year: number | null; status: string | null; retry_after: Date | null }>(`SELECT t.tmdb_id,t.original_title,t.release_year,c.status,c.retry_after
    FROM sc_titles t LEFT JOIN sc_tmdb_title_cache c ON c.title_id=t.id WHERE t.id=$1 AND t.kind=$2`, [titleId, kind]);
  const row = rows[0];
  if (!row) return 'none';
  if (!hasTmdbToken()) return 'unavailable';
  if (row.status === 'complete' || row.status === 'not_found') return 'none';
  if (row.status === 'retry' && row.retry_after && row.retry_after.getTime() > Date.now()) return 'unavailable';
  let tmdbId = row.tmdb_id;
  if (!tmdbId) {
    const searchTitle = displayTitle || row.original_title;
    const searched = await searchTmdbId(kind, searchTitle, releaseYear || row.release_year || titleYear(searchTitle));
    if (searched === 'retry') {
      await pool.query(`INSERT INTO sc_tmdb_title_cache(title_id,status,fetched_at,retry_after,last_error)
        VALUES($1,'retry',now(),now()+interval '60 seconds','TMDB title search unavailable')
        ON CONFLICT(title_id) DO UPDATE SET status='retry',fetched_at=now(),retry_after=now()+interval '60 seconds',last_error='TMDB title search unavailable'`, [titleId]);
      return 'unavailable';
    }
    if (!searched) {
      await pool.query(`INSERT INTO sc_tmdb_title_cache(title_id,status,fetched_at,retry_after,last_error)
        VALUES($1,'not_found',now(),NULL,'No exact title match in TMDB')
        ON CONFLICT(title_id) DO UPDATE SET status='not_found',fetched_at=now(),retry_after=NULL,last_error='No exact title match in TMDB'`, [titleId]);
      return 'none';
    }
    tmdbId = searched;
  }
  const endpoint = kind === 'movie' ? 'movie' : 'tv';
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}`);
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('append_to_response', 'translations,keywords,videos');
  const result = await pacedRequest(url);
  if (result.kind === 'not_found') {
    await pool.query(`INSERT INTO sc_tmdb_title_cache(title_id,status,fetched_at,retry_after,last_error)
      VALUES($1,'not_found',now(),NULL,'TMDB ID not found') ON CONFLICT(title_id) DO UPDATE SET
      status='not_found',fetched_at=now(),retry_after=NULL,last_error='TMDB ID not found'`, [titleId]);
    return 'none';
  }
  if (result.kind === 'retry') {
    await pool.query(`INSERT INTO sc_tmdb_title_cache(title_id,status,fetched_at,retry_after,last_error)
      VALUES($1,'retry',now(),now()+($2*interval '1 second'),'TMDB request unavailable')
      ON CONFLICT(title_id) DO UPDATE SET status='retry',fetched_at=now(),retry_after=now()+($2*interval '1 second'),last_error='TMDB request unavailable'`, [titleId, result.afterSeconds]);
    return 'unavailable';
  }
  let tmdbIdToStore: string | undefined = tmdbId;
  if (!row.tmdb_id) {
    const conflict = await pool.query('SELECT 1 FROM sc_titles WHERE kind=$1 AND tmdb_id=$2 AND id<>$3 LIMIT 1', [kind, tmdbId, titleId]);
    if (conflict.rowCount) tmdbIdToStore = undefined;
  }
  await saveTitleDetail(titleId, kind, result.body, tmdbIdToStore);
  return 'available';
}

export function ensureTmdbTitleMetadata(titleId: string, kind: 'movie' | 'series', displayTitle?: string, releaseYear?: number): Promise<DescriptionLookupStatus> {
  const key = `${kind}:${titleId}`;
  const existing = titleFlights.get(key);
  if (existing) return existing;
  const request = ensureTitleMetadataImpl(titleId, kind, displayTitle, releaseYear).catch(() => 'unavailable' as const);
  titleFlights.set(key, request);
  return request.finally(() => titleFlights.delete(key));
}

async function backfillOneArtwork(): Promise<void> {
  if (!hasTmdbToken()) return;
  const { rows } = await pool.query<{ id: string; kind: 'movie' | 'series'; tmdb_id: string }>(`SELECT t.id::text,t.kind,t.tmdb_id
    FROM sc_titles t LEFT JOIN sc_tmdb_artwork_cache c ON c.title_id=t.id
    WHERE t.kind IN ('movie','series') AND t.tmdb_id IS NOT NULL AND NULLIF(t.backdrop_url,'') IS NULL
      AND (c.title_id IS NULL OR (c.status='retry' AND c.retry_after <= now()))
    ORDER BY t.id LIMIT 1`);
  const title = rows[0];
  if (!title) return;
  const endpoint = title.kind === 'movie' ? 'movie' : 'tv';
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(title.tmdb_id)}`);
  url.searchParams.set('language', 'en-US');
  const result = await pacedRequest(url);
  let status: 'complete' | 'not_found' | 'retry';
  let retryAfter: number | null = null;
  let lastError: string | null = null;
  let backdrop: string | null = null;
  if (result.kind === 'not_found') { status = 'not_found'; lastError = 'TMDB ID not found'; }
  else if (result.kind === 'retry') { status = 'retry'; retryAfter = result.afterSeconds; lastError = 'TMDB request unavailable'; }
  else {
    backdrop = imageUrl(result.body.backdrop_path, 'w1280');
    status = backdrop ? 'complete' : 'not_found';
    if (!backdrop) lastError = 'TMDB has no landscape artwork';
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (backdrop) await client.query(`UPDATE sc_titles SET backdrop_url=COALESCE(NULLIF(backdrop_url,''),$2),updated_at=now() WHERE id=$1`, [title.id, backdrop]);
    await client.query(`INSERT INTO sc_tmdb_artwork_cache(title_id,status,fetched_at,retry_after,last_error)
      VALUES($1,$2,now(),CASE WHEN $3::integer IS NULL THEN NULL ELSE now()+($3::integer*interval '1 second') END,$4)
      ON CONFLICT(title_id) DO UPDATE SET status=EXCLUDED.status,fetched_at=now(),retry_after=EXCLUDED.retry_after,last_error=EXCLUDED.last_error`,
    [title.id, status, retryAfter, lastError]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export function startTmdbArtworkBackfill(): void {
  if (artworkWorkerTimer) return;
  // One small request per second keeps this resumable job comfortably below provider limits.
  artworkWorkerTimer = setInterval(() => {
    if (artworkWorkerRunning || !hasTmdbToken()) return;
    artworkWorkerRunning = true;
    void backfillOneArtwork().catch(() => {}).finally(() => { artworkWorkerRunning = false; });
  }, 1_000);
  artworkWorkerTimer.unref();
}

export async function tmdbArtworkBackfillStatus(): Promise<{ pending: number; complete: number; notFound: number; retry: number; withoutTmdbId: number }> {
  const { rows } = await pool.query<{ pending: number; complete: number; not_found: number; retry: number; without_tmdb_id: number }>(`SELECT
    count(*) FILTER (WHERE t.tmdb_id IS NOT NULL AND NULLIF(t.backdrop_url,'') IS NULL AND c.title_id IS NULL)::integer AS pending,
    count(*) FILTER (WHERE c.status='complete')::integer AS complete,
    count(*) FILTER (WHERE c.status='not_found')::integer AS not_found,
    count(*) FILTER (WHERE c.status='retry')::integer AS retry,
    count(*) FILTER (WHERE t.tmdb_id IS NULL AND NULLIF(t.backdrop_url,'') IS NULL)::integer AS without_tmdb_id
    FROM sc_titles t LEFT JOIN sc_tmdb_artwork_cache c ON c.title_id=t.id WHERE t.kind IN ('movie','series')`);
  const row = rows[0];
  return { pending: row?.pending ?? 0, complete: row?.complete ?? 0, notFound: row?.not_found ?? 0,
    retry: row?.retry ?? 0, withoutTmdbId: row?.without_tmdb_id ?? 0 };
}

async function ensureSeasonMetadataImpl(seriesTitleId: string, seasonNumber: number, languageCode: string): Promise<void> {
  if (!hasTmdbToken()) return;
  const lang = languageCode.toLowerCase();
  const { rows } = await pool.query<{ tmdb_id: string | null; status: string | null; retry_after: Date | null }>(`SELECT t.tmdb_id,c.status,c.retry_after
    FROM sc_titles t LEFT JOIN sc_tmdb_season_cache c ON c.series_title_id=t.id AND c.season_number=$2 AND c.language_code=$3
    WHERE t.id=$1 AND t.kind='series'`, [seriesTitleId, seasonNumber, lang]);
  const row = rows[0];
  if (!row?.tmdb_id || row.status === 'complete' || row.status === 'not_found') return;
  if (row.status === 'retry' && row.retry_after && row.retry_after.getTime() > Date.now()) return;
  const url = new URL(`https://api.themoviedb.org/3/tv/${encodeURIComponent(row.tmdb_id)}/season/${seasonNumber}`);
  url.searchParams.set('language', `${lang}-${({ en: 'US', nl: 'NL', pl: 'PL' } as Record<string,string>)[lang] || lang.toUpperCase()}`);
  const result = await pacedRequest(url);
  if (result.kind === 'not_found') {
    await pool.query(`INSERT INTO sc_tmdb_season_cache(series_title_id,season_number,language_code,status,retry_after,last_error)
      VALUES($1,$2,$3,'not_found',NULL,'TMDB season not found')
      ON CONFLICT(series_title_id,season_number,language_code) DO UPDATE SET status='not_found',fetched_at=now(),retry_after=NULL,last_error='TMDB season not found'`,
    [seriesTitleId, seasonNumber, lang]);
    return;
  }
  if (result.kind === 'retry') {
    await pool.query(`INSERT INTO sc_tmdb_season_cache(series_title_id,season_number,language_code,status,retry_after,last_error)
      VALUES($1,$2,$3,'retry',now()+($4*interval '1 second'),'TMDB request unavailable')
      ON CONFLICT(series_title_id,season_number,language_code) DO UPDATE SET status='retry',fetched_at=now(),retry_after=now()+($4*interval '1 second'),last_error='TMDB request unavailable'`,
    [seriesTitleId, seasonNumber, lang, result.afterSeconds]);
    return;
  }
  const episodes = Array.isArray(result.body.episodes) ? result.body.episodes : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const languageResult = await client.query<{ id: number }>('SELECT id FROM sc_languages WHERE code=$1', [lang]);
    const languageId = languageResult.rows[0]?.id;
    if (languageId) for (const episode of episodes) {
      if (!Number.isInteger(episode.episode_number)) continue;
      const title = text(episode.name);
      if (!title) continue;
      await client.query(`INSERT INTO sc_title_translations(title_id,language_id,display_title,description,poster_url,source)
        SELECT se.episode_title_id,$4,$5,$6,$7,'tmdb' FROM sc_series_episodes se
        WHERE se.series_title_id=$1 AND se.season_number=$2 AND se.episode_number=$3
        ON CONFLICT(title_id,language_id) DO UPDATE SET
          display_title=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.display_title ELSE EXCLUDED.display_title END,
          description=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.description ELSE COALESCE(EXCLUDED.description,sc_title_translations.description) END,
          poster_url=CASE WHEN sc_title_translations.source='manual' THEN sc_title_translations.poster_url ELSE COALESCE(EXCLUDED.poster_url,sc_title_translations.poster_url) END,
          source=CASE WHEN sc_title_translations.source='manual' THEN 'manual' ELSE 'tmdb' END,updated_at=now()`,
      [seriesTitleId, seasonNumber, episode.episode_number, languageId, title, text(episode.overview), imageUrl(episode.still_path, 'w500')]);
      const airDate = typeof episode.air_date === 'string' && /^\d{4}/.test(episode.air_date) ? Number(episode.air_date.slice(0, 4)) : null;
      const runtimeSeconds = Number.isInteger(episode.runtime) && episode.runtime > 0 ? episode.runtime * 60 : null;
      await client.query(`UPDATE sc_titles t SET release_year=COALESCE($4,t.release_year),runtime_seconds=COALESCE($5,t.runtime_seconds),updated_at=now()
        FROM sc_series_episodes se WHERE se.episode_title_id=t.id AND se.series_title_id=$1 AND se.season_number=$2 AND se.episode_number=$3`,
      [seriesTitleId, seasonNumber, episode.episode_number, airDate, runtimeSeconds]);
    }
    await client.query(`INSERT INTO sc_tmdb_season_cache(series_title_id,season_number,language_code,status,fetched_at,retry_after,last_error)
      VALUES($1,$2,$3,'complete',now(),NULL,NULL)
      ON CONFLICT(series_title_id,season_number,language_code) DO UPDATE SET status='complete',fetched_at=now(),retry_after=NULL,last_error=NULL`,
    [seriesTitleId, seasonNumber, lang]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(`INSERT INTO sc_tmdb_season_cache(series_title_id,season_number,language_code,status,retry_after,last_error)
      VALUES($1,$2,$3,'retry',now()+interval '1 hour','Database update failed')
      ON CONFLICT(series_title_id,season_number,language_code) DO UPDATE SET status='retry',fetched_at=now(),retry_after=now()+interval '1 hour',last_error='Database update failed'`,
    [seriesTitleId, seasonNumber, lang]);
  } finally { client.release(); }
}

export function ensureTmdbSeasonMetadata(seriesTitleId: string, seasonNumber: number, languageCode: string): Promise<void> {
  const key = `${seriesTitleId}:${seasonNumber}:${languageCode.toLowerCase()}`;
  const existing = seasonFlights.get(key);
  if (existing) return existing;
  const request = ensureSeasonMetadataImpl(seriesTitleId, seasonNumber, languageCode).catch(() => {});
  seasonFlights.set(key, request);
  return request.finally(() => seasonFlights.delete(key));
}
