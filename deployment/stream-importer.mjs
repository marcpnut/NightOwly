import pg from 'pg';
import readline from 'node:readline/promises';

const { Client } = pg;
const client = new Client({ host: '/var/run/postgresql', database: 'streamcinema', user: 'streamcinema' });
const aliases = {
  nl: ['nl', 'Dutch'], dutch: ['nl', 'Dutch'], nederlands: ['nl', 'Dutch'], ned: ['nl', 'Dutch'],
  en: ['en', 'English'], eng: ['en', 'English'], english: ['en', 'English'],
  fr: ['fr', 'French'], french: ['fr', 'French'], de: ['de', 'German'], german: ['de', 'German'],
  es: ['es', 'Spanish'], spanish: ['es', 'Spanish'], it: ['it', 'Italian'], italian: ['it', 'Italian'],
  ar: ['ar', 'Arabic'], arabic: ['ar', 'Arabic'], tr: ['tr', 'Turkish'], turkish: ['tr', 'Turkish'],
  pl: ['pl', 'Polish'], polish: ['pl', 'Polish'], pt: ['pt', 'Portuguese'], portuguese: ['pt', 'Portuguese'],
  ru: ['ru', 'Russian'], russian: ['ru', 'Russian'], hi: ['hi', 'Hindi'], hindi: ['hi', 'Hindi']
};
const fixedColumns = [
  ['kind', 'text'], ['provider_id', 'text'], ['parent_provider_id', 'text'], ['category_id', 'text'],
  ['category_name', 'text'], ['provider_name', 'text'], ['title', 'text'], ['language', 'text'],
  ['release_year', 'integer'], ['season_number', 'integer'], ['episode_number', 'integer'],
  ['stream_extension', 'text'], ['playback_path_template', 'text'], ['raw_payload', 'jsonb']
];
const knownColumns = new Set(fixedColumns.map(([name]) => name));
const dynamicValues = new Map();
const batches = new Map();
const startedAt = new Date().toISOString();
let inserted = 0;
let credentials;
let playbackBase;
let liveExtension = 'm3u8';

