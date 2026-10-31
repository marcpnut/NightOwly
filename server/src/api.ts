import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getCatalog, getNormalizedDetail, getNormalizedSeriesTitle, hasNormalizedCatalog, listCatalog, normalizedTitleSql,
  listAvailableLanguages, listNormalizedCategories, listNormalizedEpisodeStreams, listNormalizedEpisodes, listNormalizedHomeCatalog, listNormalizedSeasons,
  createClientSession, createWebAccount, hasWebAccount, loadProvider, loadWebAccount, pool, revokeClientSession, saveOpenSubtitlesApiKey, saveProvider, saveProviderTitleDescription, validateClientSession } from './database.js';
import { playbackUrl, providerPlaybackInfo, requestProvider } from './provider.js';
import { createSessionToken, encrypt, hashPassword, tokenMatches, verifyPassword } from './security.js';
import { curatedHome, hasTmdbToken, setTmdbToken, type HomeMedia } from './tmdb.js';
import { ensureTmdbSeasonMetadata, ensureTmdbTitleMetadata, tmdbArtworkBackfillStatus } from './tmdb-on-demand.js';
import { configureOpenSubtitles, downloadOpenSubtitle, openSubtitlesConfigured, searchOpenSubtitles } from './opensubtitles.js';
import { getCatalogRefreshState, startPlaylistCatalogRefresh } from './normalized-sync.js';
import { spawn } from 'node:child_process';

const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(20).default(20), category: z.string().max(80).optional(), q: z.string().trim().max(100).optional() });
const idParam = z.object({ id: z.string().regex(/^\d+$/) });
const profileParam = z.object({ id: z.string().uuid() });
const profileName = z.object({ name: z.string().trim().min(1).max(24) });
const listInput = z.object({ kind: z.enum(['movie', 'series']), id: z.string().regex(/^\d+$/), saved: z.boolean() });
const progressInput = z.object({ kind: z.enum(['movie', 'episode', 'live']), id: z.string().regex(/^\d+$/), positionSeconds: z.number().int().min(0), durationSeconds: z.number().int().min(0).optional(), completed: z.boolean().default(false) });
const playbackInput = z.object({ kind: z.enum(['live', 'movie', 'episode']), id: z.string().regex(/^\d+$/), format: z.enum(['m3u8', 'ts']).optional() });
const providerInput = z.object({ baseUrl: z.string().trim().url().max(512), username: z.string().trim().min(1).max(128), password: z.string().min(1).max(256) });
const webAccountInput = z.object({ username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/), password: z.string().min(8).max(256) });
const tmdbTokenInput = z.object({ token: z.string().trim().max(512) });
const openSubtitlesKeyInput = z.object({ apiKey: z.string().trim().max(512) });
const subtitleSearchInput = z.object({ kind: z.enum(['movie', 'episode']), id: z.string().regex(/^\d+$/),
  query: z.string().trim().min(3).max(160), language: z.string().regex(/^[a-z]{2}$/), tmdbId: z.string().regex(/^\d+$/).optional(),
  seasonNumber: z.number().int().min(0).max(100).optional(), episodeNumber: z.number().int().min(0).max(5000).optional() });
