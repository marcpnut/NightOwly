import { makeApi } from './api.js';
import { hasNormalizedCatalog, loadOpenSubtitlesApiKey, loadProvider, migrate, pool, saveProvider } from './database.js';
import { encryptionKey } from './security.js';
import { runSync } from './sync.js';
import { seedMockCatalog } from './mock.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadTmdbToken, startTmdbArtworkBackfill } from './tmdb-on-demand.js';
import { configureOpenSubtitles } from './opensubtitles.js';
import { startNightlyPlaylistRefresh } from './normalized-sync.js';

async function main() {
  const apiToken = process.env.API_TOKEN;
  const credentialKey = process.env.CREDENTIAL_KEY;
  if (!apiToken || apiToken.length < 32) throw new Error('API_TOKEN must contain at least 32 characters.');
  if (!credentialKey) throw new Error('CREDENTIAL_KEY is required.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const key = encryptionKey(credentialKey);
  await migrate();
  await loadTmdbToken(key);
  await loadOpenSubtitlesApiKey(key).then(configureOpenSubtitles);
  const normalizedCatalog = await hasNormalizedCatalog();
  if (process.env.MOCK_CATALOG === '1') await seedMockCatalog();
  if (process.env.XTREAM_BASE_URL && process.env.XTREAM_USERNAME && process.env.XTREAM_PASSWORD) {
    const existing = await loadProvider(key);
    if (!existing || existing.baseUrl !== process.env.XTREAM_BASE_URL || existing.username !== process.env.XTREAM_USERNAME || existing.password !== process.env.XTREAM_PASSWORD) {
      await saveProvider({ baseUrl: process.env.XTREAM_BASE_URL, username: process.env.XTREAM_USERNAME, password: process.env.XTREAM_PASSWORD }, key);
    }
  }
  const app = makeApi({ apiToken, credentialKey: key });
  const clientRoot = new URL('../../client/dist/', import.meta.url);
  const indexHtml = fileURLToPath(new URL('index.html', clientRoot));
  const appScript = fileURLToPath(new URL('assets/app.js', clientRoot));
  const iconPng = fileURLToPath(new URL('icon.png', clientRoot));
  const brandLogoPng = fileURLToPath(new URL('nightowl-logo.png', clientRoot));
  app.get('/', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(await readFile(indexHtml)));
  app.get('/assets/app.js', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('application/javascript; charset=utf-8').send(await readFile(appScript)));
  app.get('/icon.png', async (_request, reply) => reply.type('image/png').send(await readFile(iconPng)));
  app.get('/nightowl-logo.png', async (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/png').send(await readFile(brandLogoPng)));
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host, port });
  startTmdbArtworkBackfill();
  const sync = () => void runSync(key).catch((error) => app.log.error({ err: error }, 'Catalog synchronization failed'));
  if (process.env.MOCK_CATALOG !== '1' && !normalizedCatalog) sync();
  const timer = process.env.MOCK_CATALOG === '1' || normalizedCatalog ? undefined : setInterval(sync, Number(process.env.SYNC_INTERVAL_HOURS ?? 12) * 3_600_000);
  const playlistTimer = process.env.MOCK_CATALOG === '1' || !normalizedCatalog ? undefined : startNightlyPlaylistRefresh(key);
  const stop = async () => { if (timer) clearInterval(timer); if (playlistTimer) clearInterval(playlistTimer); await app.close(); await pool.end(); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Startup failed.'); process.exitCode = 1; });