function infoOf(record) {
  return record.info && typeof record.info === 'object' && !Array.isArray(record.info) ? record.info : {};
}
function cleanField(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'field';
}
function quoteIdentifier(value) {
  if (!/^provider_[a-z0-9_]{1,56}$/.test(value)) throw new Error('Unsafe provider field identifier.');
  return `"${value}"`;
}
function dynamicFields(record) {
  const fields = new Map();
  for (const [key, value] of Object.entries(record)) {
    if (key === 'info') {
      fields.set('provider_field_info', value);
      for (const [infoKey, infoValue] of Object.entries(infoOf(record))) fields.set(`provider_field_info_${cleanField(infoKey)}`, infoValue);
    } else fields.set(`provider_field_${cleanField(key)}`, value);
  }
  return fields;
}
async function ensureColumns(fields) {
  for (const name of fields.keys()) {
    if (knownColumns.has(name)) continue;
    await client.query(`ALTER TABLE streams ADD COLUMN IF NOT EXISTS ${quoteIdentifier(name)} jsonb`);
    knownColumns.add(name);
  }
}
function parseName(rawValue) {
  const raw = String(rawValue ?? '').trim().replace(/\s+/g, ' ');
  let title = raw;
  let language;
  const prefix = title.match(/^\s*\|?\s*([\p{L}]{2,20})\s*\|\s*/u);
  if (prefix && aliases[prefix[1].toLowerCase()]) {
    language = aliases[prefix[1].toLowerCase()][1];
    title = title.slice(prefix[0].length).trim();
  }
  const yearMatch = title.match(/\s*\(((?:19|20)\d{2})\)\s*$/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  if (yearMatch) title = title.slice(0, yearMatch.index).trim();
  return { raw: raw || 'Untitled', title: title || raw || 'Untitled', language, year };
}
function yearOf(value) {
  const match = String(value ?? '').match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : undefined;
}
function idOf(value) {
  const id = value === undefined || value === null ? '' : String(value);
  return /^\d+$/.test(id) ? id : null;
}
function extension(value, fallback = 'mp4') {
  const ext = String(value ?? fallback).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : fallback;
}
function playbackTemplate(kind, id, ext) {
  if (!id || kind === 'series') return null;
  const pathKind = kind === 'episode' ? 'series' : kind;
  const suffix = kind === 'live' ? liveExtension : extension(ext);
  return `${playbackBase}/${pathKind}/{username}/{password}/${id}.${suffix}`;
}
function mapped(kind, raw, options = {}) {
  const id = options.id ?? idOf(kind === 'series' ? raw.series_id : raw.stream_id ?? raw.id);
  if (!id) return null;
  const info = infoOf(raw);
  const parsed = parseName(raw.name ?? raw.title ?? `Untitled ${id}`);
  const language = String(info.language ?? parsed.language ?? '').trim() || null;
  const releaseYear = yearOf(raw.releaseDate ?? info.releasedate ?? raw.year) ?? parsed.year ?? null;
  const ext = kind === 'movie' || kind === 'episode' ? extension(raw.container_extension) : kind === 'live' ? liveExtension : null;
  return {
    kind, provider_id: id, parent_provider_id: options.parentId ?? null,
    category_id: options.categoryId ?? idOf(raw.category_id), category_name: options.categoryName ?? null,
    provider_name: parsed.raw, title: parsed.title, language, release_year: releaseYear,
    season_number: options.seasonNumber ?? null, episode_number: options.episodeNumber ?? null,
    stream_extension: ext, playback_path_template: playbackTemplate(kind, id, ext), raw_payload: raw
  };
}
async function flush(kind) {
  const pending = batches.get(kind);
  if (!pending?.length) return;
  const fields = new Map();
  for (const row of pending) for (const [key, value] of row._dynamic) fields.set(key, value);
  await ensureColumns(fields);
  const dynamicNames = [...fields.keys()].sort();
  const columns = [...fixedColumns.map(([name]) => name), ...dynamicNames];
  const tuples = [];
  const values = [];
  for (const row of pending) {
    const offset = values.length;
    const vals = fixedColumns.map(([name]) => row[name]);
    for (const name of dynamicNames) vals.push(row._dynamic.has(name) ? row._dynamic.get(name) : null);
    values.push(...vals.map((value, index) => index === fixedColumns.length - 1 || index >= fixedColumns.length ? value === null ? null : JSON.stringify(value) : value));
    const placeholders = vals.map((_, index) => `$${offset + index + 1}${index >= fixedColumns.length || index === fixedColumns.length - 1 ? '::jsonb' : ''}`);
    tuples.push(`(${placeholders.join(',')})`);
  }
  const update = columns.filter((name) => name !== 'kind' && name !== 'provider_id' && name !== 'first_seen_at').map((name) => `${name === 'raw_payload' ? name : name.startsWith('provider_') ? quoteIdentifier(name) : name}=EXCLUDED.${name === 'raw_payload' ? name : name.startsWith('provider_') ? quoteIdentifier(name) : name}`);
  const sql = `INSERT INTO streams (${columns.map((name) => name.startsWith('provider_') ? quoteIdentifier(name) : name).join(',')}) VALUES ${tuples.join(',')} ON CONFLICT(kind,provider_id) DO UPDATE SET ${update.join(',')},active=true,last_seen_at=now()`;
  await client.query(sql, values);
  inserted += pending.length;
  if (inserted % 500 < pending.length) process.stdout.write(`Imported or updated ${inserted} streams so far.\n`);
  batches.set(kind, []);
}
async function saveRecord(row) {
  row._dynamic = dynamicFields(row.raw_payload);
  const pending = batches.get(row.kind) ?? [];
  pending.push(row);
  batches.set(row.kind, pending);
  if (pending.length >= 50) await flush(row.kind);
}
async function request(action, extra = {}) {
  const url = new URL('player_api.php', credentials.baseUrl.replace(/\/+$/, '') + '/');
  url.search = new URLSearchParams({ username: credentials.username, password: credentials.password, action, ...extra }).toString();
  let response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(90000), headers: { accept: 'application/json' } }); }
  catch { throw new Error('Provider request failed; credentials and URL are not printed.'); }
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > 120_000_000) throw new Error('Provider response exceeded 120 MB.');
  try { return JSON.parse(text); } catch { throw new Error(`Provider returned invalid JSON for ${action}.`); }
}
function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`Provider response for ${label} was not a list; existing rows were left intact.`);
  return value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}
