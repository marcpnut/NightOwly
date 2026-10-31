import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { decrypt, encrypt, hashSessionToken } from './security.js';
import type { CatalogRecord, ProviderCredentials } from './provider.js';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });

export function normalizedTitleSql(expression: string): string {
  const withoutSuffix = `regexp_replace(${expression}, '[[:space:]]*\\((19|20)[0-9]{2}\\)?([[:space:]]*\\((MULTI[[:space:]]*SUB|[A-Z]{2,3}|4K|UHD|[0-9]{3,4}P)\\))*[[:space:]]*$', '', 'i')`;
  const withoutPrefix = `regexp_replace(${withoutSuffix}, '^[[:space:]]*(NL|EN|PL|FR|DE|ES|IT|PT|US|UK|NF)([[:space:]]+(4K|UHD|1080P|720P))?[[:space:]]*[-:|][[:space:]]*', '', 'i')`;
  return `btrim(regexp_replace(${withoutPrefix}, '[[:space:]]+', ' ', 'g'))`;
}

export async function listAvailableLanguages() {
  const { rows } = await pool.query(`SELECT code,name FROM sc_languages
    WHERE code <> 'und' AND name <> 'Unlabelled'
      AND EXISTS(SELECT 1 FROM sc_provider_streams p WHERE p.language_id=sc_languages.id AND p.active)
    ORDER BY name`);
  return rows as Array<{ code: string; name: string }>;
}

export async function migrate(): Promise<void> {
  for (const migration of ['001_init.sql', '002_normalized_catalog.sql']) {
    const file = fileURLToPath(new URL(`../database/${migration}`, import.meta.url));
    await pool.query(await readFile(file, 'utf8'));
  }
  const { rows } = await pool.query<{ available: boolean }>(`SELECT to_regclass('public.sc_titles') IS NOT NULL AS available`);
  if (rows[0]?.available) {
    for (const migration of ['006_tmdb_on_demand_cache.sql', '007_normalized_categories.sql', '009_tmdb_artwork_backfill.sql', '010_opensubtitles_settings.sql', '012_catalog_import_runs.sql']) {
      const file = fileURLToPath(new URL(`../database/${migration}`, import.meta.url));
      await pool.query(await readFile(file, 'utf8'));
    }
  }
  const sessionFile = fileURLToPath(new URL('../database/008_client_sessions.sql', import.meta.url));
  await pool.query(await readFile(sessionFile, 'utf8'));
  const webAccountFile = fileURLToPath(new URL('../database/011_web_accounts.sql', import.meta.url));
  await pool.query(await readFile(webAccountFile, 'utf8'));
}

export async function saveOpenSubtitlesApiKey(value: string, key: Buffer): Promise<void> {
  if (!value.trim()) await pool.query(`DELETE FROM sc_opensubtitles_settings WHERE id='primary'`);
  else await pool.query(`INSERT INTO sc_opensubtitles_settings(id,api_key_cipher) VALUES('primary',$1)
    ON CONFLICT(id) DO UPDATE SET api_key_cipher=EXCLUDED.api_key_cipher,updated_at=now()`, [encrypt(value.trim(), key)]);
}

export async function loadOpenSubtitlesApiKey(key: Buffer): Promise<string | null> {
  const { rows } = await pool.query<{ api_key_cipher: string }>(`SELECT api_key_cipher FROM sc_opensubtitles_settings WHERE id='primary'`);
  return rows[0] ? decrypt(rows[0].api_key_cipher, key) : null;
}

export async function hasNormalizedCatalog(): Promise<boolean> {
  const { rows } = await pool.query<{ available: boolean }>(`SELECT to_regclass('public.sc_titles') IS NOT NULL AS available`);
  return rows[0]?.available ?? false;
}

export async function createClientSession(token: string, device: string): Promise<void> {
  await pool.query(`INSERT INTO sc_client_sessions(token_hash,device_id,expires_at)
    VALUES($1,$2,now()+interval '30 days')`, [hashSessionToken(token), device]);
}

export async function hasWebAccount(): Promise<boolean> {
  const { rows } = await pool.query<{ configured: boolean }>(`SELECT EXISTS(SELECT 1 FROM sc_web_accounts WHERE id='primary') AS configured`);
  return !!rows[0]?.configured;
}

export async function createWebAccount(username: string, passwordHash: string): Promise<boolean> {
  const { rowCount } = await pool.query(`INSERT INTO sc_web_accounts(id,username,password_hash) VALUES('primary',$1,$2) ON CONFLICT(id) DO NOTHING`,
    [username, passwordHash]);
  return (rowCount ?? 0) > 0;
}

export async function loadWebAccount(): Promise<{ username: string; passwordHash: string } | null> {
  const { rows } = await pool.query<{ username: string; password_hash: string }>(`SELECT username,password_hash FROM sc_web_accounts WHERE id='primary'`);
  return rows[0] ? { username: rows[0].username, passwordHash: rows[0].password_hash } : null;
}

export async function validateClientSession(token: string, device: string): Promise<boolean> {
  const { rowCount } = await pool.query(`UPDATE sc_client_sessions
    SET last_seen_at=now(),expires_at=now()+interval '30 days'
    WHERE token_hash=$1 AND device_id=$2 AND revoked_at IS NULL AND expires_at>now()`,
    [hashSessionToken(token), device]);
  return (rowCount ?? 0) > 0;
}

export async function revokeClientSession(token: string, device: string): Promise<void> {
  await pool.query(`UPDATE sc_client_sessions SET revoked_at=now() WHERE token_hash=$1 AND device_id=$2 AND revoked_at IS NULL`,
    [hashSessionToken(token), device]);
}