const subtitleDownloadInput = z.object({ fileId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const deviceId = (request: FastifyRequest) => z.string().uuid().parse(request.headers['x-device-id']);
const loginFailures = new Map<string, { count: number; resetsAt: number }>();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginFailures = 5;
const providerDescriptionFlights = new Map<string, Promise<string | null>>();
const providerDescriptionCache = new Map<string, { value: string | null; expiresAt: number }>();
async function loadProviderDescription(kind: 'movie' | 'series', providerId: string, credentials: NonNullable<Awaited<ReturnType<typeof loadProvider>>>): Promise<string | null> {
  const key = `${kind}:${providerId}`;
  const cached = providerDescriptionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = providerDescriptionFlights.get(key);
  if (existing) return existing;
  const request = (async (): Promise<string | null> => {
    try {
      const action = kind === 'movie' ? 'get_vod_info' : 'get_series_info';
      const payload = await requestProvider(credentials, action, { [kind === 'movie' ? 'vod_id' : 'series_id']: providerId }, 8_000);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      const root = payload as Record<string, unknown>;
      const info = root.info && typeof root.info === 'object' && !Array.isArray(root.info) ? root.info as Record<string, unknown> : {};
      const movieData = root.movie_data && typeof root.movie_data === 'object' && !Array.isArray(root.movie_data) ? root.movie_data as Record<string, unknown> : {};
      const description = [root.plot, root.description, root.overview, info.plot, info.description, info.overview,
        movieData.plot, movieData.description].find((value) => typeof value === 'string' && value.trim());
      const value = typeof description === 'string' ? description.trim() : null;
      providerDescriptionCache.set(key, { value, expiresAt: Date.now() + (value ? 24 * 60 * 60_000 : 60 * 60_000) });
      return value;
    } catch {
      providerDescriptionCache.set(key, { value: null, expiresAt: Date.now() + 60_000 });
      return null;
    }
  })();
  providerDescriptionFlights.set(key, request);
  return request.finally(() => providerDescriptionFlights.delete(key));
}
function getLoginFailureCount(ip: string): number {
  const state = loginFailures.get(ip);
  if (!state || state.resetsAt <= Date.now()) { loginFailures.delete(ip); return 0; }
  return state.count;
}
function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const previous = loginFailures.get(ip);
  const state = !previous || previous.resetsAt <= now ? { count: 0, resetsAt: now + loginWindowMs } : previous;
  state.count += 1;
  loginFailures.set(ip, state);
  if (loginFailures.size > 1000) for (const [key, value] of loginFailures) if (value.resetsAt <= now) loginFailures.delete(key);
}
async function profileBelongsToDevice(profileId: string, device: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM profiles WHERE id=$1 AND device_id=$2', [profileId, device]);
  return (rowCount ?? 0) > 0;
}

export function makeApi(options: { apiToken: string; credentialKey: Buffer }) {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.url', 'res.headers.location'] }, bodyLimit: 64 * 1024 });
  let activeRemuxJobs = 0;
  let activeTranscodeJobs = 0;
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid request.', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    app.log.error(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Request failed.' } });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Device-Id');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return reply.code(204).send();
    if (!request.url.startsWith('/api/v1/')) return;
    const path = request.url.split('?')[0];
    if (path === '/api/v1/health' || path === '/api/v1/auth/status' || path === '/api/v1/auth/login' || path.startsWith('/api/v1/playback/remux/')) return;
    const device = deviceId(request);
    if (tokenMatches(request.headers.authorization, options.apiToken)) return;
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    if (!token || !(await validateClientSession(token, device))) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
  });

  app.get('/api/v1/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/v1/auth/status', async () => ({ configured: await hasWebAccount() }));
  app.post('/api/v1/auth/setup', async (request, reply) => {
    if (await hasWebAccount()) return reply.code(409).send({ error: { code: 'ACCOUNT_ALREADY_CONFIGURED', message: 'A NightOwl account has already been created.' } });
    const { username, password } = webAccountInput.parse(request.body);
    const device = deviceId(request);
    const created = await createWebAccount(username.toLowerCase(), await hashPassword(password));
    if (!created) return reply.code(409).send({ error: { code: 'ACCOUNT_ALREADY_CONFIGURED', message: 'A NightOwl account has already been created.' } });
    const accessToken = createSessionToken();
    await createClientSession(accessToken, device);
    return reply.code(201).send({ accessToken, expiresInSeconds: 30 * 24 * 60 * 60 });
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const { username, password } = webAccountInput.parse(request.body);
    const device = deviceId(request);
    const ip = request.ip;
    if (getLoginFailureCount(ip) >= maxLoginFailures) {
      return reply.code(429).send({ error: { code: 'LOGIN_RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } });
    }
    const account = await loadWebAccount();
    if (!account) return reply.code(409).send({ error: { code: 'ACCOUNT_SETUP_REQUIRED', message: 'Create the NightOwl owner account first.' } });
    if (account.username !== username.toLowerCase() || !(await verifyPassword(password, account.passwordHash))) {
      recordLoginFailure(ip);
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect.' } });
    }
    loginFailures.delete(ip);
    const accessToken = createSessionToken();
    await createClientSession(accessToken, device);
    return reply.send({ accessToken, expiresInSeconds: 30 * 24 * 60 * 60 });
  });
  app.post('/api/v1/auth/logout', async (request) => {
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    if (token && !tokenMatches(request.headers.authorization, options.apiToken)) await revokeClientSession(token, deviceId(request));
    return { loggedOut: true };
  });
  app.get('/api/v1/database/summary', async () => {
    const normalized = await hasNormalizedCatalog();
    if (normalized) {
      const { rows } = await pool.query<{ movies: string; series: string; liveTv: string; episodes: string; episodeStreams: string; lastRefreshed: Date | null }>(`
        SELECT count(*) FILTER (WHERE kind='movie' AND active)::text AS movies,
          count(*) FILTER (WHERE kind='series' AND active)::text AS series,
          count(*) FILTER (WHERE kind='live' AND active)::text AS "liveTv",
          count(DISTINCT title_id) FILTER (WHERE kind='episode' AND active)::text AS episodes,
          count(*) FILTER (WHERE kind='episode' AND active)::text AS "episodeStreams",
          max(last_seen_at) AS "lastRefreshed"
        FROM sc_provider_streams WHERE provider_key='xtream'`);
      return { source: 'normalized', counts: { movies: Number(rows[0].movies), series: Number(rows[0].series), liveTv: Number(rows[0].liveTv),
        episodes: Number(rows[0].episodes), episodeStreams: Number(rows[0].episodeStreams) }, lastRefreshed: rows[0].lastRefreshed, refresh: getCatalogRefreshState() };
    }
    const { rows } = await pool.query<{ movies: string; series: string; liveTv: string; episodes: string; lastRefreshed: Date | null }>(`
      SELECT count(*) FILTER (WHERE kind='movie' AND active)::text AS movies,
        count(*) FILTER (WHERE kind='series' AND active)::text AS series,
        count(*) FILTER (WHERE kind='live' AND active)::text AS "liveTv",
        count(*) FILTER (WHERE kind='episode' AND active)::text AS episodes,
        max(last_seen_at) AS "lastRefreshed" FROM catalog`);
    return { source: 'legacy', counts: { movies: Number(rows[0].movies), series: Number(rows[0].series), liveTv: Number(rows[0].liveTv), episodes: Number(rows[0].episodes) },
      lastRefreshed: rows[0].lastRefreshed, refresh: getCatalogRefreshState() };
  });
  app.get('/api/v1/provider/sync/status', async () => getCatalogRefreshState());
  app.get('/api/v1/sync/status', async () => {
    if (await hasNormalizedCatalog()) {
      const { rows } = await pool.query<{ dataset: string; rowCount: number }>(`SELECT kind AS dataset,count(*)::integer AS "rowCount"
        FROM sc_provider_streams WHERE active GROUP BY kind ORDER BY kind`);
      return { source: 'normalized_database', datasets: rows.map((row) => ({ ...row, status: 'loaded' })) };
    }
    const { rows } = await pool.query('SELECT dataset,status,cursor,last_attempt_at AS "lastAttemptAt",last_success_at AS "lastSuccessAt",last_error AS "lastError",row_count AS "rowCount" FROM sync_state ORDER BY dataset');
    return { source: 'legacy_catalog', datasets: rows };
  });
  app.get('/api/v1/provider/status', async () => {
    const configured = await pool.query<{ configured: boolean }>(`SELECT EXISTS(SELECT 1 FROM provider_config WHERE id='primary') AS configured`);
    if (await hasNormalizedCatalog()) {
      const { rows } = await pool.query<{ kind: string; count: string }>(`SELECT kind,count(*)::text AS count
        FROM sc_provider_streams WHERE active GROUP BY kind ORDER BY kind`);
      return { configured: !!configured.rows[0]?.configured, status: configured.rows[0]?.configured ? 'configured' : 'unconfigured',
        catalogMode: 'normalized_database',
        rowCount: rows.reduce((total, row) => total + Number(row.count), 0), lastError: undefined,
        datasets: rows.map((row) => ({ dataset: row.kind, status: 'success', rowCount: Number(row.count) })) };
    }
    const { rows } = await pool.query<{ dataset: string; status: string; row_count: number; last_error: string | null }>(
      `SELECT dataset,status,row_count,last_error FROM sync_state WHERE dataset IN ('live','movie','series','episodes') ORDER BY dataset`);
    const status = !configured.rows[0]?.configured ? 'unconfigured'
      : rows.some((row) => row.status === 'running') ? 'syncing'
      : rows.length === 4 && rows.every((row) => row.status === 'success') ? 'success'
      : rows.some((row) => row.status === 'error') ? 'error' : 'connected';
    return { configured: !!configured.rows[0]?.configured, status, rowCount: rows.reduce((total, row) => total + row.row_count, 0),
      lastError: rows.find((row) => row.status === 'error')?.last_error, datasets: rows };
  });
  app.post('/api/v1/provider/connect', async (request, reply) => {
    const input = providerInput.parse(request.body);
    const parsed = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Enter a provider HTTP or HTTPS base URL without embedded credentials or query parameters.' } });
    }
    const credentials = { baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`, username: input.username, password: input.password };
    await saveProvider(credentials, options.credentialKey);
    return reply.code(200).send({ connected: true, status: 'credentials_saved', catalogSyncStarted: false });
  });
  app.post('/api/v1/provider/sync', async (_request, reply) => {
    if (!(await hasNormalizedCatalog())) return reply.code(409).send({ error: { code: 'UNSUPPORTED_CATALOG', message: 'Manual refresh is not available for this catalog mode.' } });
    if (!startPlaylistCatalogRefresh(options.credentialKey)) return reply.code(409).send({ error: { code: 'SYNC_ALREADY_RUNNING', message: 'A catalog refresh is already running.' } });
    return reply.code(202).send({ started: true, refresh: getCatalogRefreshState() });
  });
  app.get('/api/v1/tmdb/status', async () => ({ configured: hasTmdbToken() }));
  app.get('/api/v1/tmdb/artwork-status', async () => ({ configured: hasTmdbToken(), ...(await tmdbArtworkBackfillStatus()) }));
  app.post('/api/v1/tmdb/config', async (request) => {
    const { token } = tmdbTokenInput.parse(request.body);
    if (token) await pool.query(`INSERT INTO sc_tmdb_settings(id,token_cipher,updated_at) VALUES('primary',$1,now())
      ON CONFLICT(id) DO UPDATE SET token_cipher=EXCLUDED.token_cipher,updated_at=now()`, [encrypt(token, options.credentialKey)]);
    else await pool.query(`DELETE FROM sc_tmdb_settings WHERE id='primary'`);
    setTmdbToken(token);
    return { configured: hasTmdbToken() };
  });
  app.get('/api/v1/opensubtitles/status', async () => ({ configured: openSubtitlesConfigured() }));
  app.post('/api/v1/opensubtitles/config', async (request) => {
    const { apiKey } = openSubtitlesKeyInput.parse(request.body);
    await saveOpenSubtitlesApiKey(apiKey, options.credentialKey);
    configureOpenSubtitles(apiKey || null);
    return { configured: openSubtitlesConfigured() };
  });
  app.post('/api/v1/opensubtitles/search', async (request, reply) => {
    const input = subtitleSearchInput.parse(request.body);
    const allowedLanguages = await listAvailableLanguages();
    if (!allowedLanguages.some(({ code }) => code === input.language)) {
      return reply.code(400).send({ error: { code: 'INVALID_SUBTITLE_LANGUAGE', message: 'Choose a subtitle language available in the catalog.' } });
    }
    try { return { items: await searchOpenSubtitles(input) }; }
    catch (error) { return reply.code(502).send({ error: { code: 'SUBTITLE_SEARCH_FAILED', message: error instanceof Error ? error.message : 'Subtitle search failed.' } }); }
  });
  app.post('/api/v1/opensubtitles/download', async (request, reply) => {
    const { fileId } = subtitleDownloadInput.parse(request.body);
    try { return { vtt: await downloadOpenSubtitle(fileId) }; }
    catch (error) { return reply.code(502).send({ error: { code: 'SUBTITLE_DOWNLOAD_FAILED', message: error instanceof Error ? error.message : 'Subtitle download failed.' } }); }
  });
  app.get('/api/v1/home', async (request, reply) => {
    const homeQuery = z.object({ profileId: z.string().uuid().optional(), language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query);
    const profile = homeQuery.profileId;
    if (profile && !(await profileBelongsToDevice(profile, deviceId(request)))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const catalog = await hasNormalizedCatalog()
      ? await listNormalizedHomeCatalog(50_000, homeQuery.language) as HomeMedia[]
      : (await pool.query<HomeMedia>(`SELECT kind,id,title,description,poster_url AS "posterUrl",backdrop_url AS "backdropUrl",
        release_year AS "releaseYear",rating,genre FROM catalog WHERE active=true AND kind IN ('movie','series')`)).rows;
    const movies = catalog.filter((item) => item.kind === 'movie');
    const series = catalog.filter((item) => item.kind === 'series');
    const discovered = await curatedHome(movies, series, undefined, homeQuery.language);
    const rows: Array<{ id: string; title: string; items: unknown[] }> = [...discovered.rows];
    if (profile) {
      const normalizedCatalog = await hasNormalizedCatalog();
      const [watch, favorites] = await Promise.all(normalizedCatalog ? [
        pool.query(`SELECT w.kind,p.provider_id AS id,p.provider_id AS "streamId",${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
            JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
            ORDER BY (title_lang.code=$2) DESC,(title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,
          COALESCE(tx.poster_url,t.poster_url) AS "posterUrl",t.backdrop_url AS "backdropUrl",w.position_seconds AS "positionSeconds",w.duration_seconds AS "durationSeconds"
          FROM watch_progress w JOIN sc_provider_streams p ON p.kind=w.kind AND p.provider_id=w.catalog_id AND p.active
          JOIN sc_titles t ON t.id=p.title_id LEFT JOIN sc_title_translations tx ON tx.title_id=t.id
            AND tx.language_id=(SELECT id FROM sc_languages WHERE code=$2)
          WHERE w.profile_id=$1 AND w.kind IN ('movie','episode') AND NOT w.completed ORDER BY w.updated_at DESC LIMIT 12`, [profile, homeQuery.language]),
        pool.query(`SELECT m.kind,p.provider_id AS id,${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
          JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
          ORDER BY (title_lang.code=$2) DESC,(title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,
          COALESCE(tx.poster_url,t.poster_url) AS "posterUrl" FROM my_list m
          JOIN sc_provider_streams p ON p.kind=m.kind AND p.provider_id=m.catalog_id AND p.active
          JOIN sc_titles t ON t.id=p.title_id LEFT JOIN sc_title_translations tx ON tx.title_id=t.id
            AND tx.language_id=(SELECT id FROM sc_languages WHERE code=$2)
          WHERE m.profile_id=$1 ORDER BY m.created_at DESC LIMIT 12`, [profile, homeQuery.language])
      ] : [
        pool.query(`SELECT c.kind,c.id,c.title,c.poster_url AS "posterUrl",w.position_seconds AS "positionSeconds",w.duration_seconds AS "durationSeconds" FROM watch_progress w JOIN catalog c ON c.kind=w.kind AND c.id=w.catalog_id WHERE w.profile_id=$1 AND w.kind IN ('movie','episode') AND NOT w.completed AND c.active ORDER BY w.updated_at DESC LIMIT 12`, [profile]),
        pool.query(`SELECT c.kind,c.id,c.title,c.poster_url AS "posterUrl" FROM my_list m JOIN catalog c ON c.kind=m.kind AND c.id=m.catalog_id WHERE m.profile_id=$1 AND c.active ORDER BY m.created_at DESC LIMIT 12`, [profile])
      ]);
      rows.unshift({ id: 'continue', title: 'Continue Watching', items: watch.rows }, { id: 'my-list', title: 'My List', items: favorites.rows });
    }
    return { featured: discovered.featured, discoverySource: discovered.source, attribution: discovered.source === 'tmdb', rows };
  });

  app.get('/api/v1/whats-new', async (request) => {
    const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
    if (!(await hasNormalizedCatalog())) return { rows: [] };
    const loadNewKind = async (kind: 'movie' | 'series' | 'episode') => {
      const { rows } = await pool.query(`WITH fresh AS (
        SELECT p.kind,p.provider_id AS id,p.provider_id AS streamid,p.title_id AS canonical_id,p.first_seen_at,t.tmdb_id,
          ${normalizedTitleSql(`COALESCE((SELECT x.display_title FROM sc_title_translations x JOIN sc_languages xl ON xl.id=x.language_id
            WHERE x.title_id=t.id AND x.source='tmdb' ORDER BY (xl.code=$2) DESC,(xl.code='en') DESC,x.language_id LIMIT 1),t.original_title)`)} AS title,
          COALESCE(NULLIF(tx.description,''),(SELECT x.description FROM sc_title_translations x JOIN sc_languages xl ON xl.id=x.language_id
            WHERE x.title_id=t.id AND NULLIF(x.description,'') IS NOT NULL
            ORDER BY CASE xl.code WHEN 'en' THEN 0 WHEN 'nl' THEN 1 WHEN 'pl' THEN 2 ELSE 3 END,x.language_id LIMIT 1)) AS description,
          COALESCE(tx.poster_url,t.poster_url) AS "posterUrl",t.backdrop_url AS "backdropUrl",t.release_year AS "releaseYear",t.rating,
          l.name AS language,l.code AS "languageCode",se.season_number AS "seasonNumber",se.episode_number AS "episodeNumber",
          COALESCE(ptx.display_title,pt.original_title) AS "seriesTitle",
          parent_stream.provider_id AS "seriesId",
          row_number() OVER(PARTITION BY p.title_id ORDER BY (l.code=$2) DESC,(l.code='en') DESC,p.first_seen_at DESC,p.provider_id) AS choice
        FROM sc_provider_streams p
        JOIN sc_catalog_import_runs r ON r.id=p.import_run_id AND r.status='success' AND r.finished_at>=now()-interval '7 days'
        JOIN sc_titles t ON t.id=p.title_id
        LEFT JOIN sc_title_translations tx ON tx.title_id=t.id AND tx.language_id=(SELECT id FROM sc_languages WHERE code=$2)
        LEFT JOIN sc_languages l ON l.id=p.language_id
        LEFT JOIN sc_series_episodes se ON se.episode_title_id=t.id
        LEFT JOIN sc_titles pt ON pt.id=se.series_title_id
        LEFT JOIN sc_title_translations ptx ON ptx.title_id=pt.id AND ptx.language_id=(SELECT id FROM sc_languages WHERE code=$2)
        LEFT JOIN LATERAL (SELECT sp.provider_id FROM sc_provider_streams sp LEFT JOIN sc_languages spl ON spl.id=sp.language_id
          WHERE sp.title_id=se.series_title_id AND sp.kind='series' AND sp.active
          ORDER BY (spl.code=$2) DESC,(spl.code='en') DESC,(spl.code='und') DESC,sp.provider_id LIMIT 1) parent_stream ON true
        WHERE p.provider_key='xtream' AND p.kind=$1 AND p.active
      )
      SELECT kind,id,streamid AS "streamId",canonical_id::text AS "canonicalId",title,description,"posterUrl","backdropUrl","releaseYear",rating,
        CASE WHEN kind='episode' THEN concat("seriesTitle",' · S',"seasonNumber",' E',"episodeNumber")
          ELSE (SELECT string_agg(DISTINCT g.name, ', ' ORDER BY g.name) FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=canonical_id) END AS genre,
        "seasonNumber","episodeNumber","seriesTitle","seriesId",jsonb_build_object('language',coalesce(language,'Unlabelled'),'languageCode',coalesce("languageCode",'und'),'tmdbId',tmdb_id) AS metadata,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p2.provider_id,'providerId',p2.provider_id,'language',l2.name,'languageCode',l2.code,'extension',p2.stream_extension)
          ORDER BY (l2.code=$2) DESC,(l2.code='en') DESC,p2.provider_id) FROM sc_provider_streams p2 LEFT JOIN sc_languages l2 ON l2.id=p2.language_id
          WHERE p2.title_id=canonical_id AND p2.kind=$1 AND p2.active),'[]'::jsonb) AS streams
      FROM fresh WHERE choice=1 ORDER BY first_seen_at DESC,title`, [kind, language]);
      return rows;
    };
    const [movies, series, episodes] = await Promise.all([loadNewKind('movie'), loadNewKind('series'), loadNewKind('episode')]);
    return { rows: [
      { id: 'new-movies', title: `${movies.length} New Movies This Week`, items: movies },
      { id: 'new-series', title: `${series.length} New Shows This Week`, items: series },
      { id: 'new-episodes', title: `${episodes.length} New Episodes This Week`, items: episodes }
    ].filter((group) => group.items.length) };
  });

  for (const [path, kind] of [['movies', 'movie'], ['series', 'series'], ['live', 'live']] as const) {
    app.get(`/api/v1/${path}`, async (request) => {
      const query = pageQuery.parse(request.query);
      const filters = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en'), country: z.string().regex(/^(?:[A-Z]{2,3}|other)$/i).optional(), excludeCategories: z.string().max(12000).optional() }).parse(request.query);
      const excludedCategories = kind === 'live' && filters.excludeCategories ? [...new Set(filters.excludeCategories.split(',').filter(Boolean))] : undefined;
      const items = await listCatalog(kind, query.page, query.limit, query.category, query.q || undefined, filters.language, filters.country?.toUpperCase() === 'OTHER' ? 'other' : filters.country?.toUpperCase(), excludedCategories);
      return { items, page: query.page, limit: query.limit, hasMore: items.length === query.limit };
    });
    app.get(`/api/v1/${path}/categories`, async (request) => {
      const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
      if (await hasNormalizedCatalog()) return { items: await listNormalizedCategories(kind, language) };
      const { rows } = await pool.query(`SELECT id,name FROM categories WHERE kind=$1 AND active=true ORDER BY name`, [kind]);
      return { items: rows };
    });
  }

  app.get('/api/v1/languages', async () => ({ items: await listAvailableLanguages() }));
  app.get('/api/v1/movies/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (await hasNormalizedCatalog()) {
      const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
      let item = await getNormalizedDetail('movie', id, language) as Record<string, any> | null;
      if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Movie not found.' } });
      const metadataLookup = await ensureTmdbTitleMetadata(item.canonicalId, 'movie', item.title, item.releaseYear);
      item = await getNormalizedDetail('movie', id, language) as Record<string, any> | null;
      if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Movie not found.' } });
      let descriptionLookup: 'available' | 'none' | 'unavailable' = item.description?.trim() ? 'available' : metadataLookup;
      if (!item.description?.trim()) {
        const credentials = await loadProvider(options.credentialKey);
        if (credentials) {
          const providerDescription = await loadProviderDescription('movie', id, credentials);
          if (providerDescription) {
            try { await saveProviderTitleDescription('movie', id, providerDescription); } catch (error) { app.log.warn(error, 'Could not save provider movie description'); }
            item.description = providerDescription;
            descriptionLookup = 'available';
          }
        }
      }
      return { ...item, descriptionStatus: item.description?.trim() ? 'available' : descriptionLookup };
    }
    const item = await getCatalog('movie', id);
    return item ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Movie not found.' } });
  });
  app.get('/api/v1/movies/:id/streams', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (await hasNormalizedCatalog()) {
      const detail = await getNormalizedDetail('movie', id) as Record<string, any> | null;
      return detail ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Movie or stream not found.' } });
    }
    const { rows } = await pool.query(`SELECT m.id AS "mediaId",m.title,m.original_title AS "originalTitle",m.release_year AS "releaseYear",
      m.description,m.poster_url AS "posterUrl",m.backdrop_url AS "backdropUrl",m.genre,m.rating,
      COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id',lang.id,'code',lang.code,'name',lang.name))
        FROM media_languages ml JOIN languages lang ON lang.id=ml.language_id WHERE ml.media_item_id=m.id),'[]'::jsonb) AS languages,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ps.provider_id,'extension',ps.stream_extension,'languages',
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',sl.id,'code',sl.code,'name',sl.name)) FROM stream_languages x JOIN languages sl ON sl.id=x.language_id WHERE x.stream_id=ps.id),'[]'::jsonb),
        'categories',COALESCE((SELECT jsonb_agg(DISTINCT cv.name) FROM stream_categories sc JOIN categories_v2 cv ON cv.id=sc.category_id WHERE sc.stream_id=ps.id),'[]'::jsonb))
        ORDER BY ps.provider_id) FROM provider_streams ps WHERE ps.media_item_id=m.id AND ps.kind='movie' AND ps.active),'[]'::jsonb) AS streams
      FROM provider_streams selected JOIN media_items m ON m.id=selected.media_item_id
      WHERE selected.kind='movie' AND selected.provider_id=$1 AND selected.active LIMIT 1`, [id]);
    return rows[0] ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Movie or stream not found.' } });
  });
  app.get('/api/v1/series/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (await hasNormalizedCatalog()) {
      const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
      let item = await getNormalizedDetail('series', id, language) as Record<string, any> | null;
      if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Series not found.' } });
      const descriptionLookup = await ensureTmdbTitleMetadata(item.canonicalId, 'series', item.title, item.releaseYear);
      item = await getNormalizedDetail('series', id, language) as Record<string, any> | null;
      if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Series not found.' } });
      return { ...item, descriptionStatus: item.description?.trim() ? 'available' : descriptionLookup };
    }
    const item = await getCatalog('series', id);
    return item ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Series not found.' } });
  });
  app.get('/api/v1/series/:id/seasons', async (request) => {
    const { id } = idParam.parse(request.params);
    if (await hasNormalizedCatalog()) return { seasons: await listNormalizedSeasons(id) };
    const { rows } = await pool.query(`SELECT season_number AS number,count(*)::integer AS count FROM catalog WHERE kind='episode' AND parent_id=$1 AND active=true GROUP BY season_number ORDER BY season_number`, [id]);
    return { seasons: rows };
  });
  app.get('/api/v1/series/:id/seasons/:season/episodes', async (request) => {
    const params = z.object({ id: z.string().regex(/^\d+$/), season: z.coerce.number().int().min(0) }).parse(request.params);
    const query = pageQuery.parse(request.query);
    if (await hasNormalizedCatalog()) {
      const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
      const series = await getNormalizedSeriesTitle(params.id);
      if (series) {
        const metadataLanguages = (await pool.query<{ code: string }>(
          `SELECT code FROM sc_languages WHERE code=ANY($1::text[])`, [['en', 'nl', 'pl']])).rows.map((row) => row.code);
        if (metadataLanguages.length === 0) metadataLanguages.push(language);
        await Promise.all(metadataLanguages.map((code) => ensureTmdbSeasonMetadata(series.id, params.season, code)));
      }
      const items = await listNormalizedEpisodes(params.id, params.season, query.page, query.limit, language);
      return { items, page: query.page, hasMore: items.length === query.limit };
    }
    const { rows } = await pool.query(`SELECT kind,id,title,description,poster_url AS "posterUrl",season_number AS "seasonNumber",episode_number AS "episodeNumber",duration_seconds AS "durationSeconds" FROM catalog WHERE kind='episode' AND parent_id=$1 AND season_number=$2 AND active=true ORDER BY episode_number,id LIMIT $3 OFFSET $4`,
      [params.id, params.season, query.limit, (query.page - 1) * query.limit]);
    return { items: rows, page: query.page, hasMore: rows.length === query.limit };
  });
  app.get('/api/v1/episodes/:id/streams', async (request) => {
    const { id } = idParam.parse(request.params);
    const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
    if (!(await hasNormalizedCatalog())) return { items: [{ id, providerId: id }] };
    return { items: await listNormalizedEpisodeStreams(id, language) };
  });
  app.get('/api/v1/search', async (request) => {
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(2).max(80).default(20),
      q: z.string().trim().min(2).max(100), language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query);
    const each = Math.max(1, Math.floor(query.limit / 2));
    const [movies, series] = await Promise.all([listCatalog('movie', query.page, each, undefined, query.q, query.language), listCatalog('series', query.page, each, undefined, query.q, query.language)]);
    return { movies, series, page: query.page, hasMore: movies.length === each || series.length === each };
  });

  app.get('/api/v1/profiles', async (request) => {
    const { rows } = await pool.query('SELECT id,name,preferences FROM profiles WHERE device_id=$1 ORDER BY created_at', [deviceId(request)]);
    return { items: rows };
  });
  app.post('/api/v1/profiles', async (request, reply) => {
    const { name } = profileName.parse(request.body);
    const id = randomUUID();
    await pool.query('INSERT INTO profiles(id,device_id,name) VALUES($1,$2,$3)', [id, deviceId(request), name]);
    return reply.code(201).send({ id, name });
  });
  app.get('/api/v1/profiles/:id/continue-watching', async (request, reply) => {
    const { id } = profileParam.parse(request.params);
    if (!(await profileBelongsToDevice(id, deviceId(request)))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
    const normalized = await hasNormalizedCatalog();
    const { rows } = await pool.query(normalized
      ? `SELECT w.kind,p.provider_id AS id,${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
            JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
            ORDER BY (title_lang.code=$2) DESC,(title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,
          COALESCE(tx.poster_url,t.poster_url) AS "posterUrl",t.backdrop_url AS "backdropUrl",
          w.position_seconds AS "positionSeconds",w.duration_seconds AS "durationSeconds",w.catalog_id AS "streamId"
        FROM watch_progress w JOIN sc_provider_streams p ON p.kind=w.kind AND p.provider_id=w.catalog_id AND p.active
        JOIN sc_titles t ON t.id=p.title_id LEFT JOIN sc_title_translations tx ON tx.title_id=t.id AND tx.language_id=(SELECT id FROM sc_languages WHERE code=$2)
        WHERE w.profile_id=$1 AND NOT w.completed ORDER BY w.updated_at DESC LIMIT 20`
      : `SELECT w.kind,w.catalog_id AS id,w.catalog_id AS "streamId",w.position_seconds AS "positionSeconds",w.duration_seconds AS "durationSeconds",c.title,c.poster_url AS "posterUrl" FROM watch_progress w JOIN catalog c ON c.kind=w.kind AND c.id=w.catalog_id WHERE w.profile_id=$1 AND NOT w.completed AND c.active ORDER BY w.updated_at DESC LIMIT 20`, normalized ? [id, language] : [id]);
    return { items: rows };
  });
  app.get('/api/v1/profiles/:id/my-list', async (request, reply) => {
    const { id } = profileParam.parse(request.params);
    if (!(await profileBelongsToDevice(id, deviceId(request)))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const language = z.object({ language: z.string().regex(/^[a-z]{2}$/).default('en') }).parse(request.query).language;
    const normalized = await hasNormalizedCatalog();
    const { rows } = await pool.query(normalized
      ? `SELECT m.kind,p.provider_id AS id,${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
            JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
            ORDER BY (title_lang.code=$2) DESC,(title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,COALESCE(tx.poster_url,t.poster_url) AS "posterUrl"
        FROM my_list m JOIN sc_provider_streams p ON p.kind=m.kind AND p.provider_id=m.catalog_id AND p.active
        JOIN sc_titles t ON t.id=p.title_id LEFT JOIN sc_title_translations tx ON tx.title_id=t.id AND tx.language_id=(SELECT id FROM sc_languages WHERE code=$2)
        WHERE m.profile_id=$1 ORDER BY m.created_at DESC LIMIT 20`
      : `SELECT c.kind,c.id,c.title,c.poster_url AS "posterUrl" FROM my_list m JOIN catalog c ON c.kind=m.kind AND c.id=m.catalog_id WHERE m.profile_id=$1 AND c.active ORDER BY m.created_at DESC LIMIT 20`, normalized ? [id, language] : [id]);
    return { items: rows };
  });
  app.post('/api/v1/profiles/:id/my-list', async (request, reply) => {
    const { id: profileId } = profileParam.parse(request.params);
    if (!(await profileBelongsToDevice(profileId, deviceId(request)))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const body = listInput.parse(request.body);
    if (body.saved) await pool.query(`INSERT INTO my_list(profile_id,kind,catalog_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [profileId, body.kind, body.id]);
    else await pool.query(`DELETE FROM my_list WHERE profile_id=$1 AND kind=$2 AND catalog_id=$3`, [profileId, body.kind, body.id]);
    return { saved: body.saved };
  });
  app.post('/api/v1/profiles/:id/progress', async (request, reply) => {
    const { id: profileId } = profileParam.parse(request.params);
    if (!(await profileBelongsToDevice(profileId, deviceId(request)))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const body = progressInput.parse(request.body);
    await pool.query(`INSERT INTO watch_progress(profile_id,kind,catalog_id,position_seconds,duration_seconds,completed)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(profile_id,kind,catalog_id) DO UPDATE SET position_seconds=EXCLUDED.position_seconds,
      duration_seconds=EXCLUDED.duration_seconds,completed=EXCLUDED.completed,updated_at=now()`,
    [profileId, body.kind, body.id, body.positionSeconds, body.durationSeconds ?? null, body.completed]);
    return { saved: true };
  });
  app.post('/api/v1/playback/resolve', async (request, reply) => {
    const body = playbackInput.parse(request.body);
    const item = await getCatalog(body.kind, body.id);
    if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Stream not found.' } });
    if (item.resolvedSourceUrl) return { url: item.resolvedSourceUrl, format: body.format ?? item.streamExtension ?? 'm3u8', cached: true };
    const credentials = await loadProvider(options.credentialKey);
    if (!credentials) return reply.code(503).send({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Provider is not configured.' } });
    if (body.kind === 'live' && body.format && credentials.allowedLiveFormats?.length && !credentials.allowedLiveFormats.includes(body.format)) {
      return reply.code(422).send({ error: { code: 'FORMAT_UNAVAILABLE', message: 'The provider does not support this live format.' } });
    }
    const url = playbackUrl(credentials, item, body.format);
    return { url, format: body.format ?? item.streamExtension ?? 'm3u8' };
  });
  app.post('/api/v1/playback/remux-ticket', async (request, reply) => {
    const body = z.object({ kind: z.enum(['movie', 'episode']), id: z.string().regex(/^\d+$/), transcode: z.boolean().default(false) }).parse(request.body);
    const item = await getCatalog(body.kind, body.id);
    if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Stream not found.' } });
    const expires = Math.floor(Date.now() / 1000) + 300;
    const payload = Buffer.from(JSON.stringify({ kind: body.kind, id: body.id, device: deviceId(request), expires, transcode: body.transcode })).toString('base64url');
    const signature = createHmac('sha256', options.credentialKey).update(payload).digest('base64url');
    return { url: `/api/v1/playback/remux/${body.kind}/${body.id}?ticket=${payload}.${signature}` };
  });
  app.get('/api/v1/playback/remux/:kind/:id', async (request, reply) => {
    const params = z.object({ kind: z.enum(['movie', 'episode']), id: z.string().regex(/^\d+$/) }).parse(request.params);
    const { ticket } = z.object({ ticket: z.string().max(1024) }).parse(request.query);
    const [payload, supplied] = ticket.split('.');
    if (!payload || !supplied) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Playback ticket is invalid.' } });
    const expected = createHmac('sha256', options.credentialKey).update(payload).digest();
    let actual: Buffer;
    try { actual = Buffer.from(supplied, 'base64url'); } catch { return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Playback ticket is invalid.' } }); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Playback ticket is invalid.' } });
    let claims: { kind: string; id: string; device: string; expires: number; transcode?: boolean };
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims; }
    catch { return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Playback ticket is invalid.' } }); }
    if (claims.kind !== params.kind || claims.id !== params.id || claims.expires < Math.floor(Date.now() / 1000) ||
      !/^[0-9a-f-]{36}$/i.test(claims.device)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Playback ticket is expired or invalid.' } });
    }
    const item = await getCatalog(params.kind, params.id);
    if (!item) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Stream not found.' } });
    const extension = (item.streamExtension ?? '').toLowerCase().replace(/^\./, '');
    if (!['mkv', 'avi', 'wmv', 'flv', 'mov', 'ts', 'mpeg', 'mpg'].includes(extension)) {
      return reply.code(415).send({ error: { code: 'REMUX_NOT_REQUIRED', message: 'This stream should play directly.' } });
    }
    const credentials = await loadProvider(options.credentialKey);
    if (!credentials) return reply.code(503).send({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Provider is not configured.' } });
    if (activeRemuxJobs >= 2) return reply.code(503).send({ error: { code: 'REMUX_BUSY', message: 'All video conversion slots are in use. Try again shortly.' } });
    if (claims.transcode && activeTranscodeJobs >= 1) return reply.code(503).send({ error: { code: 'TRANSCODE_BUSY', message: 'The compatibility converter is currently in use. Try again shortly.' } });
    const url = playbackUrl(credentials, item);
    const upstream = new AbortController();
    let response: Response;
    try {
      response = await fetch(url, { signal: upstream.signal, headers: { accept: '*/*' }, redirect: 'follow' });
    } catch (error) {
      app.log.warn({ err: error }, 'Remux source request failed before streaming');
      return reply.code(502).send({ error: { code: 'REMUX_SOURCE_FAILED', message: 'The provider could not start this stream.' } });
    }
    if (!response.ok || !response.body) {
      app.log.warn({ statusCode: response.status }, 'Remux provider returned an unsuccessful response');
      await response.body?.cancel().catch(() => undefined);
      return reply.code(502).send({ error: { code: 'REMUX_SOURCE_FAILED', message: 'The provider could not start this stream.' } });
    }
    activeRemuxJobs += 1;
    if (claims.transcode) activeTranscodeJobs += 1;
    const videoCodecArgs = claims.transcode
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'copy'];
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a?',
      ...videoCodecArgs, '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2000); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') app.log.warn({ code: error.code }, 'Remux input stream ended unexpectedly');
      upstream.abort();
    });
    request.raw.once('aborted', () => upstream.abort());
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) upstream.abort(); child.kill('SIGKILL'); });
    void (async () => {
      try {
        for await (const chunk of response.body!) {
          if (upstream.signal.aborted || child.stdin.destroyed) break;
          if (!child.stdin.write(Buffer.from(chunk))) await new Promise<void>((resolve) => child.stdin.once('drain', resolve));
        }
        if (!child.stdin.destroyed) child.stdin.end();
      } catch (error) {
        if (!upstream.signal.aborted) app.log.warn({ err: error }, 'Remux provider stream ended unexpectedly');
        upstream.abort();
        child.stdin.destroy();
      }
    })();
    child.on('error', (error) => { app.log.error({ err: error }, 'FFmpeg remux failed to start'); });
    child.on('close', (code) => {
      activeRemuxJobs = Math.max(0, activeRemuxJobs - 1);
      if (claims.transcode) activeTranscodeJobs = Math.max(0, activeTranscodeJobs - 1);
      if (code !== 0 && !upstream.signal.aborted) app.log.warn({ code, detail: stderr }, 'FFmpeg remux ended with an error');
    });
    const outputReady = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      child.stdout.once('data', (chunk: Buffer) => { clearTimeout(timer); child.stdout.pause(); child.stdout.unshift(chunk); resolve(true); });
      child.once('error', () => { clearTimeout(timer); resolve(false); });
      child.once('close', () => { clearTimeout(timer); resolve(false); });
    });
    if (!outputReady) {
      upstream.abort(); child.kill('SIGKILL');
      app.log.warn({ detail: stderr }, 'FFmpeg could not produce playable output');
      return reply.code(502).send({ error: { code: 'REMUX_FAILED', message: 'The server could not convert this stream.' } });
    }
    reply.header('Content-Type', 'video/mp4');
    reply.header('Cache-Control', 'no-store');
    reply.header('Accept-Ranges', 'none');
    return reply.send(child.stdout);
  });
  return app;
}
