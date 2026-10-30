import { pool, loadProvider } from './database.js';
import { mapCatalogItem, mapEpisodes, providerPlaybackInfo, requestProvider, type ProviderCredentials, type CatalogRecord } from './provider.js';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type CatalogRefreshState = {
  status: 'idle' | 'running' | 'success' | 'error';
  phase: string;
  processed: number;
  total: number;
  added: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
};

const state: CatalogRefreshState = { status: 'idle', phase: 'Idle', processed: 0, total: 0, added: 0 };
const refreshLockId = 190086;
const datasets = [
  { kind: 'live', categories: 'get_live_categories', streams: 'get_live_streams' },
  { kind: 'movie', categories: 'get_vod_categories', streams: 'get_vod_streams' },
  { kind: 'series', categories: 'get_series_categories', streams: 'get_series' }
] as const;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const objectList = (value: unknown, action: string): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) throw new Error(`Provider response for ${action} was not a list; existing catalog was kept.`);
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
};
async function retry<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await work(); } catch (error) { last = error; if (attempt < 2) await pause(1000 * (2 ** attempt)); }
  }
  throw last;
}
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function providerTmdbId(raw: Record<string, unknown>): string | null {
  const info = asObject(raw.info);
  const id = String(raw.tmdb ?? raw.tmdb_id ?? info.tmdb_id ?? info.tmdb ?? '').trim();
  return /^\d+$/.test(id) ? id : null;
}
function languageCode(record: CatalogRecord, raw: Record<string, unknown>, categoryName: string): string {
  const info = asObject(raw.info);
  const language = String(info.language ?? record.metadata?.language ?? '').trim().toLowerCase();
  const aliases: Record<string, string> = { nl: 'nl', ned: 'nl', dutch: 'nl', nederlands: 'nl', en: 'en', eng: 'en', english: 'en',
    pl: 'pl', pol: 'pl', polish: 'pl', polski: 'pl', de: 'de', ger: 'de', german: 'de', deutsch: 'de', fr: 'fr', fre: 'fr', french: 'fr', francais: 'fr',
    es: 'es', spa: 'es', spanish: 'es', it: 'it', ita: 'it', italian: 'it', pt: 'pt', por: 'pt', portuguese: 'pt', ru: 'ru', rus: 'ru', russian: 'ru',
    ar: 'ar', ara: 'ar', arabic: 'ar', tr: 'tr', tur: 'tr', turkish: 'tr', hi: 'hi', hin: 'hi', hindi: 'hi' };
  if (typeof record.metadata?.languageCode === 'string' && record.metadata.languageCode) return record.metadata.languageCode;
  if (aliases[language]) return aliases[language];
  const source = `${categoryName} ${String(record.metadata?.rawTitle ?? record.title)}`.toUpperCase();
  for (const code of ['nl', 'en', 'pl', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar', 'tr', 'hi']) {
    const names: Record<string, string> = { nl: 'NED|DUTCH', en: 'ENG|ENGLISH', pl: 'POL|POLISH', de: 'GER|GERMAN', fr: 'FRE|FRENCH', es: 'SPA|SPANISH',
      it: 'ITA|ITALIAN', pt: 'POR|PORTUGUESE', ru: 'RUS|RUSSIAN', ar: 'ARA|ARABIC', tr: 'TUR|TURKISH', hi: 'HIN|HINDI' };
    if (new RegExp(`(^|[^A-Z])(${code.toUpperCase()}|${names[code]})([^A-Z]|$)`).test(source)) return code;
  }
  return 'und';
}
function titleKey(record: CatalogRecord, raw: Record<string, unknown>, parentKey?: string): string {
  if (record.kind === 'episode') return record.seasonNumber && record.episodeNumber
    ? `episode:${parentKey}:s${record.seasonNumber}:e${record.episodeNumber}` : `episode:provider:${record.id}`;
  if (record.kind === 'live') return `live:provider:${record.id}`;
  const tmdbId = providerTmdbId(raw);
  return tmdbId ? `${record.kind}:tmdb:${tmdbId}` : `${record.kind}:provider:${record.id}`;
}
function playbackTemplate(provider: ProviderCredentials, kind: CatalogRecord['kind'], id: string, extension?: string): string {
  const base = provider.playbackBaseUrl ?? provider.baseUrl;
  const pathKind = kind === 'episode' ? 'series' : kind;
  return `${base.replace(/\/+$/, '')}/${pathKind}/{username}/{password}/${id}.${extension || (kind === 'live' ? provider.allowedLiveFormats?.[0] ?? 'm3u8' : 'mp4')}`;
}
async function upsertTitle(record: CatalogRecord, raw: Record<string, unknown>, key: string, language: string): Promise<string> {
  const tmdbId = record.kind === 'movie' || record.kind === 'series' ? providerTmdbId(raw) : null;
  const metadata = record.genre ? { provider_genre: record.genre } : {};
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO sc_titles(kind,canonical_key,tmdb_id,release_year,original_title,poster_url,backdrop_url,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT(canonical_key) DO UPDATE SET tmdb_id=COALESCE(sc_titles.tmdb_id,EXCLUDED.tmdb_id),release_year=COALESCE(sc_titles.release_year,EXCLUDED.release_year),
      poster_url=COALESCE(sc_titles.poster_url,EXCLUDED.poster_url),backdrop_url=COALESCE(sc_titles.backdrop_url,EXCLUDED.backdrop_url),metadata=sc_titles.metadata||EXCLUDED.metadata,updated_at=now()
    RETURNING id::text`, [record.kind, key, tmdbId, record.releaseYear ?? null, record.title, record.posterUrl ?? null, record.backdropUrl ?? null, JSON.stringify(metadata)]);
  const titleId = rows[0].id;
  const description = record.description ?? null;
  await pool.query(`INSERT INTO sc_title_translations(title_id,language_id,display_title,description,poster_url,source)
    SELECT $1,id,$2,$3,$4,'provider' FROM sc_languages WHERE code=$5
    ON CONFLICT(title_id,language_id) DO UPDATE SET
      display_title=CASE WHEN sc_title_translations.source='provider' THEN EXCLUDED.display_title ELSE sc_title_translations.display_title END,
      description=COALESCE(sc_title_translations.description,EXCLUDED.description),poster_url=COALESCE(sc_title_translations.poster_url,EXCLUDED.poster_url),updated_at=now()`,
    [titleId, record.title, description, record.posterUrl ?? null, language]);
  if (record.kind === 'movie' || record.kind === 'series') {
    const genreNames = (record.genre ?? '').split(',').map((name) => name.trim().replace(/^[\["']+|[\]"']+$/g, '')).filter(Boolean);
    for (const genre of genreNames) {
      await pool.query(`INSERT INTO sc_genres(source,name) VALUES('provider',$1) ON CONFLICT(source,name) DO NOTHING`, [genre]);
      await pool.query(`INSERT INTO sc_title_genres(title_id,genre_id) SELECT $1,id FROM sc_genres WHERE source='provider' AND name=$2 ON CONFLICT DO NOTHING`, [titleId, genre]);
    }
  }
  return titleId;
}
async function upsertStream(record: CatalogRecord, raw: Record<string, unknown>, titleId: string, provider: ProviderCredentials, language: string,
  categoryName: string, startedAt: string, importRunId?: string): Promise<string> {
  const categoryId = record.categoryId || '__uncategorised__';
  const name = categoryName || (record.categoryId ? record.categoryId : 'Uncategorised');
  const lang = await pool.query<{ id: number }>('SELECT id FROM sc_languages WHERE code=$1', [language]);
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO sc_provider_streams(provider_key,kind,provider_id,title_id,parent_provider_id,language_id,provider_name,stream_extension,
    playback_path_template,active,first_seen_at,last_seen_at,import_run_id)
    VALUES('xtream',$1,$2,$3,$4,$5,$6,$7,$8,true,$9::timestamptz,$9::timestamptz,$10)
    ON CONFLICT(provider_key,kind,provider_id) DO UPDATE SET title_id=EXCLUDED.title_id,parent_provider_id=EXCLUDED.parent_provider_id,language_id=EXCLUDED.language_id,
      provider_name=EXCLUDED.provider_name,stream_extension=EXCLUDED.stream_extension,playback_path_template=EXCLUDED.playback_path_template,active=true,last_seen_at=EXCLUDED.last_seen_at
    RETURNING id::text`, [record.kind, record.id, titleId, record.parentId ?? null, lang.rows[0]?.id ?? null,
    String(raw.name ?? record.title), record.streamExtension ?? null, playbackTemplate(provider, record.kind, record.id, record.streamExtension), startedAt, importRunId ?? null]);
  const streamId = rows[0].id;
  await pool.query('DELETE FROM sc_stream_categories WHERE stream_id=$1', [streamId]);
  if (record.kind !== 'episode') {
    const { rows: categories } = await pool.query<{ id: string }>(`INSERT INTO sc_categories(provider_key,kind,provider_category_id,name)
      VALUES('xtream',$1,$2,$3) ON CONFLICT(provider_key,kind,provider_category_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id::text`,
      [record.kind, categoryId, name]);
    await pool.query('INSERT INTO sc_stream_categories(stream_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [streamId, categories[0].id]);
    await pool.query(`INSERT INTO sc_category_languages(category_id,language_id) SELECT $1,id FROM sc_languages WHERE code=$2 ON CONFLICT DO NOTHING`, [categories[0].id, language]);
  }
  return streamId;
}
async function refreshNormalizedCatalog(key: Buffer): Promise<void> {
  const client = await pool.connect();
  const startedAt = new Date().toISOString();
  try {
    const locked = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [refreshLockId]);
    if (!locked.rows[0]?.locked) throw new Error('A catalog sync is already running.');
    try {
      const provider = await loadProvider(key);
      if (!provider) throw new Error('Add Xtream provider credentials in Settings before refreshing the catalog.');
      state.phase = 'Checking provider connection';
      let playback = {} as ReturnType<typeof providerPlaybackInfo>;
      try { playback = providerPlaybackInfo(provider, await retry(() => requestProvider(provider, ''))); }
      catch { playback = { allowedLiveFormats: [] }; }
      provider.playbackBaseUrl = playback.playbackBaseUrl ?? provider.playbackBaseUrl;
      provider.allowedLiveFormats = playback.allowedLiveFormats;
      await pool.query(`UPDATE provider_config SET playback_base_url=$1,allowed_live_formats=$2 WHERE id='primary'`,
        [provider.playbackBaseUrl ?? null, JSON.stringify(playback.allowedLiveFormats)]).catch(() => undefined);

      const allSeries: Array<{ id: string; canonicalKey: string; language: string }> = [];
      for (const dataset of datasets) {
        state.phase = `Loading ${dataset.kind} categories and streams`;
        const categories = objectList(await retry(() => requestProvider(provider, dataset.categories)), dataset.categories);
        const categoryNames = new Map(categories.map((row) => [String(row.category_id ?? ''), String(row.category_name ?? row.name ?? row.category_id ?? 'Uncategorised')]));
        const rawItems = objectList(await retry(() => requestProvider(provider, dataset.streams)), dataset.streams);
        if (!rawItems.length) throw new Error(`Provider returned an empty ${dataset.kind} list; existing data was left unchanged.`);
        const knownResult = await pool.query<{ provider_id: string }>(`SELECT provider_id FROM sc_provider_streams WHERE provider_key='xtream' AND kind=$1`, [dataset.kind]);
        const knownIds = new Set(knownResult.rows.map((row) => row.provider_id));
        let validCount = 0;
        state.total += rawItems.length;
        for (let offset = 0; offset < rawItems.length; offset += 100) {
          for (const raw of rawItems.slice(offset, offset + 100)) {
            const record = mapCatalogItem(dataset.kind, raw);
            if (!record) continue;
            validCount++;
            if (knownIds.has(record.id)) {
              if (record.kind === 'series') allSeries.push({ id: record.id, canonicalKey: titleKey(record, raw), language: languageCode(record, raw, categoryNames.get(record.categoryId ?? '') ?? '') });
              continue;
            }
            const categoryName = categoryNames.get(record.categoryId ?? '') ?? 'Uncategorised';
            const lang = languageCode(record, raw, categoryName);
            const keyForTitle = titleKey(record, raw);
            const titleId = await upsertTitle(record, raw, keyForTitle, lang);
            await upsertStream(record, raw, titleId, provider, lang, categoryName, startedAt);
            knownIds.add(record.id);
            if (record.kind === 'series') allSeries.push({ id: record.id, canonicalKey: keyForTitle, language: lang });
            state.added++;
          }
          state.processed += rawItems.slice(offset, offset + 100).length;
        }
        if (!validCount) throw new Error(`No valid ${dataset.kind} records; existing data was left unchanged.`);
      }

      state.total += allSeries.length;
      const knownEpisodeResult = await pool.query<{ provider_id: string }>(`SELECT provider_id FROM sc_provider_streams WHERE provider_key='xtream' AND kind='episode'`);
      const knownEpisodeIds = new Set(knownEpisodeResult.rows.map((row) => row.provider_id));
      for (let index = 0; index < allSeries.length; index++) {
        const series = allSeries[index];
        state.phase = `Checking episodes (${index + 1} of ${allSeries.length} series)`;
        const detailsValue = await retry(() => requestProvider(provider, 'get_series_info', { series_id: series.id }, 45_000));
        if (!detailsValue || typeof detailsValue !== 'object' || Array.isArray(detailsValue)) throw new Error(`Provider returned invalid episode details for series ${series.id}; earlier catalog data is retained.`);
        const episodeRecords = mapEpisodes(series.id, detailsValue as Record<string, unknown>);
        for (const episode of episodeRecords) {
          if (knownEpisodeIds.has(episode.id)) continue;
          const raw = { id: episode.id };
          const keyForTitle = titleKey(episode, raw, series.canonicalKey);
          const titleId = await upsertTitle(episode, raw, keyForTitle, series.language);
          await upsertStream(episode, raw, titleId, provider, series.language, '', startedAt);
          await pool.query(`INSERT INTO sc_series_episodes(episode_title_id,series_title_id,season_number,episode_number)
            SELECT $1,id,$3,$4 FROM sc_titles WHERE canonical_key=$2
            ON CONFLICT(episode_title_id) DO UPDATE SET series_title_id=EXCLUDED.series_title_id,season_number=EXCLUDED.season_number,episode_number=EXCLUDED.episode_number`,
            [titleId, series.canonicalKey, episode.seasonNumber ?? 0, episode.episodeNumber ?? 0]);
          knownEpisodeIds.add(episode.id);
          state.added++;
        }
        state.processed++;
        if (index < allSeries.length - 1) await pause(150);
      }
      const categorySql = await (await import('node:fs/promises')).readFile(new URL('../database/007_normalized_categories.sql', import.meta.url), 'utf8');
      await pool.query(categorySql);
      state.status = 'success'; state.phase = 'Refresh complete'; state.finishedAt = new Date().toISOString();
      state.message = `Refresh complete. ${state.added.toLocaleString()} new stream entries were added after scanning provider lists and series details.`;
    } finally { await client.query('SELECT pg_advisory_unlock($1)', [refreshLockId]); }
  } catch (error) {
    state.status = 'error'; state.phase = 'Refresh failed'; state.finishedAt = new Date().toISOString();
    state.message = error instanceof Error ? error.message.slice(0, 300) : 'Catalog refresh failed.';
  } finally { client.release(); }
}

type PlaylistEntry = { kind: 'live' | 'movie' | 'episode'; id: string; name: string; group: string; poster?: string;
  extension?: string; year?: number; parentName?: string; seasonNumber?: number; episodeNumber?: number; language: string };
function normalizedProviderTitle(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^\s*\|?\s*(NL|NED|DUTCH|EN|ENG|ENGLISH|PL|POL|POLISH|DE|GER|GERMAN|FR|FRE|FRENCH|ES|SPA|SPANISH|IT|ITA|ITALIAN|PT|POR|RU|RUS|AR|ARA|TR|TUR|HI|HIN)\s*[-:|]\s*/i, '')
    .replace(/\s+S\d{1,3}\s*E\d{1,3}.*$/i, '').replace(/\s*\([^)]*\)/g, '')
    .replace(/\b(4K|UHD|FHD|HD|SD|1080P|720P|2160P)\b/ig, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}
function playlistAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}
function playlistLanguage(...values: string[]): string {
  const source = values.join(' ').toUpperCase();
  for (const [pattern, code] of [[/(^|[^A-Z])(NL|NED|DUTCH)([^A-Z]|$)/, 'nl'], [/(^|[^A-Z])(EN|ENG|ENGLISH)([^A-Z]|$)/, 'en'],
    [/(^|[^A-Z])(PL|POL|POLISH)([^A-Z]|$)/, 'pl'], [/(^|[^A-Z])(DE|GER|GERMAN)([^A-Z]|$)/, 'de'],
    [/(^|[^A-Z])(FR|FRE|FRENCH)([^A-Z]|$)/, 'fr']] as Array<[RegExp, string]>) if (pattern.test(source)) return code;
  return 'und';
}
function cleanPlaylistTitle(value: string): string {
  return value.trim().replace(/^\s*\|?\s*(NL|NED|DUTCH|EN|ENG|ENGLISH|PL|POL|POLISH|DE|GER|GERMAN|FR|FRE|FRENCH|ES|SPA|SPANISH|IT|ITA|ITALIAN|PT|POR|RU|RUS|AR|ARA|TR|TUR|HI|HIN)\s*[-:|]\s*/i, '')
    .replace(/\s*\((?:US|GB|UK|PL|NL|EN|DE|FR|ES|IT|CA|AU|MULTI\s*SUB|POLISH\s*MULTI\s*SUB|DUTCH\s*MULTI\s*SUB)\)\s*$/i, '')
    .replace(/\s*\(((?:19|20)\d{2})\)\s*$/, '').replace(/\b(4K|UHD|FHD|HD|SD|1080P|720P|2160P)\b/ig, '').replace(/\s+/g, ' ').trim();
}
function safePlaylistArtwork(value: string | undefined, provider: ProviderCredentials): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const pathParts = url.pathname.split('/').map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
    if (pathParts.some((part) => part === provider.username || part === provider.password)) return undefined;
    return url.toString();
  } catch { return undefined; }
}
function parsePlaylistEntry(extinf: string, streamUrl: string, provider: ProviderCredentials): PlaylistEntry | null {
  try {
    const url = new URL(streamUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const first = parts[0]?.toLowerCase();
    const kind: PlaylistEntry['kind'] = first === 'movie' ? 'movie' : first === 'series' ? 'episode' : 'live';
    const file = parts.at(-1) ?? '';
    const match = file.match(/^(\d+)(?:\.([a-z0-9]{2,5}))?$/i);
    if (!match) return null;
    const attrs = playlistAttrs(extinf);
    const fallbackName = extinf.slice(extinf.lastIndexOf(',') + 1).trim();
    const name = attrs['tvg-name']?.trim() || fallbackName;
    if (!name) return null;
    let parentName: string | undefined;
    let seasonNumber: number | undefined;
    let episodeNumber: number | undefined;
    if (kind === 'episode') {
      const episodeMatch = name.match(/\s+S(\d{1,3})\s*E(\d{1,3})\b/i);
      if (episodeMatch) { parentName = name.slice(0, episodeMatch.index).trim(); seasonNumber = Number(episodeMatch[1]); episodeNumber = Number(episodeMatch[2]); }
    }
    const yearMatch = name.match(/\(((?:19|20)\d{2})\)/);
    return { kind, id: match[1], name, group: attrs['group-title']?.trim() || 'Uncategorised',
      poster: safePlaylistArtwork(attrs['tvg-logo'], provider), extension: match[2]?.toLowerCase() || (kind === 'live' ? 'ts' : undefined),
      year: yearMatch ? Number(yearMatch[1]) : undefined, parentName, seasonNumber, episodeNumber,
      language: playlistLanguage(name, attrs['group-title'] ?? '') };
  } catch { return null; }
}
async function downloadPlaylist(provider: ProviderCredentials, path: string): Promise<void> {
  const url = new URL('get.php', `${provider.baseUrl.replace(/\/+$/, '')}/`);
  url.search = new URLSearchParams({ username: provider.username, password: provider.password, type: 'm3u_plus', output: 'ts' }).toString();
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000), redirect: 'error' }); }
  catch { throw new Error('The provider playlist could not be downloaded.'); }
  if (!response.ok || !response.body) throw new Error(`Provider playlist returned HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 512 * 1024 * 1024) throw new Error('Provider playlist exceeded the 512 MB safety limit.');
  let bytes = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > 512 * 1024 * 1024 ? new Error('Provider playlist exceeded the 512 MB safety limit.') : null, chunk);
  } });
  try { await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), limit, createWriteStream(path, { mode: 0o600 })); }
  catch { throw new Error('The provider playlist download was interrupted.'); }
}
async function refreshFromM3U(key: Buffer, suppliedPlaylistPath?: string): Promise<void> {
  const client = await pool.connect();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const tempDir = suppliedPlaylistPath ? undefined : await mkdtemp(join(tmpdir(), 'nightowl-playlist-'));
  const playlistPath = suppliedPlaylistPath ?? join(tempDir!, 'catalog.m3u');
  let runCreated = false;
  try {
    const locked = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [refreshLockId]);
    if (!locked.rows[0]?.locked) throw new Error('A catalog sync is already running.');
    try {
      const provider = await loadProvider(key);
      if (!provider) throw new Error('Add Xtream provider credentials in Settings before refreshing the catalog.');
      state.phase = 'Downloading provider playlist';
      if (!suppliedPlaylistPath) await downloadPlaylist(provider, playlistPath);
      const { rows: existingRows } = await pool.query<{ kind: string; provider_id: string }>(
        `SELECT kind,provider_id FROM sc_provider_streams WHERE provider_key='xtream'`);
      const known = new Set(existingRows.map((row) => `${row.kind}:${row.provider_id}`));
      const seenPlaylistIds = new Set<string>();
      const entries: PlaylistEntry[] = [];
      let extinf = '';
      let total = 0;
      const lines = createInterface({ input: createReadStream(playlistPath), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.startsWith('#EXTINF:')) { extinf = line; continue; }
        if (!extinf || !line.trim() || line.startsWith('#')) continue;
        total++;
        const entry = parsePlaylistEntry(extinf, line.trim(), provider);
        extinf = '';
        if (!entry) continue;
        const kind = entry.kind === 'episode' ? 'episode' : entry.kind;
        const key = `${kind}:${entry.id}`;
        if (!known.has(key) && !seenPlaylistIds.has(key)) { seenPlaylistIds.add(key); entries.push(entry); }
      }
      state.total = total; state.processed = total;
      state.phase = `Enriching ${entries.length.toLocaleString()} new playlist entries`;
      await pool.query(`INSERT INTO sc_catalog_import_runs(id,source,status,started_at) VALUES($1,'m3u','running',$2)`, [runId, startedAt]);
      runCreated = true;
      if (!entries.length) {
        const finishedAt = new Date().toISOString();
        const message = 'Playlist check complete. No new streams were found; the catalog was unchanged.';
        await pool.query(`UPDATE sc_catalog_import_runs SET status='success',finished_at=$2,message=$3 WHERE id=$1`, [runId, finishedAt, message]);
        state.status = 'success'; state.phase = 'No new streams'; state.finishedAt = finishedAt; state.added = 0; state.message = message;
        return;
      }
      const categoryActions = { live: 'get_live_categories', movie: 'get_vod_categories', series: 'get_series_categories' } as const;
      const categoryMaps = new Map<string, Map<string, string>>();
      for (const kind of ['live', 'movie', 'series'] as const) {
        const categories = objectList(await retry(() => requestProvider(provider, categoryActions[kind])), categoryActions[kind]);
        categoryMaps.set(kind, new Map(categories.map((item) => [String(item.category_name ?? item.name ?? '').trim().toLowerCase(), String(item.category_id ?? '')])));
      }
      const categoryId = (kind: 'live' | 'movie' | 'series', name: string): string => categoryMaps.get(kind)?.get(name.trim().toLowerCase()) || `m3u:${name}`;
      const importRunId = runId;
      const countAdded = { live: 0, movie: 0, series: 0, episode: 0 };
      const newMovies = entries.filter((entry) => entry.kind === 'movie');
      const newLive = entries.filter((entry) => entry.kind === 'live');
      const newEpisodes = entries.filter((entry) => entry.kind === 'episode');
      const detailedSeries = new Map<string, { raw: Record<string, unknown>; record: CatalogRecord; key: string; language: string; categoryName: string; titleId?: string }>();
      if (newEpisodes.length) {
        state.phase = 'Matching new episodes to series';
        const seriesRows = objectList(await retry(() => requestProvider(provider, 'get_series', {}, 120_000)), 'get_series');
        const seriesByName = new Map<string, Array<Record<string, unknown>>>();
        for (const raw of seriesRows) {
          const name = String(raw.name ?? ''); const normalized = normalizedProviderTitle(name);
          if (!normalized) continue;
          const list = seriesByName.get(normalized) ?? []; list.push(raw); seriesByName.set(normalized, list);
        }
        const missingParentSeries = new Map<string, Record<string, unknown>>();
        for (const entry of newEpisodes) {
          if (!entry.parentName) continue;
          const possible = seriesByName.get(normalizedProviderTitle(entry.parentName));
          if (!possible?.length) continue;
          const selected = possible.find((raw) => playlistLanguage(String(raw.name ?? '')) === entry.language) ?? possible[0];
          const mapped = mapCatalogItem('series', selected);
          if (!mapped) continue;
          const keyForTitle = titleKey(mapped, selected);
          const categoryName = String(selected.category_name ?? entry.group ?? 'Uncategorised');
          const lang = languageCode(mapped, selected, categoryName);
          const info = asObject(selected);
          detailedSeries.set(mapped.id, { raw: selected, record: { ...mapped, title: cleanPlaylistTitle(mapped.title) }, key: keyForTitle, language: lang, categoryName, titleId: undefined });
          if (!known.has(`series:${mapped.id}`)) missingParentSeries.set(mapped.id, selected);
          void info;
        }
        for (const [seriesId, raw] of missingParentSeries) {
          const series = detailedSeries.get(seriesId)!;
          const titleId = await upsertTitle(series.record, raw, series.key, series.language);
          await upsertStream({ ...series.record, categoryId: categoryId('series', series.categoryName) }, raw, titleId, provider, series.language, series.categoryName, startedAt, importRunId);
          series.titleId = titleId; countAdded.series++; known.add(`series:${seriesId}`); state.added++;
        }
        for (const series of detailedSeries.values()) {
          if (!series.titleId) {
            const existing = await pool.query<{ id: string }>(`SELECT t.id::text FROM sc_provider_streams p JOIN sc_titles t ON t.id=p.title_id
              WHERE p.provider_key='xtream' AND p.kind='series' AND p.provider_id=$1 LIMIT 1`, [series.record.id]);
            series.titleId = existing.rows[0]?.id;
          }
        }
        const episodesBySeries = new Map<string, PlaylistEntry[]>();
        for (const entry of newEpisodes) {
          if (!entry.parentName) continue;
          const possible = seriesByName.get(normalizedProviderTitle(entry.parentName));
          if (!possible?.length) continue;
          const selected = possible.find((raw) => playlistLanguage(String(raw.name ?? '')) === entry.language) ?? possible[0];
          const mapped = mapCatalogItem('series', selected);
          if (!mapped) continue;
          const list = episodesBySeries.get(mapped.id) ?? []; list.push(entry); episodesBySeries.set(mapped.id, list);
        }
        let checked = 0;
        for (const [seriesId, expectedEntries] of episodesBySeries) {
          const series = detailedSeries.get(seriesId);
          if (!series?.titleId) continue;
          state.phase = `Loading episodes for ${cleanPlaylistTitle(series.record.title)}`;
          let episodeMap = new Map<string, CatalogRecord>();
          try {
            const details = await retry(() => requestProvider(provider, 'get_series_info', { series_id: seriesId }, 120_000));
            if (details && typeof details === 'object' && !Array.isArray(details)) {
              episodeMap = new Map(mapEpisodes(seriesId, details as Record<string, unknown>).map((record) => [record.id, record]));
            }
          } catch { /* Use the M3U episode coordinates for IDs the provider detail action omits. */ }
          for (const entry of expectedEntries) {
            const episode = episodeMap.get(entry.id) ?? (entry.seasonNumber && entry.episodeNumber ? {
              kind: 'episode' as const, id: entry.id, parentId: seriesId, seasonNumber: entry.seasonNumber,
              episodeNumber: entry.episodeNumber, title: `Episode ${entry.episodeNumber}`, posterUrl: entry.poster,
              streamExtension: entry.extension
            } : undefined);
            if (!episode || known.has(`episode:${episode.id}`)) continue;
            if (!episode.streamExtension && entry.extension) episode.streamExtension = entry.extension;
            const episodeRaw = { id: episode.id, name: entry.name };
            const lang = entry.language === 'und' ? series.language : entry.language;
            const keyForTitle = titleKey(episode, episodeRaw, series.key);
            const titleId = await upsertTitle(episode, episodeRaw, keyForTitle, lang);
            await upsertStream(episode, episodeRaw, titleId, provider, lang, '', startedAt, importRunId);
            await pool.query(`INSERT INTO sc_series_episodes(episode_title_id,series_title_id,season_number,episode_number)
              VALUES($1,$2,$3,$4) ON CONFLICT(episode_title_id) DO UPDATE SET series_title_id=EXCLUDED.series_title_id,
                season_number=EXCLUDED.season_number,episode_number=EXCLUDED.episode_number`,
            [titleId, series.titleId, episode.seasonNumber ?? 0, episode.episodeNumber ?? 0]);
            known.add(`episode:${episode.id}`); countAdded.episode++; state.added++;
          }
          checked += expectedEntries.length; state.processed = Math.min(state.total, state.processed + checked);
        }
      }
      for (let index = 0; index < newMovies.length; index++) {
        const entry = newMovies[index]; state.phase = `Enriching new movies (${index + 1} of ${newMovies.length})`;
        if (known.has(`movie:${entry.id}`)) continue;
        let raw: Record<string, unknown> = { stream_id: entry.id, name: entry.name, category_id: categoryId('movie', entry.group), stream_icon: entry.poster };
        try {
          const value = await retry(() => requestProvider(provider, 'get_vod_info', { vod_id: entry.id }, 45_000));
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const details = value as Record<string, unknown>;
            raw = { ...asObject(details.movie_data), ...raw, info: asObject(details.info) };
          }
        } catch { /* M3U metadata remains enough to keep this provider stream playable. */ }
        let record = mapCatalogItem('movie', raw);
        if (!record) continue;
        record = { ...record, title: cleanPlaylistTitle(entry.name), releaseYear: entry.year ?? record.releaseYear,
          posterUrl: entry.poster ?? record.posterUrl, streamExtension: entry.extension ?? record.streamExtension };
        const lang = entry.language === 'und' ? languageCode(record, raw, entry.group) : entry.language;
        const keyForTitle = titleKey(record, raw);
        const titleId = await upsertTitle(record, raw, keyForTitle, lang);
        await upsertStream({ ...record, categoryId: categoryId('movie', entry.group) }, raw, titleId, provider, lang, entry.group, startedAt, importRunId);
        known.add(`movie:${entry.id}`); countAdded.movie++; state.added++;
      }
      for (let index = 0; index < newLive.length; index++) {
        const entry = newLive[index]; state.phase = `Adding new live channels (${index + 1} of ${newLive.length})`;
        if (known.has(`live:${entry.id}`)) continue;
        const raw = { stream_id: entry.id, name: entry.name, category_id: categoryId('live', entry.group), stream_icon: entry.poster };
        const mapped = mapCatalogItem('live', raw);
        if (!mapped) continue;
        const record = { ...mapped, title: cleanPlaylistTitle(entry.name), posterUrl: entry.poster, streamExtension: entry.extension || 'ts' };
        const titleId = await upsertTitle(record, raw, titleKey(record, raw), entry.language);
        await upsertStream(record, raw, titleId, provider, entry.language, entry.group, startedAt, importRunId);
        known.add(`live:${entry.id}`); countAdded.live++; state.added++;
      }
      const categorySql = await (await import('node:fs/promises')).readFile(new URL('../database/007_normalized_categories.sql', import.meta.url), 'utf8');
      await pool.query(categorySql);
      const insertedRows = await pool.query<{ kind: string; count: number }>(`SELECT kind,count(*)::integer AS count FROM sc_provider_streams WHERE import_run_id=$1 GROUP BY kind`, [runId]);
      countAdded.live = insertedRows.rows.find((row) => row.kind === 'live')?.count ?? 0;
      countAdded.movie = insertedRows.rows.find((row) => row.kind === 'movie')?.count ?? 0;
      countAdded.series = insertedRows.rows.find((row) => row.kind === 'series')?.count ?? 0;
      countAdded.episode = insertedRows.rows.find((row) => row.kind === 'episode')?.count ?? 0;
      const added = Object.values(countAdded).reduce((sum, value) => sum + value, 0);
      const finishedAt = new Date().toISOString();
      const message = `Playlist check complete. Added ${countAdded.movie} movies, ${countAdded.series} shows, ${countAdded.episode} episodes, and ${countAdded.live} live channels.`;
      await pool.query(`UPDATE sc_catalog_import_runs SET status='success',finished_at=$2,added_movies=$3,added_series=$4,added_episodes=$5,added_live=$6,message=$7 WHERE id=$1`,
        [runId, finishedAt, countAdded.movie, countAdded.series, countAdded.episode, countAdded.live, message]);
      state.status = 'success'; state.phase = 'Playlist check complete'; state.finishedAt = finishedAt; state.added = added; state.message = message;
    } finally { await client.query('SELECT pg_advisory_unlock($1)', [refreshLockId]); }
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message.slice(0, 300) : 'Playlist catalog refresh failed.';
    if (runCreated) await pool.query(`UPDATE sc_catalog_import_runs SET status='error',finished_at=$2,message=$3 WHERE id=$1`, [runId, finishedAt, message]).catch(() => undefined);
    state.status = 'error'; state.phase = 'Playlist refresh failed'; state.finishedAt = finishedAt; state.message = message;
  } finally {
    client.release(); if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function getCatalogRefreshState(): CatalogRefreshState { return { ...state }; }
export function startCatalogRefresh(key: Buffer): boolean {
  if (state.status === 'running') return false;
  state.status = 'running'; state.phase = 'Starting'; state.processed = 0; state.total = 0; state.added = 0; state.message = undefined;
  state.startedAt = new Date().toISOString(); state.finishedAt = undefined;
  void refreshNormalizedCatalog(key);
  return true;
}
export function startPlaylistCatalogRefresh(key: Buffer): boolean {
  if (state.status === 'running') return false;
  state.status = 'running'; state.phase = 'Starting playlist check'; state.processed = 0; state.total = 0; state.added = 0; state.message = undefined;
  state.startedAt = new Date().toISOString(); state.finishedAt = undefined;
  void refreshFromM3U(key);
  return true;
}
export function startPlaylistFileImport(key: Buffer, playlistPath: string): boolean {
  if (state.status === 'running') return false;
  state.status = 'running'; state.phase = 'Starting playlist import'; state.processed = 0; state.total = 0; state.added = 0; state.message = undefined;
  state.startedAt = new Date().toISOString(); state.finishedAt = undefined;
  void refreshFromM3U(key, playlistPath);
  return true;
}
export function startNightlyPlaylistRefresh(key: Buffer): NodeJS.Timeout {
  let lastRunDate = '';
  const timezone = 'Europe/Amsterdam';
  const timer = setInterval(() => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).reduce<Record<string, string>>((result, part) => { if (part.type !== 'literal') result[part.type] = part.value; return result; }, {});
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (parts.hour === '03' && Number(parts.minute) <= 4 && lastRunDate !== date) {
      lastRunDate = date;
      startPlaylistCatalogRefresh(key);
    }
  }, 30_000);
  timer.unref();
  return timer;
}