export async function saveProvider(credentials: ProviderCredentials, key: Buffer): Promise<void> {
  await pool.query(`INSERT INTO provider_config(id,base_url,playback_base_url,allowed_live_formats,username_cipher,password_cipher) VALUES('primary',$1,$2,$3,$4,$5)
    ON CONFLICT(id) DO UPDATE SET base_url=EXCLUDED.base_url,username_cipher=EXCLUDED.username_cipher,
    password_cipher=EXCLUDED.password_cipher,playback_base_url=EXCLUDED.playback_base_url,
    allowed_live_formats=EXCLUDED.allowed_live_formats,updated_at=now()`,
    [credentials.baseUrl, credentials.playbackBaseUrl ?? null, JSON.stringify(credentials.allowedLiveFormats ?? []),
      encrypt(credentials.username, key), encrypt(credentials.password, key)]);
}

export async function loadProvider(key: Buffer): Promise<ProviderCredentials | null> {
  const { rows } = await pool.query<{ base_url: string; playback_base_url: string | null; allowed_live_formats: string[]; username_cipher: string; password_cipher: string }>(
    `SELECT base_url,playback_base_url,allowed_live_formats,username_cipher,password_cipher FROM provider_config WHERE id='primary'`);
  if (!rows[0]) return null;
  return { baseUrl: rows[0].base_url, playbackBaseUrl: rows[0].playback_base_url ?? undefined,
    allowedLiveFormats: rows[0].allowed_live_formats, username: decrypt(rows[0].username_cipher, key), password: decrypt(rows[0].password_cipher, key) };
}

