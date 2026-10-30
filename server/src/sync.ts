import { pool, loadProvider, upsertRecords } from './database.js';
import { mapCatalogItem, mapEpisodes, providerPlaybackInfo, requestProvider, type CatalogRecord, type ProviderCredentials } from './provider.js';
import type pg from 'pg';

type Dataset = 'live' | 'movie' | 'series' | 'episodes';
const datasets: Array<{ kind: Exclude<Dataset, 'episodes'>; categories: string; streams: string }> = [
  { kind: 'live', categories: 'get_live_categories', streams: 'get_live_streams' },
  { kind: 'movie', categories: 'get_vod_categories', streams: 'get_vod_streams' },
  { kind: 'series', categories: 'get_series_categories', streams: 'get_series' }
];
const lockId = 190086;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await work(); } catch (error) { last = error; if (attempt < 2) await pause(1000 * (2 ** attempt)); }
  }
  throw last;
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('Provider returned a non-array catalog.');
  return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item));
}

async function updateStatus(client: pg.PoolClient, dataset: Dataset, status: string, error?: string, count?: number, cursor?: string | null): Promise<void> {
  await client.query(`INSERT INTO sync_state(dataset,status,last_attempt_at,last_success_at,last_error,row_count,cursor)
    VALUES($1,$2,now(),CASE WHEN $2='success' THEN now() ELSE NULL END,$3,COALESCE($4,0),$5)
    ON CONFLICT(dataset) DO UPDATE SET status=EXCLUDED.status,last_attempt_at=now(),
    last_success_at=CASE WHEN $2='success' THEN now() ELSE sync_state.last_success_at END,
    last_error=$3,row_count=COALESCE($4,sync_state.row_count),cursor=COALESCE($5,sync_state.cursor)`,
    [dataset, status, error ?? null, count ?? null, cursor ?? null]);
}

async function syncDataset(client: pg.PoolClient, provider: ProviderCredentials, dataset: typeof datasets[number]): Promise<void> {
  const started = new Date();
  await updateStatus(client, dataset.kind, 'running');
  try {
    const categories = records(await retry(() => requestProvider(provider, dataset.categories)));
    const items = records(await retry(() => requestProvider(provider, dataset.streams)));
    if (!items.length) throw new Error('Provider returned an empty catalog; previous catalog retained.');
    for (const raw of categories) {
      const id = String(raw.category_id ?? '');
      if (!id) continue;
      await client.query(`INSERT INTO categories(kind,id,name,active,last_seen_at) VALUES($1,$2,$3,true,now())
        ON CONFLICT(kind,id) DO UPDATE SET name=EXCLUDED.name,active=true,last_seen_at=now()`,
        [dataset.kind, id, String(raw.category_name ?? id)]);
    }
    let count = 0;
    for (let offset = 0; offset < items.length; offset += 100) {
      const batch = items.slice(offset, offset + 100).map((raw) => mapCatalogItem(dataset.kind, raw)).filter((item): item is CatalogRecord => !!item);
      await client.query('BEGIN');
      try {
        await upsertRecords(batch, client);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      count += batch.length;
      await client.query(`UPDATE sync_state SET cursor=$2 WHERE dataset=$1`, [dataset.kind, String(offset + batch.length)]);
    }
    if (!count) throw new Error('No valid provider records; previous catalog retained.');
    await client.query(`UPDATE catalog SET active=false WHERE kind=$1 AND last_seen_at < $2`, [dataset.kind, started]);
    await client.query(`UPDATE provider_streams SET active=false WHERE kind=$1 AND last_seen_at < $2`, [dataset.kind, started]);
    await client.query(`UPDATE media_items m SET active=false,updated_at=now() WHERE m.kind=$1 AND NOT EXISTS
      (SELECT 1 FROM provider_streams ps WHERE ps.media_item_id=m.id AND ps.active)`, [dataset.kind]);
    if (categories.length) await client.query(`UPDATE categories SET active=false WHERE kind=$1 AND last_seen_at < $2`, [dataset.kind, started]);
    await updateStatus(client, dataset.kind, 'success', undefined, count, '0');
  } catch (error) {
    await updateStatus(client, dataset.kind, 'error', error instanceof Error ? error.message.slice(0, 200) : 'Sync failed');
  }
}

async function syncEpisodes(client: pg.PoolClient, provider: ProviderCredentials): Promise<void> {
  await updateStatus(client, 'episodes', 'running');
  const previous = await client.query<{ cursor: string | null }>(`SELECT cursor FROM sync_state WHERE dataset='episodes'`);
  let cursor = previous.rows[0]?.cursor ?? '0';
  let count = 0;
  try {
    for (;;) {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM catalog WHERE kind='series' AND active=true
        AND (detail_synced_at IS NULL OR detail_synced_at < now() - interval '7 days')
        AND id::bigint > $1::bigint ORDER BY id::bigint LIMIT 20`, [cursor]);
      if (!rows.length) break;
      for (const row of rows) {
        const details = await retry(() => requestProvider(provider, 'get_series_info', { series_id: row.id }));
        if (details && typeof details === 'object' && !Array.isArray(details)) {
          const detailStarted = new Date();
          const episodes = mapEpisodes(row.id, details as Record<string, unknown>);
          if (episodes.length) {
            await upsertRecords(episodes, client);
            await client.query(`UPDATE catalog SET active=false WHERE kind='episode' AND parent_id=$1 AND last_seen_at < $2`, [row.id, detailStarted]);
            count += episodes.length;
          }
          await client.query(`UPDATE catalog SET detail_synced_at=now() WHERE kind='series' AND id=$1`, [row.id]);
        }
        cursor = row.id;
        await client.query(`UPDATE sync_state SET cursor=$2 WHERE dataset=$1`, ['episodes', cursor]);
        await pause(250);
      }
    }
    await updateStatus(client, 'episodes', 'success', undefined, count, '0');
  } catch (error) {
    await updateStatus(client, 'episodes', 'error', error instanceof Error ? error.message.slice(0, 200) : 'Episode sync failed', count, cursor);
  }
}

export async function runSync(key: Buffer): Promise<boolean> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
    if (!lock.rows[0]?.locked) return false;
    try {
      const provider = await loadProvider(key);
      if (!provider) return false;
      try {
        const auth = await retry(() => requestProvider(provider, ''));
        const playback = providerPlaybackInfo(provider, auth);
        await client.query(`UPDATE provider_config SET playback_base_url=$1,allowed_live_formats=$2 WHERE id='primary'`,
          [playback.playbackBaseUrl ?? null, JSON.stringify(playback.allowedLiveFormats)]);
        provider.playbackBaseUrl = playback.playbackBaseUrl;
        provider.allowedLiveFormats = playback.allowedLiveFormats;
      } catch { /* List endpoints can still work when auth metadata is unavailable. */ }
      for (const dataset of datasets) await syncDataset(client, provider, dataset);
      await syncEpisodes(client, provider);
      return true;
    } finally { await client.query('SELECT pg_advisory_unlock($1)', [lockId]); }
  } finally { client.release(); }
}
