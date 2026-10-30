const API_ROOT = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'StreamCinema v0.1.0';
let apiKey = '';

export function configureOpenSubtitles(value: string | null): void { apiKey = value?.trim() ?? ''; }
export function openSubtitlesConfigured(): boolean { return Boolean(apiKey); }

async function request(url: URL, init: RequestInit = {}): Promise<Response> {
  if (!apiKey) throw new Error('Add your OpenSubtitles API key in Settings first.');
  const headers = new Headers(init.headers);
  headers.set('Api-Key', apiKey);
  headers.set('Accept', 'application/json');
  headers.set('User-Agent', USER_AGENT);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) {
    if (response.status === 429) throw new Error('OpenSubtitles rate limit reached. Try again later.');
    if (response.status === 401 || response.status === 403) throw new Error('OpenSubtitles rejected the API key or requires account login for this download.');
    throw new Error(`OpenSubtitles request failed (${response.status}).`);
  }
  return response;
}

export type SubtitleSearchInput = {
  query: string; language: string; kind: 'movie' | 'episode'; tmdbId?: string;
  seasonNumber?: number; episodeNumber?: number;
};

export async function searchOpenSubtitles(input: SubtitleSearchInput) {
  const url = new URL(`${API_ROOT}/subtitles`);
  url.searchParams.set('languages', input.language);
  url.searchParams.set('type', input.kind);
  const hasTmdbId = Boolean(input.tmdbId && /^\d+$/.test(input.tmdbId));
  if (hasTmdbId) url.searchParams.set(input.kind === 'episode' ? 'parent_tmdb_id' : 'tmdb_id', input.tmdbId!);
  else url.searchParams.set('query', input.query.toLowerCase());
  if (input.kind === 'episode') {
    if (input.seasonNumber !== undefined) url.searchParams.set('season_number', String(input.seasonNumber));
    if (input.episodeNumber !== undefined) url.searchParams.set('episode_number', String(input.episodeNumber));
  }
  url.searchParams.set('page', '1');
  const response = await request(url);
  let payload = await response.json() as { data?: Array<{ id?: string; attributes?: Record<string, any> }> };
  // A stale/mismatched TMDB ID should not block a title search. This follows
  // NextFlix's title-first behavior while preferring precise IDs when valid.
  if (!(payload.data?.length) && hasTmdbId) {
    const fallback = new URL(`${API_ROOT}/subtitles`);
    fallback.searchParams.set('languages', input.language);
    fallback.searchParams.set('type', input.kind);
    fallback.searchParams.set('query', input.query.toLowerCase());
    if (input.kind === 'episode') {
      if (input.seasonNumber !== undefined) fallback.searchParams.set('season_number', String(input.seasonNumber));
      if (input.episodeNumber !== undefined) fallback.searchParams.set('episode_number', String(input.episodeNumber));
    }
    fallback.searchParams.set('page', '1');
    payload = await (await request(fallback)).json() as typeof payload;
  }
  return (payload.data ?? []).flatMap((row) => {
    const attributes = row.attributes ?? {};
    return (Array.isArray(attributes.files) ? attributes.files : []).filter((file: any) => Number.isSafeInteger(Number(file.file_id))).map((file: any) => ({
      fileId: Number(file.file_id), language: String(attributes.language ?? input.language),
      release: String(attributes.release ?? attributes.feature_details?.title ?? file.file_name ?? 'Subtitle'),
      fileName: String(file.file_name ?? 'subtitle'), downloadCount: Number(attributes.download_count ?? 0),
      hearingImpaired: Boolean(attributes.hearing_impaired), rating: Number(attributes.ratings ?? 0),
    }));
  }).slice(0, 20);
}

export async function downloadOpenSubtitle(fileId: number): Promise<string> {
  const response = await request(new URL(`${API_ROOT}/download`), {
    method: 'POST', body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
  });
  const payload = await response.json() as { link?: string };
  if (!payload.link) throw new Error('OpenSubtitles did not return a download link.');
  const downloadUrl = new URL(payload.link);
  if (downloadUrl.protocol !== 'https:' || !(downloadUrl.hostname === 'opensubtitles.com' || downloadUrl.hostname.endsWith('.opensubtitles.com'))) {
    throw new Error('OpenSubtitles returned an unsupported subtitle download address.');
  }
  const fileResponse = await fetch(downloadUrl, { signal: AbortSignal.timeout(20_000) });
  if (!fileResponse.ok) throw new Error('The subtitle file could not be downloaded.');
  const bytes = await fileResponse.arrayBuffer();
  if (bytes.byteLength > 6 * 1024 * 1024) throw new Error('The subtitle file is too large.');
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT\b/i.test(text)) return `${text}\n`;
  const cues = text.replace(/^\d+\s*\n(?=\d{2}:\d{2}:\d{2}[,.])/gm, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  if (/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(cues)) return `WEBVTT\n\n${cues}\n`;
  throw new Error('The selected subtitle is not a supported WebVTT or SRT text file.');
}