async function fetchRetry(action, extra = {}) {
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await request(action, extra); }
    catch (failure) { error = failure; if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt)); }
  }
  throw error;
}
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const baseUrl = (await rl.question('Xtream base URL: ')).trim();
  const username = (await rl.question('Xtream username: ')).trim();
  rl.close();
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('Run this importer in an interactive terminal to enter the password securely.');
  process.stdout.write('Xtream password (input hidden): ');
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  const password = await new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); process.stdout.write('\n'); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    const cleanup = () => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); };
    stdin.on('data', onData);
  });
  credentials = { baseUrl: new URL(baseUrl).origin + new URL(baseUrl).pathname.replace(/\/+$/, ''), username, password };
  if (!['http:', 'https:'].includes(new URL(credentials.baseUrl).protocol) || !username || !password) throw new Error('Provider URL, username, or password is invalid.');
  await client.connect();
  const auth = await fetchRetry('');
  const user = auth?.user_info && typeof auth.user_info === 'object' ? auth.user_info : {};
  if (user.auth === 0 || String(user.status ?? '').toLowerCase() === 'disabled') throw new Error('Provider rejected this login.');
  const server = auth?.server_info && typeof auth.server_info === 'object' ? auth.server_info : {};
  try {
    const scheme = server.server_protocol === 'http' || server.server_protocol === 'https' ? server.server_protocol : new URL(credentials.baseUrl).protocol.slice(0, -1);
    const serverUrl = new URL(`${scheme}://${String(server.url ?? '')}`);
    if (serverUrl.username || serverUrl.password || serverUrl.pathname !== '/' || serverUrl.search || serverUrl.hash) throw new Error('Invalid playback host.');
    if (!serverUrl.port && server.port) serverUrl.port = String(server.port);
    playbackBase = serverUrl.origin;
  } catch { playbackBase = new URL(credentials.baseUrl).origin; }
  const allowed = Array.isArray(user.allowed_output_formats) ? user.allowed_output_formats.map((value) => String(value).toLowerCase()) : [];
  liveExtension = allowed.includes('m3u8') ? 'm3u8' : allowed.includes('ts') ? 'ts' : 'm3u8';
  process.stdout.write('Login verified. Fetching categories and stream lists…\n');
  const kinds = [
    { kind: 'live', cats: 'get_live_categories', list: 'get_live_streams' },
    { kind: 'movie', cats: 'get_vod_categories', list: 'get_vod_streams' },
    { kind: 'series', cats: 'get_series_categories', list: 'get_series' }
  ];
  for (const dataset of kinds) {
    const categories = array(await fetchRetry(dataset.cats), dataset.cats);
    const categoryNames = new Map(categories.map((entry) => [String(entry.category_id), String(entry.category_name ?? entry.name ?? entry.category_id)]));
    const items = array(await fetchRetry(dataset.list), dataset.list);
    if (!items.length) throw new Error(`Provider returned an empty ${dataset.kind} list; existing rows were left intact.`);
    for (let offset = 0; offset < items.length; offset += 50) {
      for (const raw of items.slice(offset, offset + 50)) {
        const row = mapped(dataset.kind, raw, { categoryName: categoryNames.get(String(raw.category_id)) ?? null });
        if (row) await saveRecord(row);
      }
      await flush(dataset.kind);
    }
    await client.query('UPDATE streams SET active=false WHERE kind=$1 AND last_seen_at < $2', [dataset.kind, startedAt]);
    process.stdout.write(`${dataset.kind}: ${items.length} provider entries processed.\n`);
  }
  const { rows: series } = await client.query("SELECT provider_id,category_id,category_name FROM streams WHERE kind='series' AND active ORDER BY provider_id");
  if (series.length) {
    process.stdout.write(`Importing episode streams for ${series.length} series (this can take a while)…\n`);
    let completed = 0;
    for (const item of series) {
      const detail = await fetchRetry('get_series_info', { series_id: item.provider_id });
      const groups = detail?.episodes && typeof detail.episodes === 'object' ? detail.episodes : {};
      for (const [seasonKey, entries] of Object.entries(groups)) {
        if (!Array.isArray(entries)) continue;
        for (const episode of entries) {
          if (!episode || typeof episode !== 'object') continue;
          const raw = episode;
          const row = mapped('episode', raw, { id: idOf(raw.id), parentId: item.provider_id,
            categoryId: item.category_id, categoryName: item.category_name,
            seasonNumber: Number(raw.season ?? seasonKey) || 0, episodeNumber: Number(raw.episode_num) || 0 });
          if (row) await saveRecord(row);
        }
      }
      completed++;
      if (completed % 100 === 0) process.stdout.write(`Episode details: ${completed}/${series.length} series processed.\n`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await flush('episode');
    await client.query("UPDATE streams SET active=false WHERE kind='episode' AND last_seen_at < $1", [startedAt]);
  }
  const { rows: counts } = await client.query('SELECT kind,count(*)::bigint AS count FROM streams WHERE active GROUP BY kind ORDER BY kind');
  process.stdout.write(`Import complete. Active rows by kind: ${counts.map((row) => `${row.kind}=${row.count}`).join(', ')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Import failed.'}\n`);
  process.exitCode = 1;
}).finally(async () => {
  credentials = undefined;
  await client.end().catch(() => {});
});