export async function upsertRecords(records: CatalogRecord[], client?: pg.PoolClient): Promise<void> {
  if (!records.length) return;
  const data = records.map((record) => ({
    kind: record.kind, id: record.id, parent_id: record.parentId ?? null,
    season_number: record.seasonNumber ?? null, episode_number: record.episodeNumber ?? null,
    category_id: record.categoryId ?? null, title: record.title, description: record.description ?? null,
    poster_url: record.posterUrl ?? null, backdrop_url: record.backdropUrl ?? null,
    genre: record.genre ?? null, release_year: record.releaseYear ?? null,
    duration_seconds: record.durationSeconds ?? null, rating: record.rating ?? null,
    added_at: record.addedAt ?? null, stream_extension: record.streamExtension ?? null,
    metadata: record.metadata ?? {}
  }));
  await (client ?? pool).query(`INSERT INTO catalog(kind,id,parent_id,season_number,episode_number,category_id,title,description,poster_url,backdrop_url,
      genre,release_year,duration_seconds,rating,added_at,stream_extension,metadata,active,last_seen_at)
      SELECT kind,id,parent_id,season_number,episode_number,category_id,title,description,poster_url,backdrop_url,
        genre,release_year,duration_seconds,rating,added_at,stream_extension,metadata,true,now()
      FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,parent_id text,season_number integer,episode_number integer,
        category_id text,title text,description text,poster_url text,backdrop_url text,genre text,release_year integer,
        duration_seconds integer,rating numeric,added_at timestamptz,stream_extension text,metadata jsonb)
      ON CONFLICT(kind,id) DO UPDATE SET parent_id=EXCLUDED.parent_id,season_number=EXCLUDED.season_number,
      episode_number=EXCLUDED.episode_number,category_id=EXCLUDED.category_id,title=EXCLUDED.title,
      description=EXCLUDED.description,poster_url=EXCLUDED.poster_url,backdrop_url=EXCLUDED.backdrop_url,
      genre=EXCLUDED.genre,release_year=EXCLUDED.release_year,duration_seconds=EXCLUDED.duration_seconds,
      rating=EXCLUDED.rating,added_at=EXCLUDED.added_at,stream_extension=EXCLUDED.stream_extension,
      metadata=EXCLUDED.metadata,active=true,last_seen_at=now()`, [JSON.stringify(data)]);

  const db = client ?? pool;
  const normalized = records.map((record) => {
    const language = typeof record.metadata?.language === 'string' ? record.metadata.language.trim() : '';
    const code = typeof record.metadata?.languageCode === 'string' ? record.metadata.languageCode : null;
    const canonicalTitle = record.title.trim().replace(/\s+/g, ' ');
    const normalizedTitle = canonicalTitle.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const canonicalKey = `${record.kind}:${normalizedTitle}:${record.releaseYear ?? ''}`;
    return { ...record, canonicalTitle, canonicalKey, language: language || null, languageCode: code };
  });
  const titles = normalized.filter((record) => record.kind !== 'episode');
  if (titles.length) {
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,canonical_key text,title text,description text,
      release_year integer,poster_url text,backdrop_url text,genre text,rating numeric,metadata jsonb))
      INSERT INTO media_items(kind,canonical_key,title,original_title,description,release_year,poster_url,backdrop_url,genre,rating,metadata)
      SELECT DISTINCT ON(kind,canonical_key) kind,canonical_key,title,title,description,release_year,poster_url,backdrop_url,genre,rating,metadata
      FROM incoming ORDER BY kind,canonical_key
      ON CONFLICT(canonical_key) DO UPDATE SET title=EXCLUDED.title,description=COALESCE(media_items.description,EXCLUDED.description),
        release_year=COALESCE(media_items.release_year,EXCLUDED.release_year),poster_url=COALESCE(media_items.poster_url,EXCLUDED.poster_url),
        backdrop_url=COALESCE(media_items.backdrop_url,EXCLUDED.backdrop_url),genre=COALESCE(media_items.genre,EXCLUDED.genre),
        rating=COALESCE(media_items.rating,EXCLUDED.rating),active=true,updated_at=now()`, [JSON.stringify(titles.map((r) => ({ ...r, canonical_key: r.canonicalKey, poster_url: r.posterUrl, backdrop_url: r.backdropUrl, release_year: r.releaseYear })))]);
  }
  const langRows = normalized.filter((r) => r.language).map((r) => ({ name: r.language, code: r.languageCode }));
  if (langRows.length) await db.query(`INSERT INTO languages(name,code) SELECT DISTINCT name,code FROM jsonb_to_recordset($1::jsonb) AS x(name text,code text)
    ON CONFLICT(name) DO UPDATE SET code=COALESCE(languages.code,EXCLUDED.code)`, [JSON.stringify(langRows)]);

  const streamRows = normalized.filter((r) => r.kind !== 'episode').map((r) => ({ ...r, canonical_key: r.canonicalKey, language_code: r.languageCode,
    path_template: r.kind === 'movie' ? '/movie/{username}/{password}/{stream_id}.{extension}' : r.kind === 'series' ? '/series/{username}/{password}/{stream_id}.{extension}' : '/live/{username}/{password}/{stream_id}.{extension}' }));
  if (streamRows.length) {
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,canonical_key text,title text,stream_extension text,
      category_id text,path_template text,language text,language_code text))
      INSERT INTO provider_streams(media_item_id,provider_id,kind,category_id,title,stream_extension,path_template,active,last_seen_at)
      SELECT m.id,i.id,i.kind,i.category_id,i.title,i.stream_extension,i.path_template,true,now()
      FROM incoming i JOIN media_items m ON m.canonical_key=i.canonical_key
      ON CONFLICT(kind,provider_id) DO UPDATE SET media_item_id=EXCLUDED.media_item_id,category_id=EXCLUDED.category_id,title=EXCLUDED.title,
        stream_extension=EXCLUDED.stream_extension,path_template=EXCLUDED.path_template,active=true,last_seen_at=now()`, [JSON.stringify(streamRows.map((r) => ({ ...r, id: r.id, category_id: r.categoryId, stream_extension: r.streamExtension })))]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text)),
      streams AS (SELECT ps.id,ps.media_item_id FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      DELETE FROM stream_languages WHERE stream_id IN (SELECT id FROM streams)`, [JSON.stringify(streamRows)]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text)),
      streams AS (SELECT ps.id,ps.media_item_id FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      DELETE FROM stream_categories WHERE stream_id IN (SELECT id FROM streams)`, [JSON.stringify(streamRows)]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text)),
      affected AS (SELECT DISTINCT ps.media_item_id FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      DELETE FROM media_languages WHERE media_item_id IN (SELECT media_item_id FROM affected)`, [JSON.stringify(streamRows)]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text)),
      affected AS (SELECT DISTINCT ps.media_item_id FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      DELETE FROM media_categories WHERE media_item_id IN (SELECT media_item_id FROM affected)`, [JSON.stringify(streamRows)]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,canonical_key text)),
      linked AS (SELECT ps.media_item_id AS media_id,i.kind FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      INSERT INTO media_sections(media_item_id,section_id) SELECT DISTINCT media_id,s.id FROM linked JOIN sections s ON s.code=linked.kind ON CONFLICT DO NOTHING`, [JSON.stringify(streamRows)]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,canonical_key text,category_id text,language text,language_code text)),
      linked AS (SELECT ps.id AS stream_id,m.id AS media_id,i.language,i.language_code,i.category_id,i.kind,i.id AS provider_id
        FROM incoming i JOIN media_items m ON m.canonical_key=i.canonical_key JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      INSERT INTO stream_languages(stream_id,language_id) SELECT DISTINCT l.stream_id,lang.id FROM linked l JOIN languages lang ON lower(lang.name)=lower(l.language) ON CONFLICT DO NOTHING`, [JSON.stringify(streamRows)]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text)),
      affected AS (SELECT DISTINCT ps.media_item_id FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      INSERT INTO media_languages(media_item_id,language_id) SELECT DISTINCT ps.media_item_id,sl.language_id FROM provider_streams ps
      JOIN stream_languages sl ON sl.stream_id=ps.id WHERE ps.media_item_id IN (SELECT media_item_id FROM affected) ON CONFLICT DO NOTHING`, [JSON.stringify(streamRows)]);
    const categoryJson = JSON.stringify(streamRows);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,category_id text)),
      linked AS (SELECT ps.id AS stream_id,ps.media_item_id,i.category_id,i.kind FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id WHERE i.category_id IS NOT NULL),
      names AS (SELECT l.*,COALESCE(c.name,l.category_id) AS category_name FROM linked l LEFT JOIN categories c ON c.kind=l.kind AND c.id=l.category_id)
      INSERT INTO categories_v2(provider_category_id,name) SELECT DISTINCT category_id,category_name FROM names ON CONFLICT(provider_category_id,name) DO NOTHING`, [categoryJson]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,category_id text)),
      names AS (SELECT ps.id AS stream_id,ps.media_item_id,i.category_id,COALESCE(c.name,i.category_id) AS category_name
        FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id LEFT JOIN categories c ON c.kind=i.kind AND c.id=i.category_id WHERE i.category_id IS NOT NULL)
      INSERT INTO stream_categories(stream_id,category_id) SELECT DISTINCT n.stream_id,cv.id FROM names n JOIN categories_v2 cv ON cv.provider_category_id=n.category_id AND cv.name=n.category_name ON CONFLICT DO NOTHING`, [categoryJson]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text,category_id text)),
      names AS (SELECT ps.media_item_id,i.category_id,COALESCE(c.name,i.category_id) AS category_name
        FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id LEFT JOIN categories c ON c.kind=i.kind AND c.id=i.category_id WHERE i.category_id IS NOT NULL)
      INSERT INTO media_categories(media_item_id,category_id) SELECT DISTINCT n.media_item_id,cv.id FROM names n JOIN categories_v2 cv ON cv.provider_category_id=n.category_id AND cv.name=n.category_name ON CONFLICT DO NOTHING`, [categoryJson]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id text)),
      affected AS (SELECT DISTINCT ps.media_item_id FROM incoming i JOIN provider_streams ps ON ps.kind=i.kind AND ps.provider_id=i.id)
      INSERT INTO media_categories(media_item_id,category_id) SELECT DISTINCT ps.media_item_id,sc.category_id FROM provider_streams ps
      JOIN stream_categories sc ON sc.stream_id=ps.id WHERE ps.media_item_id IN (SELECT media_item_id FROM affected) ON CONFLICT DO NOTHING`, [JSON.stringify(streamRows)]);
    await db.query(`INSERT INTO category_sections(category_id,section_id) SELECT DISTINCT sc.category_id,s.id FROM stream_categories sc
      JOIN provider_streams ps ON ps.id=sc.stream_id JOIN sections s ON s.code=ps.kind WHERE ps.provider_id IN
      (SELECT id FROM jsonb_to_recordset($1::jsonb) AS x(id text)) ON CONFLICT DO NOTHING`, [JSON.stringify(streamRows)]);
    await db.query(`INSERT INTO category_languages(category_id,language_id) SELECT DISTINCT sc.category_id,sl.language_id FROM stream_categories sc
      JOIN stream_languages sl ON sl.stream_id=sc.stream_id WHERE sc.stream_id IN
      (SELECT ps.id FROM provider_streams ps WHERE ps.provider_id IN (SELECT id FROM jsonb_to_recordset($1::jsonb) AS x(id text))) ON CONFLICT DO NOTHING`, [JSON.stringify(streamRows)]);
  }
  const episodeRows = normalized.filter((r) => r.kind === 'episode');
  if (episodeRows.length) {
    const episodeJson = JSON.stringify(episodeRows.map((r) => ({ ...r, parent_id: r.parentId, poster_url: r.posterUrl, season_number: r.seasonNumber, episode_number: r.episodeNumber, stream_extension: r.streamExtension })));
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,parent_id text,title text,description text,
      poster_url text,season_number integer,episode_number integer,stream_extension text)),
      linked AS (SELECT i.*,s.id AS stream_id,s.media_item_id AS series_media_item_id FROM incoming i
        JOIN provider_streams s ON s.kind='series' AND s.provider_id=i.parent_id)
      INSERT INTO provider_streams(media_item_id,provider_id,kind,parent_provider_id,title,stream_extension,path_template,active,last_seen_at)
      SELECT series_media_item_id,id,'episode',parent_id,title,stream_extension,'/series/{username}/{password}/{stream_id}.{extension}',true,now() FROM linked
      ON CONFLICT(kind,provider_id) DO UPDATE SET title=EXCLUDED.title,active=true,last_seen_at=now()`, [episodeJson]);
    await db.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,parent_id text,title text,description text,poster_url text,season_number integer,episode_number integer)),
      linked AS (SELECT i.*,s.id AS stream_id,s.media_item_id AS series_media_item_id FROM incoming i JOIN provider_streams s ON s.kind='episode' AND s.provider_id=i.id)
      INSERT INTO episodes(stream_id,series_media_item_id,season_number,episode_number,title,description,poster_url)
      SELECT stream_id,series_media_item_id,season_number,episode_number,title,description,poster_url FROM linked
      ON CONFLICT(stream_id) DO UPDATE SET season_number=EXCLUDED.season_number,episode_number=EXCLUDED.episode_number,title=EXCLUDED.title,
        description=EXCLUDED.description,poster_url=EXCLUDED.poster_url`, [episodeJson]);
  }
}

export async function listCatalog(kind: 'movie' | 'series' | 'live', page: number, limit: number, category?: string, query?: string, languageCode = 'en', countryCode?: string, excludedCategories?: string[]) {
  if (await hasNormalizedCatalog()) {
    const { rows } = await pool.query(`SELECT p.provider_id AS id,t.id::text AS "canonicalId",t.kind,
      ${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
        JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id
        WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
        ORDER BY (title_lang.code=$6) DESC,(title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,tr.description,
      COALESCE(tr.poster_url,t.poster_url) AS "posterUrl",t.backdrop_url AS "backdropUrl",
      (SELECT string_agg(DISTINCT g.name, ', ' ORDER BY g.name) FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=t.id) AS genre,
      t.release_year AS "releaseYear",t.runtime_seconds AS "durationSeconds",t.rating,
      p.stream_extension AS "streamExtension",p.language_id AS "languageId",lang.name AS language
      FROM sc_titles t
      JOIN LATERAL (SELECT ps.* FROM sc_provider_streams ps LEFT JOIN sc_languages lp ON lp.id=ps.language_id
        WHERE ps.title_id=t.id AND ps.kind=$1 AND ps.active
        ORDER BY CASE WHEN lp.code='en' THEN 0 WHEN lp.code='und' OR lp.code IS NULL THEN 2 ELSE 1 END,ps.id LIMIT 1) p ON true
      LEFT JOIN sc_languages lang ON lang.id=p.language_id
      LEFT JOIN LATERAL (SELECT tx.* FROM sc_title_translations tx JOIN sc_languages tl ON tl.id=tx.language_id
        WHERE tx.title_id=t.id ORDER BY (NULLIF(tx.description,'') IS NOT NULL) DESC,
          (tl.code='en') DESC,(tl.code='nl') DESC,(tl.code='pl') DESC,(tl.code=$6) DESC,
          (tx.source='tmdb') DESC,tx.language_id LIMIT 1) tr ON true
      WHERE t.kind=$1
        AND ($2::text IS NULL OR (
          ($1='live' AND EXISTS(SELECT 1 FROM sc_stream_categories live_sc
            JOIN sc_categories live_c ON live_c.id=live_sc.category_id AND live_c.kind='live'
            JOIN sc_provider_streams live_p ON live_p.id=live_sc.stream_id AND live_p.title_id=t.id AND live_p.kind='live' AND live_p.active
            WHERE live_c.provider_category_id=$2))
          OR ($1 IN ('movie','series') AND EXISTS(
          SELECT 1 FROM sc_browse_categories bc
          JOIN sc_browse_category_sources bcs ON bcs.browse_category_id=bc.id
          JOIN sc_categories c ON c.id=bcs.source_category_id AND c.kind=$1
          JOIN sc_stream_categories sc ON sc.category_id=c.id
          JOIN sc_provider_streams cp ON cp.id=sc.stream_id AND cp.title_id=t.id AND cp.kind=$1 AND cp.active
          WHERE bc.id::text=$2 AND bc.kind=$1))))
        AND ($3::text IS NULL OR (
          ($1='live' AND (
            to_tsvector('simple',t.original_title||' '||coalesce(tr.display_title,'')||' '||coalesce(tr.description,'')) @@
              (SELECT to_tsquery('simple',string_agg(token||':*',' & ')) FROM regexp_split_to_table($3,'[^[:alnum:]]+') token WHERE token<>'')
            OR regexp_replace(lower(concat_ws(' ',t.original_title,tr.display_title,tr.description)),'[^[:alnum:]]','','g')
              LIKE '%'||regexp_replace(lower($3),'[^[:alnum:]]','','g')||'%'))
          OR ($1<>'live' AND (
            to_tsvector('simple',t.original_title||' '||coalesce(tr.display_title,'')||' '||coalesce(tr.description,'')||' '||
              coalesce((SELECT string_agg(g.name,' ') FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=t.id),'')||' '||
              coalesce((SELECT string_agg(k.name,' ') FROM sc_title_keywords tk JOIN sc_keywords k ON k.id=tk.keyword_id WHERE tk.title_id=t.id),'')) @@
              (SELECT to_tsquery('simple',string_agg(token||':*',' & ')) FROM regexp_split_to_table($3,'[^[:alnum:]]+') token WHERE token<>'')
            OR regexp_replace(lower(concat_ws(' ',t.original_title,tr.display_title,tr.description,
              (SELECT string_agg(g.name,' ') FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=t.id),
              (SELECT string_agg(k.name,' ') FROM sc_title_keywords tk JOIN sc_keywords k ON k.id=tk.keyword_id WHERE tk.title_id=t.id))), '[^[:alnum:]]','','g')
              LIKE '%'||regexp_replace(lower($3),'[^[:alnum:]]','','g')||'%'))))
        AND ($7::text IS NULL OR ($1='live' AND EXISTS(
          SELECT 1 FROM sc_stream_categories country_sc
          JOIN sc_categories country_cat ON country_cat.id=country_sc.category_id AND country_cat.kind='live'
          JOIN sc_provider_streams country_p ON country_p.id=country_sc.stream_id AND country_p.title_id=t.id AND country_p.kind='live' AND country_p.active
          WHERE CASE
            WHEN upper(trim(country_cat.name))='USA' OR upper(substring(country_cat.name from '^[[:space:]]*([A-Z]{2,3})[[:space:]]*[|]')) IN ('UK','IR','US','USA','FOR') THEN 'EN'
            WHEN upper(substring(country_cat.name from '^[[:space:]]*([A-Z]{2,3})[[:space:]]*[|]'))='BE'
              OR (upper(substring(country_cat.name from '^[[:space:]]*([A-Z]{2,3})[[:space:]]*[|]'))='EU' AND country_cat.name ILIKE '%NETHERLANDS%') THEN 'NL'
            ELSE COALESCE(upper(substring(country_cat.name from '^[[:space:]]*([A-Z]{2,3})[[:space:]]*[|]')),'other') END=$7)))
        AND ($8::text[] IS NULL OR NOT EXISTS(SELECT 1 FROM sc_stream_categories hidden_sc
          JOIN sc_categories hidden_cat ON hidden_cat.id=hidden_sc.category_id AND hidden_cat.kind='live'
          WHERE hidden_sc.stream_id=p.id AND hidden_cat.provider_category_id=ANY($8)))
      ORDER BY CASE WHEN $3::text IS NULL THEN 0
        WHEN $1='live' AND to_tsvector('simple',t.original_title||' '||coalesce(tr.display_title,'')||' '||coalesce(tr.description,'')) @@
          (SELECT to_tsquery('simple',string_agg(token||':*',' & ')) FROM regexp_split_to_table($3,'[^[:alnum:]]+') token WHERE token<>'') THEN 0
        WHEN $1<>'live' AND to_tsvector('simple',t.original_title||' '||coalesce(tr.display_title,'')||' '||coalesce(tr.description,'')||' '||
          coalesce((SELECT string_agg(g.name,' ') FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=t.id),'')||' '||
          coalesce((SELECT string_agg(k.name,' ') FROM sc_title_keywords tk JOIN sc_keywords k ON k.id=tk.keyword_id WHERE tk.title_id=t.id),'')) @@
          (SELECT to_tsquery('simple',string_agg(token||':*',' & ')) FROM regexp_split_to_table($3,'[^[:alnum:]]+') token WHERE token<>'') THEN 0
        ELSE 1 END,
        t.release_year DESC NULLS LAST,t.id DESC LIMIT $4 OFFSET $5`,
    [kind, category ?? null, query ?? null, limit, (page - 1) * limit, languageCode, countryCode ?? null, excludedCategories?.length ? excludedCategories : null]);
    return rows;
  }
  const where = [`kind=$1`, `active=true`];
  const args: Array<string | number | string[]> = [kind];
  if (category) { args.push(category); where.push(`category_id=$${args.length}`); }
  if (kind === 'live' && excludedCategories?.length) { args.push(excludedCategories); where.push(`NOT (category_id=ANY($${args.length}::text[]))`); }
  if (query) {
    args.push(query);
    where.push(kind === 'live'
      ? `to_tsvector('simple',title || ' ' || coalesce(description,'')) @@ (SELECT to_tsquery('simple',string_agg(token||':*',' & ')) FROM regexp_split_to_table($${args.length},'[^[:alnum:]]+') token WHERE token<>'')`
      : `to_tsvector('simple',title || ' ' || coalesce(description,'')) @@ plainto_tsquery('simple',$${args.length})`);
  }
  args.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(`SELECT kind,id,parent_id AS "parentId",category_id AS "categoryId",title,description,
    poster_url AS "posterUrl",backdrop_url AS "backdropUrl",genre,release_year AS "releaseYear",
    duration_seconds AS "durationSeconds",rating,added_at AS "addedAt",stream_extension AS "streamExtension"
    FROM catalog WHERE ${where.join(' AND ')} ORDER BY added_at DESC NULLS LAST,id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
  return rows;
}

export async function getCatalog(kind: string, id: string) {
  if (await hasNormalizedCatalog()) {
    const { rows } = await pool.query(`SELECT ps.kind,ps.provider_id AS id,ps.parent_provider_id AS "parentId",
      se.season_number AS "seasonNumber",se.episode_number AS "episodeNumber",
      ${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
        JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id
        WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
        ORDER BY (title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,tx.description,
      tx.tagline AS tagline,tx.trailer_id AS "trailerId",
      COALESCE(tx.poster_url,t.poster_url) AS "posterUrl",t.backdrop_url AS "backdropUrl",
      (SELECT string_agg(DISTINCT g.name, ', ' ORDER BY g.name) FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=t.id) AS genre,
      t.release_year AS "releaseYear",t.runtime_seconds AS "durationSeconds",t.rating,ps.stream_extension AS "streamExtension",
      jsonb_build_object('language',l.name,'languageCode',l.code,'tmdbId',t.tmdb_id) AS metadata,
      ps.playback_path_template AS "pathTemplate",ps.resolved_source_url AS "resolvedSourceUrl",t.id::text AS "canonicalId"
      FROM sc_provider_streams ps JOIN sc_titles t ON t.id=ps.title_id
      LEFT JOIN sc_languages l ON l.id=ps.language_id
      LEFT JOIN sc_series_episodes se ON se.episode_title_id=t.id
      LEFT JOIN LATERAL (SELECT tx.* FROM sc_title_translations tx LEFT JOIN sc_languages tl ON tl.id=tx.language_id WHERE tx.title_id=t.id
        ORDER BY (NULLIF(tx.description,'') IS NOT NULL) DESC,(tl.code='en') DESC,
          (tl.code='nl') DESC,(tl.code='pl') DESC,
          (tx.source='tmdb') DESC,tx.language_id LIMIT 1) tx ON true
      WHERE ps.kind=$1 AND ps.provider_id=$2 AND ps.active LIMIT 1`, [kind, id]);
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(`SELECT kind,id,parent_id AS "parentId",season_number AS "seasonNumber",
    episode_number AS "episodeNumber",category_id AS "categoryId",title,description,poster_url AS "posterUrl",
    backdrop_url AS "backdropUrl",genre,release_year AS "releaseYear",duration_seconds AS "durationSeconds",
    rating,added_at AS "addedAt",stream_extension AS "streamExtension",metadata
    FROM catalog WHERE kind=$1 AND id=$2 AND active=true`, [kind, id]);
  return rows[0] ?? null;
}

export async function listNormalizedCategories(kind: 'movie' | 'series' | 'live', languageCode = 'en') {
  if (kind !== 'live') {
    const { rows } = await pool.query(`SELECT b.id::text AS id,
      COALESCE(lbl.display_name,b.display_name) AS name,b.category_type AS type,
      count(DISTINCT p.title_id)::integer AS "itemCount"
      FROM sc_browse_categories b
      JOIN sc_browse_category_sources bs ON bs.browse_category_id=b.id
      JOIN sc_categories c ON c.id=bs.source_category_id AND c.kind=$1
      JOIN sc_stream_categories sc ON sc.category_id=c.id
      JOIN sc_provider_streams p ON p.id=sc.stream_id AND p.kind=$1 AND p.active
      LEFT JOIN sc_browse_category_labels lbl ON lbl.browse_category_id=b.id AND lbl.language_code=$2
      WHERE b.kind=$1
      GROUP BY b.id,lbl.display_name
      ORDER BY b.sort_order,name`, [kind, languageCode]);
    return rows;
  }
  const { rows } = await pool.query(`SELECT c.provider_category_id AS id,min(c.name) AS name
    FROM sc_categories c JOIN sc_stream_categories sc ON sc.category_id=c.id
    JOIN sc_provider_streams p ON p.id=sc.stream_id AND p.active
    WHERE c.kind=$1 GROUP BY c.provider_category_id ORDER BY min(c.name)`, [kind]);
  return rows;
}

export async function getNormalizedDetail(kind: 'movie' | 'series', providerId: string, languageCode = 'en') {
  const { rows } = await pool.query(`SELECT t.id::text AS "canonicalId",ps.provider_id AS id,t.kind,
      ${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
        JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id
        WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
        ORDER BY (title_lang.code=$3) DESC,(title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,
      COALESCE(NULLIF(tx.description,''),(SELECT x.description FROM sc_title_translations x
        WHERE x.title_id=t.id AND NULLIF(x.description,'') IS NOT NULL
        ORDER BY (x.language_id=(SELECT id FROM sc_languages WHERE code='en')) DESC,
          (x.language_id=(SELECT id FROM sc_languages WHERE code='nl')) DESC,(x.language_id=(SELECT id FROM sc_languages WHERE code='pl')) DESC,
          (x.language_id=(SELECT id FROM sc_languages WHERE code=$3)) DESC,(x.source='tmdb') DESC,x.language_id LIMIT 1),
        (SELECT COALESCE(NULLIF(s.raw_payload#>>'{info,plot}',''),NULLIF(s.raw_payload->>'plot',''),
            NULLIF(s.raw_payload#>>'{info,description}',''),NULLIF(s.raw_payload->>'description',''),
            NULLIF(s.raw_payload#>>'{info,overview}',''),NULLIF(s.raw_payload->>'overview',''))
          FROM sc_provider_streams source_ps JOIN streams s ON s.kind=source_ps.kind AND s.provider_id=source_ps.provider_id
          WHERE source_ps.title_id=t.id AND source_ps.kind=$1 AND source_ps.active
            AND COALESCE(NULLIF(s.raw_payload#>>'{info,plot}',''),NULLIF(s.raw_payload->>'plot',''),
              NULLIF(s.raw_payload#>>'{info,description}',''),NULLIF(s.raw_payload->>'description',''),
              NULLIF(s.raw_payload#>>'{info,overview}',''),NULLIF(s.raw_payload->>'overview','')) IS NOT NULL
          ORDER BY (source_ps.language_id=(SELECT id FROM sc_languages WHERE code='en')) DESC,
            (source_ps.language_id=(SELECT id FROM sc_languages WHERE code='nl')) DESC,
            (source_ps.language_id=(SELECT id FROM sc_languages WHERE code='pl')) DESC,
            (source_ps.language_id=(SELECT id FROM sc_languages WHERE code=$3)) DESC,
            (source_ps.provider_id=ps.provider_id) DESC,source_ps.provider_id LIMIT 1)) AS description,
      tx.tagline AS tagline,tx.trailer_id AS "trailerId",
      COALESCE(tx.poster_url,t.poster_url) AS "posterUrl",t.backdrop_url AS "backdropUrl",
      (SELECT string_agg(DISTINCT g.name, ', ' ORDER BY g.name) FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=t.id) AS genre,
      t.release_year AS "releaseYear",t.runtime_seconds AS "durationSeconds",t.rating,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ps2.provider_id,'providerId',ps2.provider_id,
        'language',l2.name,'languageCode',l2.code,'extension',ps2.stream_extension,
        'categories',COALESCE((SELECT jsonb_agg(DISTINCT c.name) FROM sc_stream_categories sc JOIN sc_categories c ON c.id=sc.category_id WHERE sc.stream_id=ps2.id),'[]'::jsonb))
        ORDER BY (l2.code=$3) DESC,(l2.code='en') DESC,(l2.code='und') DESC,ps2.provider_id)
        FROM sc_provider_streams ps2 LEFT JOIN sc_languages l2 ON l2.id=ps2.language_id
        WHERE ps2.title_id=t.id AND ps2.kind=$1 AND ps2.active),'[]'::jsonb) AS streams,
      (SELECT ps2.provider_id FROM sc_provider_streams ps2 LEFT JOIN sc_languages l2 ON l2.id=ps2.language_id
        WHERE ps2.title_id=t.id AND ps2.kind=$1 AND ps2.active
        ORDER BY (l2.code=$3) DESC,(l2.code='en') DESC,(l2.code='und') DESC,ps2.provider_id LIMIT 1) AS "streamId",
      jsonb_build_object('language',coalesce(l.name,'Unlabelled'),'languageCode',coalesce(l.code,'und'),'tmdbId',t.tmdb_id) AS metadata
    FROM sc_provider_streams ps JOIN sc_titles t ON t.id=ps.title_id
    LEFT JOIN sc_languages l ON l.id=ps.language_id
    LEFT JOIN LATERAL (SELECT tx.* FROM sc_title_translations tx JOIN sc_languages tl ON tl.id=tx.language_id
      WHERE tx.title_id=t.id ORDER BY (NULLIF(tx.description,'') IS NOT NULL) DESC,(tl.code='en') DESC,(tl.code='nl') DESC,(tl.code='pl') DESC,
        (tl.code=$3) DESC,
        (tx.source='tmdb') DESC,tx.language_id LIMIT 1) tx ON true
    WHERE ps.kind=$1 AND ps.provider_id=$2 AND ps.active AND t.kind=$1 LIMIT 1`, [kind, providerId, languageCode]);
  return rows[0] ?? null;
}

export async function saveProviderTitleDescription(kind: 'movie' | 'series', providerId: string, description: string): Promise<void> {
  const normalized = description.trim();
  if (!normalized) return;
  await pool.query(`INSERT INTO sc_title_translations(title_id,language_id,display_title,description,source)
    SELECT t.id,COALESCE(ps.language_id,(SELECT id FROM sc_languages WHERE code='und')),
      COALESCE(existing.display_title,t.original_title),$3,'provider'
    FROM sc_provider_streams ps JOIN sc_titles t ON t.id=ps.title_id
    LEFT JOIN sc_title_translations existing ON existing.title_id=t.id AND existing.language_id=ps.language_id
    WHERE ps.kind=$1 AND ps.provider_id=$2 AND ps.active
    ON CONFLICT(title_id,language_id) DO UPDATE SET
      description=COALESCE(NULLIF(sc_title_translations.description,''),EXCLUDED.description),
      updated_at=CASE WHEN NULLIF(sc_title_translations.description,'') IS NULL THEN now() ELSE sc_title_translations.updated_at END`,
    [kind, providerId, normalized]);
}

export async function getNormalizedSeriesTitle(providerId: string) {
  const { rows } = await pool.query(`SELECT t.id::text AS id,t.tmdb_id AS "tmdbId"
    FROM sc_provider_streams ps JOIN sc_titles t ON t.id=ps.title_id
    WHERE ps.kind='series' AND ps.provider_id=$1 AND ps.active AND t.kind='series' LIMIT 1`, [providerId]);
  return rows[0] ?? null;
}

export async function listNormalizedSeasons(seriesProviderId: string) {
  const { rows } = await pool.query(`SELECT se.season_number AS number,count(DISTINCT se.episode_title_id)::integer AS count
    FROM sc_provider_streams parent JOIN sc_series_episodes se ON se.series_title_id=parent.title_id
    JOIN sc_provider_streams ep ON ep.title_id=se.episode_title_id AND ep.kind='episode' AND ep.active
    WHERE parent.kind='series' AND parent.provider_id=$1 AND parent.active
    GROUP BY se.season_number ORDER BY se.season_number`, [seriesProviderId]);
  return rows;
}

export async function listNormalizedEpisodes(seriesProviderId: string, seasonNumber: number, page: number, limit: number, languageCode = 'en') {
  const { rows } = await pool.query(`SELECT ep.provider_id AS id,t.id::text AS "canonicalId",'episode'::text AS kind,
      ${normalizedTitleSql(`COALESCE((SELECT title_tx.display_title FROM sc_title_translations title_tx
        JOIN sc_languages title_lang ON title_lang.id=title_tx.language_id
        WHERE title_tx.title_id=t.id AND title_tx.source='tmdb'
        ORDER BY (title_lang.code=$4) DESC,(title_lang.code='en') DESC,title_tx.language_id LIMIT 1),t.original_title)`)} AS title,tx.description,COALESCE(tx.poster_url,t.poster_url) AS "posterUrl",
      se.season_number AS "seasonNumber",se.episode_number AS "episodeNumber",t.runtime_seconds AS "durationSeconds",
      ep.provider_id AS "streamId",l.name AS language
    FROM sc_provider_streams parent JOIN sc_series_episodes se ON se.series_title_id=parent.title_id
    JOIN sc_titles t ON t.id=se.episode_title_id
    JOIN LATERAL (SELECT p.* FROM sc_provider_streams p LEFT JOIN sc_languages pl ON pl.id=p.language_id
      WHERE p.title_id=t.id AND p.kind='episode' AND p.active
      ORDER BY (pl.code=$4) DESC,(pl.code='en') DESC,(pl.code='und') DESC,p.provider_id LIMIT 1) ep ON true
    LEFT JOIN sc_languages l ON l.id=ep.language_id
    LEFT JOIN LATERAL (SELECT x.* FROM sc_title_translations x JOIN sc_languages xl ON xl.id=x.language_id
      WHERE x.title_id=t.id ORDER BY (NULLIF(x.description,'') IS NOT NULL) DESC,(xl.code='en') DESC,(xl.code='nl') DESC,(xl.code='pl') DESC,(xl.code=$4) DESC,
        (x.source='tmdb') DESC,x.language_id LIMIT 1) tx ON true
    WHERE parent.kind='series' AND parent.provider_id=$1 AND parent.active AND se.season_number=$2
    ORDER BY se.episode_number,ep.provider_id LIMIT $3 OFFSET $5`,
  [seriesProviderId, seasonNumber, limit, languageCode, (page - 1) * limit]);
  return rows;
}

export async function listNormalizedEpisodeStreams(providerId: string, languageCode = 'en') {
  const { rows } = await pool.query(`SELECT p.provider_id AS id,p.provider_id AS "providerId",
      l.name AS language,l.code AS "languageCode",p.stream_extension AS extension
    FROM sc_provider_streams current_stream
    JOIN sc_provider_streams p ON p.title_id=current_stream.title_id AND p.kind='episode' AND p.active
    LEFT JOIN sc_languages l ON l.id=p.language_id
    WHERE current_stream.kind='episode' AND current_stream.provider_id=$1 AND current_stream.active
    ORDER BY (l.code=$2) DESC,(l.code='und') DESC,p.provider_id`, [providerId, languageCode]);
  return rows;
}

export async function listNormalizedHomeCatalog(limit = 50_000, languageCode = 'en') {
  const { rows } = await pool.query(`SELECT DISTINCT ON (t.id) t.kind,ps.provider_id AS id,
      COALESCE(tx.display_title,t.original_title) AS title,description_tx.description,
      COALESCE(tx.poster_url,t.poster_url) AS "posterUrl",t.backdrop_url AS "backdropUrl",
      (SELECT string_agg(DISTINCT g.name, ', ' ORDER BY g.name) FROM sc_title_genres tg JOIN sc_genres g ON g.id=tg.genre_id WHERE tg.title_id=t.id) AS genre,
      t.release_year AS "releaseYear",t.rating,t.tmdb_id AS "tmdbId"
    FROM sc_titles t JOIN sc_provider_streams ps ON ps.title_id=t.id AND ps.kind=t.kind AND ps.active
    LEFT JOIN sc_title_translations tx ON tx.title_id=t.id AND tx.language_id=(SELECT id FROM sc_languages WHERE code=$2)
    LEFT JOIN LATERAL (SELECT x.description FROM sc_title_translations x JOIN sc_languages xl ON xl.id=x.language_id
      WHERE x.title_id=t.id AND NULLIF(x.description,'') IS NOT NULL
      ORDER BY CASE xl.code WHEN 'en' THEN 0 WHEN 'nl' THEN 1 WHEN 'pl' THEN 2 ELSE 3 END,x.language_id LIMIT 1) description_tx ON true
    WHERE t.kind IN ('movie','series') ORDER BY t.id,ps.provider_id LIMIT $1`, [limit, languageCode]);
  return rows;
}
