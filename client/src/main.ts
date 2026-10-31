import './style.css';

// LG webOS 4.5 ships Chromium 53. Keep the webOS bundle clear of newer DOM
// helpers that are absent there. New browsers and the browser build are left
// untouched.
if (document.body.classList.contains('webos-client')) {
  const legacyElementPrototype = Element.prototype as unknown as {
    append?: (...items: Array<Node | string>) => void;
    replaceWith?: (...items: Array<Node | string>) => void;
    replaceChildren?: (...items: Array<Node | string>) => void;
    scrollBy?: (options: ScrollToOptions | number, y?: number) => void;
    scrollIntoView: (options?: boolean | ScrollIntoViewOptions) => void;
  };
  if (typeof legacyElementPrototype.append !== 'function') {
    Object.defineProperty(Element.prototype, 'append', { configurable: true, writable: true, value: function(this: Element, ...items: Array<Node | string>): void {
      items.forEach((item) => this.appendChild(typeof item === 'string' ? document.createTextNode(item) : item));
    }});
  }
  if (typeof legacyElementPrototype.replaceWith !== 'function') {
    Object.defineProperty(Element.prototype, 'replaceWith', { configurable: true, writable: true, value: function(this: Element, ...items: Array<Node | string>): void {
      const parent = this.parentNode;
      if (!parent) return;
      const replacement = document.createDocumentFragment();
      items.forEach((item) => replacement.appendChild(typeof item === 'string' ? document.createTextNode(item) : item));
      parent.replaceChild(replacement, this);
    }});
  }
  if (typeof legacyElementPrototype.replaceChildren !== 'function') {
    Object.defineProperty(Element.prototype, 'replaceChildren', { configurable: true, writable: true, value: function(this: Element, ...items: Array<Node | string>): void {
      while (this.firstChild) this.removeChild(this.firstChild);
      items.forEach((item) => this.appendChild(typeof item === 'string' ? document.createTextNode(item) : item));
    }});
  }
  Object.defineProperty(Element.prototype, 'scrollBy', { configurable: true, writable: true, value: function(this: Element, options: ScrollToOptions | number, y?: number): void {
    const left = typeof options === 'number' ? options : options.left ?? 0;
    const top = typeof options === 'number' ? y ?? 0 : options.top ?? 0;
    this.scrollLeft += left; this.scrollTop += top;
  }});
  const nativeScrollIntoView = legacyElementPrototype.scrollIntoView;
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: function(this: Element, options?: boolean | ScrollIntoViewOptions): void {
    if (!options || typeof options !== 'object' || options.block !== 'nearest' && options.inline !== 'nearest') {
      nativeScrollIntoView.call(this, options);
      return;
    }
    let ancestor = this.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      const scrollsVertically = /(auto|scroll)/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight;
      const scrollsHorizontally = /(auto|scroll)/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;
      const item = this.getBoundingClientRect();
      const bounds = ancestor.getBoundingClientRect();
      if (scrollsVertically && item.top < bounds.top) ancestor.scrollTop += item.top - bounds.top;
      else if (scrollsVertically && item.bottom > bounds.bottom) ancestor.scrollTop += item.bottom - bounds.bottom;
      if (scrollsHorizontally && item.left < bounds.left) ancestor.scrollLeft += item.left - bounds.left;
      else if (scrollsHorizontally && item.right > bounds.right) ancestor.scrollLeft += item.right - bounds.right;
      ancestor = ancestor.parentElement;
    }
    const bounds = this.getBoundingClientRect();
    if (bounds.top < 0) window.scrollTo(window.scrollX, window.scrollY + bounds.top);
    else if (bounds.bottom > window.innerHeight) window.scrollTo(window.scrollX, window.scrollY + bounds.bottom - window.innerHeight);
  }});
}

type Kind = 'movie' | 'series' | 'live' | 'episode';
type DescriptionStatus = 'available' | 'none' | 'unavailable';
type Item = { kind: Kind; id: string; title: string; description?: string; posterUrl?: string; backdropUrl?: string;
  descriptionStatus?: DescriptionStatus;
  genre?: string; releaseYear?: number; durationSeconds?: number; rating?: number; positionSeconds?: number; seasonNumber?: number; episodeNumber?: number;
  streamId?: string; canonicalId?: string; streams?: Array<{ id: string; providerId?: string; language?: string; languageCode?: string; extension?: string }>;
  seriesId?: string; seriesTitle?: string; highlightEpisodeCanonicalId?: string; highlightSeasonNumber?: number;
  metadata?: { language?: string; languageCode?: string; audio?: string; subtitles?: string; tmdbId?: string } };
type Profile = { id: string; name: string; preferences?: { language?: string } };
type Home = { featured: Item | null; discoverySource?: 'tmdb' | 'catalog'; attribution?: boolean; rows: Array<{ id: string; title: string; items: Item[] }> };
type CatalogPage = { items: Item[]; hasMore: boolean };
type BrowseCategory = { id: string; name: string; type?: string; itemCount?: number };
type AppLanguage = { code: string; name: string };
type Config = { url: string; token: string };
type View = 'home' | 'whats-new' | 'movies' | 'series' | 'live' | 'my-list' | 'search' | 'settings' | 'detail' | 'profiles' | 'database';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const centralFullscreenButton = el<HTMLButtonElement>('central-fullscreen');
if (document.body.classList.contains('webos-client')) centralFullscreenButton.parentNode?.removeChild(centralFullscreenButton);
const setup = el('central-setup');
const app = el('central-app');
const content = el('central-content');
const status = el('central-status');
const video = el<HTMLVideoElement>('central-video');
const player = el('central-player');
const playerStatus = el('central-player-status');
const profileButton = el<HTMLButtonElement>('central-profile');
const pageScrollControls = el<HTMLElement>('central-page-scroll-controls');
const pageUpButton = el<HTMLButtonElement>('central-page-up');
const pageDownButton = el<HTMLButtonElement>('central-page-down');
if (document.body.classList.contains('webos-client')) {
  // Chromium 53 can leave the old remote focus ring visible after pointer
  // hover. Transfer DOM focus on the delegated mouse event so only the tile
  // under the pointer owns the focus styling.
  content.addEventListener('mouseover', (event) => {
    const target = (event.target as Element | null)?.closest<HTMLButtonElement>('.central-card');
    if (!target || !content.contains(target) || document.activeElement === target) return;
    const previous = document.activeElement as HTMLElement | null;
    if (previous && content.contains(previous) && previous.matches('.central-card')) previous.blur();
    target.focus();
  });
}
function renderProfileButton(): void {
  profileButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"/></svg>';
}
let config: Config | null = null;
function deviceIdentifier(): string {
  const stored = localStorage.getItem('streamcinema.device');
  if (stored && /^[0-9a-f-]{36}$/i.test(stored)) return stored;
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes).map((value) => (`0${value.toString(16)}`).slice(-2)).join('');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  localStorage.setItem('streamcinema.device', id);
  return id;
}
const deviceId = deviceIdentifier();
let profile: Profile | null = null;
let profiles: Profile[] = [];
const appLanguage = 'en';
let availableLanguages: AppLanguage[] = [];
let subtitleSearchLanguages: string[] = (() => {
  try { const value = JSON.parse(localStorage.getItem('streamcinema.subtitle-languages') || '[]'); return Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : []; }
  catch { return []; }
})();
let preferHearingImpairedSubtitles = localStorage.getItem('streamcinema.subtitle-hearing-impaired') === 'true';
let view: View = 'home';
let previousView: View = 'home';
let lastFocus: HTMLElement | null = null;
let restoreCardKey = '';
let currentItem: Item | null = null;
let playingItem: Item | null = null;
let livePreviewLoader: ((item: Item) => void) | null = null;
let livePreviewGeneration = 0;
let livePreviewSourceUrl = '';
let livePreviewSourceFormat: 'm3u8' | 'ts' = 'm3u8';
let page = 1;
let loadedItems: Item[] = [];
const selectedCategoryBySection: Record<'movies' | 'series' | 'live', string> = { movies: '', series: '', live: '' };
let selectedLiveCountry = '';
let hiddenLiveCategoryIds = (() => {
  try { const saved = JSON.parse(localStorage.getItem('streamcinema.hidden-live-categories') || '[]') as unknown; return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []); }
  catch { return new Set<string>(); }
})();
function readHiddenCategories(key: string): Set<string> {
  try { const saved = JSON.parse(localStorage.getItem(key) || '[]') as unknown; return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []); }
  catch { return new Set<string>(); }
}
let hiddenMovieCategoryIds = readHiddenCategories('streamcinema.hidden-movie-categories');
let hiddenSeriesCategoryIds = readHiddenCategories('streamcinema.hidden-series-categories');
let selectedLiveSearch = '';
let liveSearchTimer = 0;
let liveSearchGeneration = 0;
let requestGeneration = 0;
const activeControllers = new Set<AbortController>();
let lastProgressSave = 0;
let subtitlesIndex = -1;
let externalSubtitleTrack: HTMLTrackElement | null = null;
let externalSubtitleBlobUrl = '';
let activeLiveFormat: 'm3u8' | 'ts' = 'm3u8';
let activeRemuxMode: 'copy' | 'transcode' | null = null;
let remuxTranscodeAttempted = false;
let playerControlsTimer = 0;
const watched = new Map<string, number>();
const favorites = new Set<string>();
const catalogApiCache = new Map<string, { value: unknown; expiresAt: number }>();
const catalogApiInflight = new Map<string, Promise<unknown>>();
const apiCacheLifetime = 5 * 60_000;
let catalogApiRevision = 0;
const cachedViews = new Map<View, { content: DocumentFragment; scrollY: number; expiresAt: number }>();
const viewCacheLifetime = 5 * 60_000;
const cacheableViews = new Set<View>(['home', 'movies', 'series']);
const categoryViewScrollHandlers = new Map<View, () => void>();
let activeCategoryPageScrollHandler: (() => void) | null = null;
function playbackClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'LIVE';
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), rest = value % 60;
  const secondText = `0${rest}`.slice(-2);
  return hours ? `${hours}:${`0${minutes}`.slice(-2)}:${secondText}` : `${minutes}:${secondText}`;
}
function updatePlaybackProgress(): void {
  el('central-player-time').textContent = playbackClock(video.currentTime);
  el('central-player-duration').textContent = playbackClock(video.duration);
  const percent = Number.isFinite(video.duration) && video.duration > 0
    ? Math.max(0, Math.min(100, video.currentTime / video.duration * 100)) : 0;
  const seekbar = el<HTMLInputElement>('central-player-track');
  seekbar.style.setProperty('--progress-percent', `${percent}%`);
  seekbar.value = `${Math.round(percent * Number(seekbar.max) / 100)}`;
  seekbar.setAttribute('aria-valuenow', seekbar.value);
  seekbar.setAttribute('aria-valuetext', `${playbackClock(video.currentTime)} of ${playbackClock(video.duration)}`);
}
function revealPlayerControls(): void {
  window.clearTimeout(playerControlsTimer);
  player.classList.remove('controls-hidden');
  if (player.classList.contains('hidden') || video.paused || !el('central-player-stream-menu').classList.contains('hidden')) return;
  playerControlsTimer = window.setTimeout(() => {
    playerControlsTimer = 0;
    if (player.classList.contains('hidden') || video.paused || !el('central-player-stream-menu').classList.contains('hidden')) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && player.contains(active) && active !== video) active.blur();
    player.classList.add('controls-hidden');
  }, 5000);
}

function clear(node: HTMLElement): void { while (node.firstChild) node.removeChild(node.firstChild); }
type VerticalScrollControls = { root: HTMLElement; up: HTMLButtonElement; down: HTMLButtonElement; update: () => void };
const verticalScrollControls = new WeakMap<HTMLElement, VerticalScrollControls>();
function ensureVerticalScrollControls(wrapper: HTMLElement, pane: HTMLElement): void {
  let controls = verticalScrollControls.get(pane);
  if (!controls) {
    const root = node('div', 'central-series-scroll-controls');
    const makeButton = (direction: 'up' | 'down'): HTMLButtonElement => {
      const button = node('button', `central-series-scroll-${direction}`) as HTMLButtonElement;
      button.type = 'button'; button.setAttribute('aria-label', `Scroll ${direction}`);
      button.innerHTML = direction === 'up'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 15 7-7 7 7"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 9 7 7 7-7"/></svg>';
      button.onclick = () => pane.scrollBy({ top: (direction === 'up' ? -1 : 1) * Math.max(180, pane.clientHeight * .7), behavior: 'smooth' });
      return button;
    };
    const up = makeButton('up'), down = makeButton('down');
    root.append(up, down);
    controls = { root, up, down, update: () => {
      const maxScroll = Math.max(0, pane.scrollHeight - pane.clientHeight);
      root.classList.toggle('hidden', maxScroll <= 2);
      up.classList.toggle('hidden', maxScroll <= 2 || pane.scrollTop <= 2);
      down.classList.toggle('hidden', maxScroll <= 2 || pane.scrollTop >= maxScroll - 2);
    }};
    verticalScrollControls.set(pane, controls);
    pane.addEventListener('scroll', controls.update, { passive: true });
  }
  if (controls.root.parentNode !== wrapper) wrapper.appendChild(controls.root);
  controls.update();
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function enhanceWebosSelects(root: ParentNode): void {
  if (!document.body.classList.contains('webos-client')) return;
  root.querySelectorAll<HTMLSelectElement>('select.central-category-select:not([data-webos-select])').forEach((select) => {
    const parent = select.parentNode;
    if (!parent) return;
    select.dataset.webosSelect = 'true';
    const wrapper = node('div', 'webos-select');
    const trigger = node('button', 'webos-select-trigger') as HTMLButtonElement;
    trigger.type = 'button'; trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const menu = node('div', 'webos-select-menu'); menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', select.getAttribute('aria-label') || 'Options');
    const options = (): HTMLButtonElement[] => Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const selectedIndex = (): number => Math.max(0, options().findIndex((option) => option.dataset.value === select.value));
    const isOpen = (): boolean => menu.classList.contains('is-open');
    const positionMenu = (): void => {
      if (!isOpen()) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(120, Math.min(rect.width, window.innerWidth - 16));
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      const menuHeight = menu.getBoundingClientRect().height;
      const below = rect.bottom + 7;
      menu.style.top = `${below + menuHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - menuHeight - 7)}px`;
    };
    let close = (_returnFocus = false): void => undefined;
    const outsideClick = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && !wrapper.contains(target) && !menu.contains(target)) close();
    };
    const closeOnBlur = (): void => { window.setTimeout(() => {
      if (!wrapper.contains(document.activeElement) && !menu.contains(document.activeElement)) close();
    }, 0); };
    close = (returnFocus = false): void => {
      menu.classList.remove('is-open'); wrapper.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', outsideClick);
      document.removeEventListener('scroll', positionMenu, true);
      window.removeEventListener('resize', positionMenu);
      if (returnFocus) trigger.focus();
      menu.remove();
    };
    const choose = (option: HTMLButtonElement): void => {
      select.value = option.dataset.value ?? '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      trigger.textContent = option.textContent ?? '';
      options().forEach((candidate) => candidate.setAttribute('aria-selected', `${candidate === option}`));
      close(true);
    };
    const rebuild = (): void => {
      clear(menu);
      Array.from(select.options).forEach((nativeOption) => {
        const option = node('button', 'webos-select-option', nativeOption.textContent ?? '') as HTMLButtonElement;
        option.type = 'button'; option.tabIndex = -1; option.setAttribute('role', 'option');
        option.dataset.value = nativeOption.value;
        option.disabled = nativeOption.disabled;
        option.onclick = () => choose(option);
        menu.appendChild(option);
      });
      const active = options()[selectedIndex()];
      trigger.textContent = active?.textContent ?? '';
      options().forEach((candidate) => candidate.setAttribute('aria-selected', `${candidate === active}`));
    };
    const open = (index = selectedIndex()): void => {
      rebuild(); document.body.appendChild(menu);
      wrapper.classList.add('is-open'); menu.classList.add('is-open'); trigger.setAttribute('aria-expanded', 'true');
      positionMenu();
      document.addEventListener('click', outsideClick);
      document.addEventListener('scroll', positionMenu, true);
      window.addEventListener('resize', positionMenu);
      const option = options()[Math.max(0, Math.min(options().length - 1, index))];
      option?.focus(); option?.scrollIntoView({ block: 'nearest' });
    };
    trigger.onclick = () => isOpen() ? close(true) : open();
    wrapper.addEventListener('keydown', (event) => {
      const key = event.keyCode;
      if (event.target === trigger && (key === 13 || key === 23 || key === 32)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (isOpen()) close(true); else open();
      }
    });
    menu.addEventListener('keydown', (event) => {
      const key = event.keyCode;
      const activeOptions = options();
      const activeIndex = activeOptions.indexOf(document.activeElement as HTMLButtonElement);
      const isBack = [461, 10009, 8, 27].includes(key) || ['Escape', 'BrowserBack'].includes(event.key);
      if (isOpen()) {
        if (isBack) { event.preventDefault(); event.stopImmediatePropagation(); close(true); return; }
        if (key === 38 || key === 40) {
          event.preventDefault(); event.stopImmediatePropagation();
          const nextIndex = activeIndex < 0 ? selectedIndex() : Math.max(0, Math.min(activeOptions.length - 1, activeIndex + (key === 40 ? 1 : -1)));
          activeOptions[nextIndex]?.focus(); activeOptions[nextIndex]?.scrollIntoView({ block: 'nearest' }); return;
        }
        if (key === 13 || key === 23 || key === 32) {
          event.preventDefault(); event.stopImmediatePropagation();
          if (activeIndex >= 0) choose(activeOptions[activeIndex]); else close(true);
          return;
        }
      }
    });
    wrapper.addEventListener('focusout', closeOnBlur);
    menu.addEventListener('focusout', closeOnBlur);
    parent.insertBefore(wrapper, select); wrapper.appendChild(trigger); wrapper.appendChild(select);
    select.classList.add('webos-native-select');
    select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    select.addEventListener('change', rebuild);
    rebuild();
  });
}
if (document.body.classList.contains('webos-client')) {
  const webosSelectObserver = new MutationObserver(() => enhanceWebosSelects(document.body));
  webosSelectObserver.observe(document.body, { childList: true, subtree: true });
  enhanceWebosSelects(document.body);
}
function updatePageScrollControls(): void {
  const visible = !app.classList.contains('hidden') && player.classList.contains('hidden') && view !== 'profiles' && view !== 'settings';
  const searchResults = view === 'search' ? content.querySelector<HTMLElement>('.central-search-results') : null;
  if (searchResults) {
    const maxScroll = Math.max(0, searchResults.scrollHeight - searchResults.clientHeight);
    const rect = searchResults.getBoundingClientRect();
    const canScroll = maxScroll >= 24;
    pageScrollControls.classList.toggle('hidden', !visible || !canScroll);
    pageUpButton.classList.toggle('hidden', searchResults.scrollTop < 24);
    pageDownButton.classList.toggle('hidden', searchResults.scrollTop >= maxScroll - 24);
    pageUpButton.style.top = `${Math.max(74, rect.top + 8)}px`;
    pageUpButton.style.bottom = 'auto';
    pageDownButton.style.top = 'auto';
    pageDownButton.style.bottom = `${Math.max(12, window.innerHeight - rect.bottom + 8)}px`;
    return;
  }
  const liveGrid = view === 'live' ? content.querySelector<HTMLElement>('.central-live-grid') : null;
  if (liveGrid) {
    pageUpButton.style.removeProperty('top'); pageUpButton.style.removeProperty('bottom');
    const maxScroll = Math.max(0, liveGrid.scrollHeight - liveGrid.clientHeight);
    pageScrollControls.classList.toggle('hidden', !visible || maxScroll < 24);
    pageUpButton.classList.toggle('hidden', liveGrid.scrollTop < 24);
    pageDownButton.classList.toggle('hidden', liveGrid.scrollTop >= maxScroll - 24);
    return;
  }
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  const maxScroll = Math.max(0, Math.max(scrollingElement.scrollHeight, document.body.scrollHeight, content.scrollHeight) - window.innerHeight);
  const currentScroll = Math.max(window.scrollY, scrollingElement.scrollTop, document.body.scrollTop);
  pageScrollControls.classList.toggle('hidden', !visible || maxScroll < 24);
  pageUpButton.classList.toggle('hidden', currentScroll < 24);
  pageDownButton.classList.toggle('hidden', currentScroll >= maxScroll - 24);
  if (view === 'home' || view === 'whats-new' || view === 'movies' || view === 'series') {
    const headerBottom = document.getElementById('central-header')?.getBoundingClientRect().bottom ?? 88;
    const firstVisibleRow = Array.from(content.querySelectorAll<HTMLElement>('.central-row'))
      .find((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > headerBottom && rect.top < window.innerHeight; });
    const rowTop = firstVisibleRow?.getBoundingClientRect().top ?? headerBottom + 8;
    pageUpButton.style.top = `${Math.max(headerBottom + 8, Math.min(window.innerHeight - 50, rowTop))}px`;
    pageUpButton.style.bottom = 'auto';
  }
}
function scrollWindowTo(top: number): void { window.scrollTo(window.scrollX, top); }
let headerFadeFrame = 0;
function updateHeaderTextFade(): void {
  headerFadeFrame = 0;
  const headerHeight = (document.getElementById('central-header')?.getBoundingClientRect().height ?? 88) + 52;
  const textElements = content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,small,strong,.central-card-title,.central-card-meta,.central-page-kicker,.central-page-title,.central-page-description,.central-detail-meta,.central-episode-title,.central-episode-description');
  textElements.forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.top >= headerHeight || rect.bottom <= 0) {
      element.style.removeProperty('mask-image'); element.style.removeProperty('-webkit-mask-image');
      return;
    }
    const startOpacity = Math.max(0, Math.min(1, rect.top / headerHeight));
    const endPosition = Math.max(0, Math.min(rect.height, headerHeight - rect.top));
    const mask = `linear-gradient(to bottom, rgba(0,0,0,${startOpacity}) 0px, #000 ${endPosition}px, #000 100%)`;
    element.style.setProperty('mask-image', mask); element.style.setProperty('-webkit-mask-image', mask);
  });
}
function scheduleHeaderTextFade(): void {
  if (!headerFadeFrame) headerFadeFrame = window.requestAnimationFrame(updateHeaderTextFade);
}
function movePage(direction: -1 | 1): void {
  const searchResults = view === 'search' ? content.querySelector<HTMLElement>('.central-search-results') : null;
  if (searchResults) {
    searchResults.scrollBy({ top: direction * Math.max(220, searchResults.clientHeight * .8), behavior: 'smooth' });
    return;
  }
  const liveGrid = view === 'live' ? content.querySelector<HTMLElement>('.central-live-grid') : null;
  if (liveGrid) {
    liveGrid.scrollBy({ top: direction * Math.max(220, liveGrid.clientHeight * .8), behavior: 'smooth' });
    return;
  }
    scrollWindowTo(Math.max(0, Math.min(document.documentElement.scrollHeight - window.innerHeight,
      window.scrollY + direction * Math.max(320, window.innerHeight * 0.78))));
}
pageUpButton.onclick = () => movePage(-1);
pageDownButton.onclick = () => movePage(1);
window.addEventListener('scroll', () => { updatePageScrollControls(); scheduleHeaderTextFade(); activeCategoryPageScrollHandler?.(); }, { passive: true });
window.addEventListener('resize', () => { updatePageScrollControls(); scheduleHeaderTextFade(); });
new MutationObserver(() => { updatePageScrollControls(); scheduleHeaderTextFade(); }).observe(content, { childList: true, subtree: true });
let shelfSequence = 0;
const shelfPageLoaders = new WeakMap<HTMLElement, () => Promise<void>>();
function addShelfControls(section: HTMLElement, list: HTMLElement): void {
  const shelf = node('div', 'central-shelf');
  const listId = `central-shelf-${++shelfSequence}`; list.id = listId;
  const arrow = (direction: 'left' | 'right'): HTMLButtonElement => {
    const button = node('button', `central-shelf-arrow ${direction}`) as HTMLButtonElement;
    button.type = 'button'; button.setAttribute('aria-label', `${direction === 'left' ? 'Scroll shelf left' : 'Scroll shelf right'}`);
    button.setAttribute('aria-controls', listId);
    button.innerHTML = direction === 'left'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
    button.onclick = () => list.scrollBy({ left: (direction === 'left' ? -1 : 1) * Math.max(300, list.clientWidth * .78), behavior: 'smooth' });
    return button;
  };
  const left = arrow('left'), right = arrow('right');
  const update = (): void => {
    const active = section.classList.contains('is-active');
    left.classList.toggle('hidden', !active || list.scrollWidth <= list.clientWidth + 2 || list.scrollLeft <= 1);
    right.classList.toggle('hidden', !active || list.scrollWidth <= list.clientWidth + 2 || list.scrollLeft + list.clientWidth >= list.scrollWidth - 2);
  };
  const activate = (): void => { section.classList.add('is-active'); update(); };
  const deactivateIfUnfocused = (): void => { window.setTimeout(() => { if (!section.contains(document.activeElement)) { section.classList.remove('is-active'); update(); } }, 0); };
  shelf.addEventListener('focusin', activate);
  shelf.addEventListener('focusout', deactivateIfUnfocused);
  shelf.addEventListener('mouseenter', activate);
  shelf.addEventListener('mouseleave', () => { if (!section.contains(document.activeElement)) { section.classList.remove('is-active'); update(); } });
  list.addEventListener('scroll', update, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(list);
  window.setTimeout(update, 0);
  shelf.append(left, list, right); section.appendChild(shelf);
}
function setStatus(message: string): void { status.textContent = message; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Request failed.'; }
function invalidateCatalogCache(): void {
  catalogApiRevision += 1;
  catalogApiCache.clear();
  catalogApiInflight.clear();
  cachedViews.clear();
}
function invalidateHomeCache(): void {
  catalogApiRevision += 1;
  for (const key of catalogApiCache.keys()) if (key.includes('|/home')) catalogApiCache.delete(key);
  for (const key of catalogApiInflight.keys()) if (key.includes('|/home')) catalogApiInflight.delete(key);
  cachedViews.delete('home');
}
function resetInlineLiveVideo(): void {
  livePreviewGeneration += 1;
  livePreviewSourceUrl = '';
  livePreviewSourceFormat = 'm3u8';
  if (video.parentElement?.classList.contains('central-live-preview')) {
    video.pause(); video.removeAttribute('src'); video.load(); video.classList.remove('central-inline-video', 'central-inline-playing');
    player.insertBefore(video, player.firstChild);
  }
  livePreviewLoader = null;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  if (!config) throw new Error('Connect to the catalog server first.');
  const cacheable = body === undefined && (/^\/home(?:\?|$)/.test(path) || /^\/(?:movies|series)(?:\/categories)?(?:\?|$)/.test(path));
  const cacheKey = `${config.url}|${config.token}|${path}`;
  if (cacheable) {
    const cached = catalogApiCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    if (cached) catalogApiCache.delete(cacheKey);
    const pending = catalogApiInflight.get(cacheKey);
    if (pending) return pending as Promise<T>;
  }
  const revision = catalogApiRevision;
  const url = `${config.url}/api/v1${path}`;
  // Catalog reads finish and populate the cache even if the user changes tabs while they run.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller && !cacheable) activeControllers.add(controller);
  const timeout = window.setTimeout(() => controller?.abort(), 15_000);
  const request = (async (): Promise<T> => {
    try {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'X-Device-Id': deviceId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller?.signal, cache: 'no-store' });
    if (response.status === 401) throw new Error('Your NightOwl sign-in session expired. Sign in again.');
    if (!response.ok) {
      let message = `Server returned HTTP ${response.status}.`;
      try {
        const payload = await response.json() as { error?: { message?: string; details?: Array<{ path?: string; message?: string }> } };
        if (payload.error?.message) message = payload.error.details?.length
          ? `${payload.error.message} ${payload.error.details.map((detail) => `${detail.path}: ${detail.message}`).join('; ')}`
          : payload.error.message;
      } catch { /* Keep the generic HTTP message when the response isn't JSON. */ }
      throw new Error(message);
    }
    const value = await response.json() as T;
    if (cacheable && revision === catalogApiRevision) {
      catalogApiCache.set(cacheKey, { value, expiresAt: Date.now() + apiCacheLifetime });
      while (catalogApiCache.size > 250) catalogApiCache.delete(catalogApiCache.keys().next().value as string);
    }
    return value;
    } finally { window.clearTimeout(timeout); if (controller) activeControllers.delete(controller); }
  })();
  if (cacheable) {
    catalogApiInflight.set(cacheKey, request);
    const clearInflight = (): void => { if (catalogApiInflight.get(cacheKey) === request) catalogApiInflight.delete(cacheKey); };
    void request.then(clearInflight, clearInflight);
  }
  return request;
}
async function loginWithAccount(username: string, password: string): Promise<Config> {
  const url = import.meta.env.VITE_NIGHTOWL_SERVER_URL || location.origin;
  const response = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify({ username, password }),
    cache: 'no-store'
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    const code = payload?.error?.code;
    if (response.status === 401) throw new Error('Username or password is incorrect.');
    if (response.status === 429) throw new Error('Too many sign-in attempts. Try again later.');
    if (response.status === 409) throw new Error('No NightOwl account has been created yet. Ask the administrator to create one with PowerShell.');
    throw new Error(code ? `Sign-in failed (${code}).` : `Server returned HTTP ${response.status}.`);
  }
  const result = await response.json() as { accessToken: string };
  if (!result.accessToken) throw new Error('The server did not return a sign-in session.');
  return { url, token: result.accessToken };
}
function fitWebosLivePreview(): void {
  if (!document.body.classList.contains('webos-client')) return;
  const showcase = content.querySelector<HTMLElement>('.central-live-showcase');
  const preview = showcase?.querySelector<HTMLElement>('.central-live-preview');
  if (!showcase || !preview) return;
  const availableWidth = showcase.clientWidth;
  const availableHeight = showcase.clientHeight;
  if (availableWidth <= 0 || availableHeight <= 0) return;
  const width = Math.floor(Math.min(availableWidth, availableHeight * 16 / 9));
  preview.style.width = `${width}px`;
  preview.style.height = `${Math.floor(width * 9 / 16)}px`;
}
window.addEventListener('resize', () => window.requestAnimationFrame(fitWebosLivePreview));
function cancelRequest(): void { for (const controller of activeControllers) controller.abort(); activeControllers.clear(); requestGeneration += 1; }
function navigate(next: View): void {
  if (activeCategoryJumpMenu?.panel.classList.contains('open')) activeCategoryJumpMenu.close(false);
  activeCategoryJumpMenu = null;
  if (next !== 'home') resetWebosHomeBackSequence();
  if (view === 'live' && next !== 'live') resetInlineLiveVideo();
  if (cacheableViews.has(view) && activeCategoryPageScrollHandler) categoryViewScrollHandlers.set(view, activeCategoryPageScrollHandler);
  activeCategoryPageScrollHandler = null;
  cancelRequest();
  if (view !== next && cacheableViews.has(view) && content.childElementCount && !status.textContent) {
    const fragment = document.createDocumentFragment();
    while (content.firstChild) fragment.appendChild(content.firstChild);
    cachedViews.delete(view);
    cachedViews.set(view, { content: fragment, scrollY: window.scrollY, expiresAt: Date.now() + viewCacheLifetime });
    while (cachedViews.size > cacheableViews.size) cachedViews.delete(cachedViews.keys().next().value as View);
  }
  app.classList.remove('detail-open');
  app.classList.toggle('profile-picker-open', next === 'profiles');
  app.classList.toggle('live-tv-open', next === 'live');
  document.documentElement.classList.toggle('live-tv-open', next === 'live');
  document.body.classList.toggle('live-tv-open', next === 'live');
  app.classList.toggle('settings-open', next === 'settings');
  app.classList.toggle('search-open', next === 'search');
  document.documentElement.classList.toggle('settings-open', next === 'settings');
  document.body.classList.toggle('settings-open', next === 'settings');
  document.documentElement.classList.toggle('search-open', next === 'search');
  document.body.classList.toggle('search-open', next === 'search');
  if (next === 'settings' || next === 'search') scrollWindowTo(0);
  if (next === 'profiles') scrollWindowTo(0);
  if (next !== 'detail' && next !== 'profiles') previousView = next;
  view = next;
  clear(content);
  document.querySelectorAll<HTMLButtonElement>('#central-app [data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === next);
  });
  setStatus('');
  const cached = cacheableViews.has(next) ? cachedViews.get(next) : undefined;
  const restored = Boolean(cached && cached.expiresAt > Date.now());
  if (restored && cached) {
    cachedViews.delete(next);
    content.appendChild(cached.content);
    const restoredMenu = content.querySelector<HTMLElement>('.central-category-jump-menu') as (HTMLElement & { categoryJumpState?: CategoryJumpMenuState }) | null;
    activeCategoryJumpMenu = restoredMenu?.categoryJumpState ?? null;
    activeCategoryPageScrollHandler = categoryViewScrollHandlers.get(next) ?? null;
    scrollWindowTo(cached.scrollY);
    window.requestAnimationFrame(() => activeCategoryPageScrollHandler?.());
  } else {
    cachedViews.delete(next);
    if (next === 'home') void showHome();
    else if (next === 'whats-new') void showWhatsNew();
    else if (next === 'movies' || next === 'series' || next === 'live') void showList(next);
  }
  if (restored) return;
  if (next === 'my-list') void showMyList();
  else if (next === 'search') showSearch();
  else if (next === 'settings') void showSettings();
  else if (next === 'profiles') showProfiles();
  else if (next === 'database') void showDatabase();
}
function imageUrls(value?: string): string[] {
  if (!value) return [];
  let candidates: unknown[] = [value.trim()];
  const first = candidates[0];
  if (typeof first === 'string' && /^[\[\"]/.test(first)) {
    try { const parsed: unknown = JSON.parse(first); candidates = Array.isArray(parsed) ? parsed : [parsed]; } catch { /* Keep plain URLs unchanged. */ }
  }
  return candidates.reduce<string[]>((urls, candidate) => {
    if (typeof candidate !== 'string') return urls;
    const text = candidate.trim().replace(/^['"]|['"]$/g, '');
    try { const url = new URL(text); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) urls.push(url.href); }
    catch { /* Ignore malformed image URLs. */ }
    return urls;
  }, []);
}
function shortGenres(value?: string): string {
  if (!value) return '';
  return [...new Set(value.split(/\s*(?:,|\/|\|)\s*/).map((part) => part.trim()).filter(Boolean))].slice(0, 3).join(' · ');
}
function normalizeDisplayTitle(value: string): string {
  return value.replace(/^\s*(?:NL|EN|PL|FR|DE|ES|IT|PT|US|UK|NF)(?:\s+(?:4K|UHD|1080P|720P))?\s*[-:|]\s*/i, '')
    .replace(/\s*\((?:19|20)\d{2}\)?(?:\s*\((?:MULTI\s*SUB|[A-Z]{2,3}|4K|UHD|\d{3,4}P)\))*\s*$/i, '').trim();
}
function card(item: Item): HTMLButtonElement {
  const button = node('button', 'central-card') as HTMLButtonElement;
  button.type = 'button';
  button.dataset.cardKey = `${item.kind}:${item.id}`;
  const isNewEpisode = item.kind === 'episode' && Boolean(item.seriesId && item.seriesTitle);
  button.setAttribute('aria-label', isNewEpisode ? `Open ${item.seriesTitle} to play ${item.title}` : `Open ${item.title}`);
  const posters = imageUrls(item.posterUrl), backdrops = imageUrls(item.backdropUrl);
  const sources = item.kind === 'live'
    ? [...posters.map((url) => ({ url, className: 'channel-logo' })), ...backdrops.map((url) => ({ url, className: 'channel-logo' }))]
    : [...backdrops.map((url) => ({ url, className: 'backdrop-art' })), ...posters.map((url) => ({ url, className: 'poster-art' }))];
  if (sources.length) {
    const image = node('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
    let sourceIndex = 0;
    const useSource = (): void => {
      const source = sources[sourceIndex];
      if (!source) { image.replaceWith(node('div', 'central-placeholder')); return; }
      image.className = source.className; image.src = source.url;
    };
    image.onerror = () => { sourceIndex += 1; useSource(); };
    useSource(); button.appendChild(image);
  } else button.appendChild(node('div', 'central-placeholder'));
  const label = node('span', `central-card-title${isNewEpisode ? ' central-card-episode-series' : ''}`,
    isNewEpisode ? normalizeDisplayTitle(item.seriesTitle!) : item.title);
  button.appendChild(label);
  if (isNewEpisode) {
    const seasonEpisode = `S${item.seasonNumber ?? 0} E${item.episodeNumber ?? 0}`;
    button.appendChild(node('small', 'central-card-episode-subtitle', `${seasonEpisode} · ${item.title}`));
  }
  if (!isNewEpisode) {
    const sub = node('small', 'central-card-meta', [item.releaseYear, shortGenres(item.genre)].filter(Boolean).join(' · '));
    button.appendChild(sub);
  }
  if (item.positionSeconds) {
    const progress = node('i', 'central-card-progress');
    progress.style.width = `${Math.max(3, Math.min(96, Math.round(100 * item.positionSeconds / (item.durationSeconds || 3600))))}%`;
    button.appendChild(progress);
  }
  button.onclick = () => void openItem(item);
  if (document.body.classList.contains('webos-client')) button.addEventListener('mouseenter', () => button.focus());
  return button;
}
function focusReturnedCard(root: HTMLElement): void {
  const preferred = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-card-key]')).find((button) => button.dataset.cardKey === restoreCardKey);
  (preferred ?? root.querySelector<HTMLButtonElement>('button'))?.focus();
  restoreCardKey = '';
}
function focusWithoutMovingScroll(target: HTMLElement): void {
  const windowLeft = window.scrollX, windowTop = window.scrollY;
  const ancestors: Array<{ element: HTMLElement; left: number; top: number }> = [];
  let ancestor = target.parentElement;
  while (ancestor) {
    if (ancestor.scrollWidth > ancestor.clientWidth || ancestor.scrollHeight > ancestor.clientHeight) {
      ancestors.push({ element: ancestor, left: ancestor.scrollLeft, top: ancestor.scrollTop });
    }
    ancestor = ancestor.parentElement;
  }
  try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  const root = document.documentElement;
  const oldBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  ancestors.forEach(({ element, left, top }) => { element.scrollLeft = left; element.scrollTop = top; });
  if (window.scrollX !== windowLeft || window.scrollY !== windowTop) window.scrollTo(windowLeft, windowTop);
  root.style.scrollBehavior = oldBehavior;
}
function focusShelfCard(target: HTMLButtonElement, shelf: HTMLElement, alignAtTop = false): void {
  if (!shelf.isConnected) return;
  focusWithoutMovingScroll(target);
  // Start the viewport move in the same event frame as focus changes, so the
  // highlighted card travels with its row instead of appearing detached first.
  const rows = Array.from(content.querySelectorAll<HTMLElement>('.central-row'));
  const isLastLoadedShelf = rows[rows.length - 1] === shelf && !content.querySelector('[data-more-categories="true"]');
  if (alignAtTop) {
    const safeTop = (document.getElementById('central-header')?.getBoundingClientRect().bottom ?? 88) + 18;
    if (isLastLoadedShelf && shelf.parentElement) {
      const requiredBottomSpace = Math.max(0, window.innerHeight - safeTop - shelf.getBoundingClientRect().height + 24);
      const currentBottomSpace = Number.parseFloat((shelf.parentElement as HTMLElement).style.paddingBottom) || 0;
      if (requiredBottomSpace > currentBottomSpace) (shelf.parentElement as HTMLElement).style.paddingBottom = `${requiredBottomSpace}px`;
    }
    const rect = shelf.getBoundingClientRect();
    scrollWindowTo(Math.max(0, window.scrollY + rect.top - safeTop));
    return;
  }
  if (isLastLoadedShelf) {
    const scrolling = document.scrollingElement ?? document.documentElement;
    const pageHeight = Math.max(scrolling.scrollHeight, document.body.scrollHeight, content.scrollHeight);
    scrollWindowTo(Math.max(0, pageHeight - window.innerHeight));
  } else {
    const menuBottom = document.getElementById('central-header')?.getBoundingClientRect().bottom ?? 88;
    if (document.body.classList.contains('webos-client')) {
      const safeTop = menuBottom + 18;
      const rect = shelf.getBoundingClientRect();
      if (Math.abs(rect.top - safeTop) > 2) scrollWindowTo(Math.max(0, window.scrollY + rect.top - safeTop));
    } else {
      const safeTop = menuBottom + 20;
      const safeBottom = window.innerHeight - 40;
      const rect = shelf.getBoundingClientRect();
      const delta = rect.top < safeTop ? rect.top - safeTop : rect.bottom > safeBottom ? rect.bottom - safeBottom : 0;
      if (delta) scrollWindowTo(window.scrollY + delta);
    }
  }
}
function focusShelfItem(list: HTMLElement, target: HTMLButtonElement): void {
  focusWithoutMovingScroll(target);
  const listRect = list.getBoundingClientRect();
  const cardRect = target.getBoundingClientRect();
  const webos = document.body.classList.contains('webos-client');
  const visibleLeft = listRect.left + (webos ? 48 : 12);
  const visibleRight = listRect.right - (webos ? 56 : 12);
  if (cardRect.right > visibleRight) list.scrollLeft += cardRect.right - visibleRight + 8;
  else if (cardRect.left < visibleLeft) list.scrollLeft -= visibleLeft - cardRect.left + 8;
}
type CategoryJumpMenuState = { section: 'movies' | 'series' | 'live'; toggle: HTMLButtonElement; panel: HTMLElement; list: HTMLElement; categories: BrowseCategory[]; open: () => void; close: (returnFocus?: boolean) => void };
let activeCategoryJumpMenu: CategoryJumpMenuState | null = null;
function addCategoryJumpMenu(section: 'movies' | 'series' | 'live', categories: BrowseCategory[], selectCategory: (category: BrowseCategory) => void | Promise<void>): void {
  if (!categories.length) return;
  const toggle = node('button', 'central-category-jump-toggle', 'Categories') as HTMLButtonElement;
  toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', 'Open category menu');
  const panel = node('aside', 'central-category-jump-menu'); panel.setAttribute('aria-label', `${section === 'series' ? 'Show' : section === 'live' ? 'Live TV' : 'Movie'} categories`);
  const heading = node('div', 'central-category-jump-heading'); heading.appendChild(node('strong', '', 'Categories'));
  const close = node('button', 'central-category-jump-close', '×') as HTMLButtonElement; close.type = 'button'; close.setAttribute('aria-label', 'Close categories'); heading.appendChild(close);
  const list = node('div', 'central-category-jump-list');
  panel.append(heading, list);
  const state = { section, toggle, panel, list, categories, open: (): void => undefined, close: (): void => undefined } as CategoryJumpMenuState;
  const closeMenu = (returnFocus = true): void => {
    panel.classList.remove('open'); toggle.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle.focus();
  };
  const openMenu = (): void => {
    panel.classList.add('open'); toggle.classList.add('is-open'); toggle.setAttribute('aria-expanded', 'true');
    const preferred = list.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? list.querySelector<HTMLButtonElement>('button');
    preferred?.focus();
  };
  state.open = openMenu; state.close = closeMenu; activeCategoryJumpMenu = state;
  const renderItems = (): void => {
    clear(list);
    categories.forEach((category) => {
      const option = node('button', 'central-category-jump-option', category.name) as HTMLButtonElement;
      option.type = 'button'; option.dataset.categoryId = category.id;
      option.setAttribute('aria-current', category.id === selectedCategoryBySection[section] ? 'true' : 'false');
      option.onclick = () => {
        selectedCategoryBySection[section] = category.id;
        list.querySelectorAll<HTMLButtonElement>('.central-category-jump-option').forEach((entry) => entry.setAttribute('aria-current', entry.dataset.categoryId === category.id ? 'true' : 'false'));
        closeMenu(false); void selectCategory(category);
      };
      list.appendChild(option);
    });
  };
  renderItems(); toggle.onclick = () => panel.classList.contains('open') ? closeMenu() : openMenu(); close.onclick = () => closeMenu();
  panel.addEventListener('keydown', (event) => {
    const active = document.activeElement as HTMLElement | null;
    const options = Array.from(list.querySelectorAll<HTMLButtonElement>('button'));
    const index = options.indexOf(active as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Backspace' || event.keyCode === 461 || event.keyCode === 10009) {
      event.preventDefault(); event.stopPropagation(); closeMenu(); return;
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = options[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (event.key === 'ArrowRight') {
      if (active instanceof HTMLButtonElement && active.dataset.categoryId) { event.preventDefault(); event.stopPropagation(); active.click(); }
    }
  });
  (panel as HTMLElement & { categoryJumpState?: CategoryJumpMenuState }).categoryJumpState = state;
  content.append(toggle, panel);
}
function row(title: string, items: Item[], maxItems = 20): HTMLElement {
  const section = node('section', 'central-row');
  section.appendChild(node('h2', undefined, title));
  const list = node('div', 'central-cards');
  items.slice(0, maxItems).forEach((item) => list.appendChild(card(item)));
  addShelfControls(section, list);
  return section;
}
function featuredHero(item: Item, source: 'tmdb' | 'catalog' | undefined): HTMLElement {
  const hero = node('section', 'central-hero');
  const heroImages = [...imageUrls(item.backdropUrl), ...imageUrls(item.posterUrl)];
  if (heroImages.length) {
    const image = node('img'); image.alt = ''; image.loading = 'eager'; image.decoding = 'async';
    let sourceIndex = 0;
    image.onerror = () => { sourceIndex += 1; if (heroImages[sourceIndex]) image.src = heroImages[sourceIndex]; else image.remove(); };
    image.src = heroImages[sourceIndex]; hero.appendChild(image);
  }
  const copy = node('div', 'central-hero-copy');
  copy.appendChild(node('div', 'central-hero-eyebrow', source === 'tmdb' ? 'TRENDING ON TMDB' : 'FEATURED FOR YOU'));
  copy.appendChild(node('h1', undefined, item.title));
  copy.appendChild(node('div', 'central-hero-meta', [item.releaseYear, item.genre, item.kind === 'series' ? 'Series' : 'Film'].filter(Boolean).join('  ·  ')));
  copy.appendChild(node('p', undefined, item.description || 'Ready to watch from your catalog.'));
  const actions = node('div', 'central-hero-actions');
  const primary = node('button', 'primary', item.kind === 'series' ? '▶  View Series' : '▶  Play') as HTMLButtonElement;
  primary.onclick = () => item.kind === 'series' ? void openItem(item) : void play(item);
  const info = node('button', 'secondary', 'ⓘ  More Info') as HTMLButtonElement;
  info.onclick = () => void openItem(item);
  actions.append(primary, info); copy.appendChild(actions); hero.appendChild(copy);
  return hero;
}
function playlistRow(title: string, firstPage: CatalogPage, loadPage?: (page: number) => Promise<CatalogPage>): HTMLElement {
  const section = node('section', 'central-row');
  section.appendChild(node('h2', undefined, title));
  const list = node('div', 'central-cards');
  firstPage.items.slice(0, 20).forEach((item) => list.appendChild(card(item)));
  addShelfControls(section, list);
  let page = 1, hasMore = firstPage.hasMore, pageHasMore = firstPage.hasMore;
  let pendingItems: Item[] = [], loadingPage: Promise<void> | null = null;
  const appendNextPage = (): Promise<void> => {
    if (!loadPage || !hasMore) return Promise.resolve();
    if (loadingPage) return loadingPage;
    loadingPage = (async () => {
      try {
        if (!pendingItems.length) {
          if (!pageHasMore) { hasMore = false; return; }
          const next = await loadPage(page + 1);
          if (!next.items.length) { pageHasMore = false; hasMore = false; return; }
          page += 1; pageHasMore = next.hasMore; pendingItems = next.items.slice();
        }
        const nextItems = pendingItems.splice(0, 5);
        nextItems.map((item) => card(item)).forEach((itemCard) => list.appendChild(itemCard));
        hasMore = pendingItems.length > 0 || pageHasMore;
      } catch { /* Keep the current shelf responsive and retry when it is scrolled again. */ }
      finally { loadingPage = null; }
    })();
    return loadingPage;
  };
  shelfPageLoaders.set(list, appendNextPage);
  list.addEventListener('focusin', (event) => {
    const focused = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.central-card[data-card-key]');
    if (!focused || !hasMore) return;
    const cards = list.querySelectorAll('.central-card[data-card-key]');
    const index = Array.prototype.indexOf.call(cards, focused) as number;
    if (cards.length - index <= 4) void appendNextPage();
  });
  list.addEventListener('scroll', () => {
    if (!loadPage || !hasMore || loadingPage || list.scrollWidth <= list.clientWidth) return;
    if (list.scrollLeft + list.clientWidth < list.scrollWidth - Math.max(320, list.clientWidth * .35)) return;
    void appendNextPage();
  }, { passive: true });
  return section;
}

async function showMediaShelves(section: 'movies' | 'series'): Promise<void> {
  const generation = requestGeneration;
  const kind = section === 'movies' ? 'movie' : 'series';
  setStatus(`Loading ${section}…`);
  try {
    const [home, categoryResponse] = await Promise.all([
      api<Home>(`/home?language=${encodeURIComponent(appLanguage)}${profile ? `&profileId=${encodeURIComponent(profile.id)}` : ''}`),
      api<{ items: BrowseCategory[] }>(`/${section}/categories?language=${encodeURIComponent(appLanguage)}`)
    ]);
    if (generation !== requestGeneration) return;
    const rowIds = section === 'movies'
      ? new Set(['top-picks', 'top-250', 'new-releases', 'in-cinemas', 'trending-movies', 'new-movies'])
      : new Set(['top-picks', 'trending-series', 'popular-series', 'top-series', 'on-air', 'new-series']);
    const curatedRows = home.rows.filter((group) => rowIds.has(group.id))
      .map((group) => ({ ...group, items: group.items.filter((item) => item.kind === kind) }))
      .filter((group) => group.items.length).slice(0, 5);
    const typeOrder: Record<string, number> = { genre: 0, platform: 1, collection: 2, quality: 3, other: 4 };
    const hidden = section === 'movies' ? hiddenMovieCategoryIds : hiddenSeriesCategoryIds;
    const categories = categoryResponse.items.filter((group) => group.id && group.name && (group.itemCount ?? 1) > 0 && !hidden.has(group.id))
      .sort((a, b) => (typeOrder[a.type ?? 'other'] ?? 5) - (typeOrder[b.type ?? 'other'] ?? 5)
        || (b.itemCount ?? 0) - (a.itemCount ?? 0) || a.name.localeCompare(b.name));
    const feature = home.featured?.kind === kind ? home.featured
      : curatedRows.map((group) => group.items[0]).find((item): item is Item => Boolean(item))
        ?? null;
    clear(content);
    if (feature) content.appendChild(featuredHero(feature, home.discoverySource));
    curatedRows.forEach((group) => content.appendChild(row(group.title, group.items)));
    const categoryShelfContainer = node('div', 'central-category-shelves'); content.appendChild(categoryShelfContainer);
    type CategoryRowRecord = { group: BrowseCategory; row: HTMLElement | null; spacer: HTMLElement | null; loading: boolean };
    const categoryRows: CategoryRowRecord[] = [];
    const makeCategoryPlaylist = (group: BrowseCategory, firstPage: CatalogPage): HTMLElement => playlistRow(group.name, firstPage, (nextPage) =>
      api<CatalogPage>(`/${section}?page=${nextPage}&limit=20&language=${encodeURIComponent(appLanguage)}&category=${encodeURIComponent(group.id)}`));
    const attachCategoryRow = (record: CategoryRowRecord, playlist: HTMLElement, before: HTMLElement | null): void => {
      playlist.dataset.categoryIndex = `${categoryRows.indexOf(record)}`;
      playlist.dataset.categoryId = record.group.id;
      const spacer = record.spacer;
      record.row = playlist; record.spacer = null;
      if (spacer?.parentElement === categoryShelfContainer) categoryShelfContainer.replaceChild(playlist, spacer);
      else if (before?.parentElement === categoryShelfContainer) categoryShelfContainer.insertBefore(playlist, before);
      else categoryShelfContainer.appendChild(playlist);
    };
    const categoryRowHeight = (): number => {
      const probe = node('section', 'central-row');
      probe.style.position = 'absolute'; probe.style.left = '-10000px'; probe.style.top = '0';
      probe.style.width = `${Math.max(320, content.clientWidth)}px`; probe.style.visibility = 'hidden';
      probe.appendChild(node('h2', undefined, 'Category'));
      const shelf = node('div', 'central-shelf');
      const list = node('div', 'central-cards'); list.appendChild(node('button', 'central-card'));
      shelf.appendChild(list); probe.appendChild(shelf); content.appendChild(probe);
      const height = probe.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(probe).marginBottom) || 0);
      probe.remove();
      return Math.max(180, height || window.innerWidth * .16);
    };
    const estimatedRowHeight = categoryRowHeight();
    const makeCategorySpacer = (record: CategoryRowRecord, height = estimatedRowHeight): HTMLElement => {
      const spacer = node('div', 'central-row central-category-spacer');
      spacer.style.height = `${Math.max(1, height)}px`; spacer.dataset.categoryIndex = `${categoryRows.indexOf(record)}`;
      spacer.setAttribute('aria-label', `${record.group.name} category shelf`);
      spacer.addEventListener('central-load-category-row', () => {
        void loadCategoryRow(record, true).then(() => {
          const firstCard = record.row?.querySelector<HTMLButtonElement>('[data-card-key]');
          if (firstCard && record.row) focusShelfCard(firstCard, record.row);
        });
      });
      return spacer;
    };
    const unmountCategoryRow = (record: CategoryRowRecord): void => {
      if (!record.row || record.row.contains(document.activeElement)) return;
      const rect = record.row.getBoundingClientRect();
      const marginBottom = Number.parseFloat(getComputedStyle(record.row).marginBottom) || 0;
      const spacer = makeCategorySpacer(record, rect.height + marginBottom);
      categoryShelfContainer.replaceChild(spacer, record.row); record.row = null; record.spacer = spacer;
    };
    const categoryReferenceIndex = (): number => {
      const center = window.innerHeight / 2;
      let bestIndex = -1, bestDistance = Infinity;
      categoryRows.forEach((record, index) => {
        const element = record.row ?? record.spacer;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - center);
        if (distance < bestDistance) { bestIndex = index; bestDistance = distance; }
      });
      return bestIndex;
    };
    const trimCategoryCache = (referenceIndex = categoryReferenceIndex(), protectedRecord?: CategoryRowRecord): void => {
      let mounted = categoryRows.filter((record) => record.row);
      while (mounted.length > 20) {
        const victim = mounted.filter((record) => record !== protectedRecord && !record.row?.contains(document.activeElement))
          .sort((a, b) => Math.abs(categoryRows.indexOf(b) - referenceIndex) - Math.abs(categoryRows.indexOf(a) - referenceIndex))[0];
        if (!victim) break;
        unmountCategoryRow(victim); mounted = categoryRows.filter((record) => record.row);
      }
    };
    const loadCategoryRow = async (record: CategoryRowRecord, protectFromTrim = false): Promise<void> => {
      if (record.loading || record.row || view !== section) return;
      record.loading = true;
      try {
        const firstPage = await api<CatalogPage>(`/${section}?page=1&limit=20&language=${encodeURIComponent(appLanguage)}&category=${encodeURIComponent(record.group.id)}`);
        if (view !== section || !categoryShelfContainer.isConnected) return;
        if (firstPage.items.length) {
          const playlist = makeCategoryPlaylist(record.group, firstPage);
          const next = categoryRows.slice(categoryRows.indexOf(record) + 1).map((entry) => entry.row ?? entry.spacer).find((element): element is HTMLElement => Boolean(element));
          attachCategoryRow(record, playlist, next ?? null);
          trimCategoryCache(categoryReferenceIndex(), protectFromTrim ? record : undefined);
        } else { record.spacer?.remove(); record.spacer = null; }
      } catch { /* Retry when the spacer returns into the preload window. */ }
      finally { record.loading = false; }
    };
    categories.forEach((group) => {
      const record: CategoryRowRecord = { group, row: null, spacer: null, loading: false };
      categoryRows.push(record);
      record.spacer = makeCategorySpacer(record);
      categoryShelfContainer.appendChild(record.spacer);
    });
    const scrollCategoryRowToTop = (element: HTMLElement, index: number): void => {
      const safeTop = (document.getElementById('central-header')?.getBoundingClientRect().bottom ?? 88) + 18;
      if (index === categoryRows.length - 1) {
        const requiredBottomSpace = Math.max(0, window.innerHeight - safeTop - element.getBoundingClientRect().height + 24);
        const currentBottomSpace = Number.parseFloat(categoryShelfContainer.style.paddingBottom) || 0;
        if (requiredBottomSpace > currentBottomSpace) categoryShelfContainer.style.paddingBottom = `${requiredBottomSpace}px`;
      }
      scrollWindowTo(Math.max(0, window.scrollY + element.getBoundingClientRect().top - safeTop));
    };
    const onCategoryPageScroll = (): void => {
      if (view !== section || !categoryShelfContainer.isConnected) return;
      const firstRect = (categoryRows[0]?.row ?? categoryRows[0]?.spacer)?.getBoundingClientRect();
      if (!firstRect || firstRect.top > window.innerHeight + estimatedRowHeight) return;
      const safeTop = (document.getElementById('central-header')?.getBoundingClientRect().bottom ?? 88) + 18;
      let anchorIndex = categoryRows.findIndex((record) => {
        const element = record.row ?? record.spacer;
        return Boolean(element && element.getBoundingClientRect().bottom > safeTop);
      });
      if (anchorIndex < 0) anchorIndex = categoryRows.length - 1;
      const firstIndex = Math.max(0, anchorIndex - 2);
      const lastIndex = Math.min(categoryRows.length - 1, anchorIndex + 3);
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const record = categoryRows[index];
        if (record?.spacer) void loadCategoryRow(record);
      }
      trimCategoryCache(anchorIndex);
    };
    categoryViewScrollHandlers.set(section, onCategoryPageScroll);
    activeCategoryPageScrollHandler = onCategoryPageScroll;
    onCategoryPageScroll();
    addCategoryJumpMenu(section, categories, async (group) => {
      const targetIndex = categories.findIndex((category) => category.id === group.id);
      const record = categoryRows.find((entry) => entry.group.id === group.id);
      if (!record) return;
      if (record.spacer) {
        scrollCategoryRowToTop(record.spacer, targetIndex);
        await loadCategoryRow(record, true);
      }
      const targetRow = record.row;
      const firstCard = targetRow?.querySelector<HTMLButtonElement>('[data-card-key]');
      if (targetRow && firstCard) focusShelfCard(firstCard, targetRow, true);
      else if (targetRow) {
        scrollCategoryRowToTop(targetRow, targetIndex);
      }
      for (let index = Math.max(0, targetIndex - 2); index <= Math.min(categoryRows.length - 1, targetIndex + 3); index += 1) {
        const nearby = categoryRows[index];
        if (nearby !== record && nearby.spacer) void loadCategoryRow(nearby, true);
      }
    });
    setStatus('');
    (content.querySelector<HTMLButtonElement>('.central-hero-actions button')
      ?? content.querySelector<HTMLButtonElement>('[data-card-key]'))?.focus();
  } catch (error) { if (generation === requestGeneration) setStatus(errorMessage(error)); }
}
async function preloadMediaShelves(section: 'movies' | 'series'): Promise<void> {
  await Promise.all([
    api<Home>(`/home?language=${encodeURIComponent(appLanguage)}${profile ? `&profileId=${encodeURIComponent(profile.id)}` : ''}`),
    api<{ items: BrowseCategory[] }>(`/${section}/categories?language=${encodeURIComponent(appLanguage)}`)
  ]);
}
async function preloadBrowseScreens(): Promise<void> {
  // Home is visible first; warm each tab in turn to avoid a burst of 20 catalog queries.
  await preloadMediaShelves('movies').catch(() => undefined);
  await preloadMediaShelves('series').catch(() => undefined);
}
async function showHome(): Promise<void> {
  const generation = requestGeneration;
  setStatus('Loading home…');
  try {
    const home = await api<Home>(`/home${profile ? `?profileId=${encodeURIComponent(profile.id)}` : ''}`);
    if (generation !== requestGeneration) return;
    clear(content);
    const continueRow = home.rows.find((group) => group.id === 'continue');
    continueRow?.items.forEach((item) => watched.set(`${item.kind}:${item.id}`, item.positionSeconds ?? 0));
    const myListRow = home.rows.find((group) => group.id === 'my-list');
    myListRow?.items.forEach((item) => favorites.add(`${item.kind}:${item.id}`));
    if (home.featured) content.appendChild(featuredHero(home.featured, home.discoverySource));
    const homeTmdbRows = new Set(['top-picks', 'top-250', 'new-releases', 'in-cinemas', 'trending-movies', 'trending-series']);
    const nonTmdbRows = home.discoverySource === 'tmdb' ? []
      : home.rows.filter((group) => !['continue', 'my-list', ...homeTmdbRows].includes(group.id));
    const displayRows = [
      continueRow,
      ...home.rows.filter((group) => homeTmdbRows.has(group.id)),
      ...nonTmdbRows,
      myListRow
    ].filter((group): group is NonNullable<typeof group> => Boolean(group?.items.length));
    displayRows.forEach((group) => content.appendChild(row(group.title, group.items.filter((item) => item.kind !== 'live'))));
    setStatus('');
    const preferred = Array.from(content.querySelectorAll<HTMLButtonElement>('[data-card-key]')).find((button) => button.dataset.cardKey === restoreCardKey);
    (preferred ?? content.querySelector<HTMLButtonElement>('.central-hero-actions button'))?.focus();
    restoreCardKey = '';
  } catch (error) { if (generation === requestGeneration) setStatus(errorMessage(error)); }
}
async function showWhatsNew(): Promise<void> {
  const generation = requestGeneration;
  setStatus('Loading this week’s new titles…');
  try {
    const result = await api<{ rows: Array<{ id: string; title: string; items: Item[] }> }>(`/whats-new?language=${encodeURIComponent(appLanguage)}`);
    if (generation !== requestGeneration) return;
    clear(content);
    content.appendChild(node('h1', 'central-whats-new-title', "What's New"));
    content.appendChild(node('p', 'central-whats-new-note', 'Movies, shows, and episodes added to your catalog in the past seven days.'));
    if (!result.rows.length) content.appendChild(node('p', 'central-whats-new-empty', 'No new titles have been added this week.'));
    for (const group of result.rows) content.appendChild(row(group.title, group.items, Number.MAX_SAFE_INTEGER));
    setStatus('');
    (content.querySelector<HTMLButtonElement>('.central-row [data-card-key]') ?? document.querySelector<HTMLButtonElement>('#central-nav [data-view="whats-new"]'))?.focus();
  } catch (error) { if (generation === requestGeneration) setStatus(errorMessage(error)); }
}
function liveCategoryCode(name: string): string {
  const match = name.match(/^\s*([A-Z]{2,3})\s*\|/i);
  if (!match) return /^\s*USA(?:\s|\||$)/i.test(name) ? 'EN' : 'other';
  const code = match[1].toUpperCase();
  if (['UK', 'IR', 'US', 'USA', 'FOR'].includes(code)) return 'EN';
  if (code === 'BE' || (code === 'EU' && /NETHERLANDS/i.test(name))) return 'NL';
  return code;
}
async function showList(section: 'movies' | 'series' | 'live', append = false, category = selectedCategoryBySection[section], country = section === 'live' ? selectedLiveCountry : '', search = section === 'live' ? selectedLiveSearch : ''): Promise<void> {
  if (section !== 'live' && !append) { await showMediaShelves(section); return; }
  if (section === 'live' && !append) {
    scrollWindowTo(0);
    if (content.querySelector('.central-live-preview')) resetInlineLiveVideo();
  }
  if (section === 'live' && category && hiddenLiveCategoryIds.has(category)) category = '';
  const restoreLiveSearchFocus = section === 'live' && document.activeElement?.classList.contains('central-live-search');
  const generation = requestGeneration;
  if (!append) { page = 1; loadedItems = []; setStatus(`Loading ${section}…`); }
  try {
    const countryQuery = section === 'live' && country ? `&country=${encodeURIComponent(country)}` : '';
    const excludedCategoriesQuery = section === 'live' && hiddenLiveCategoryIds.size ? `&excludeCategories=${encodeURIComponent([...hiddenLiveCategoryIds].join(','))}` : '';
    const normalizedSearch = search.trim();
    const searchQuery = section === 'live' && normalizedSearch ? `&q=${encodeURIComponent(normalizedSearch)}` : '';
    let [result, initialCategoryResult] = await Promise.all([
      api<{ items: Item[]; hasMore: boolean }>(`/${section}?page=${page}&limit=20&language=${encodeURIComponent(appLanguage)}${category ? `&category=${encodeURIComponent(category)}` : ''}${countryQuery}${searchQuery}${excludedCategoriesQuery}`),
      api<{ items: Array<{ id: string; name: string }> }>(`/${section}/categories?language=${encodeURIComponent(appLanguage)}`)
    ]);
    if (generation !== requestGeneration) return;
    let categoryResult = initialCategoryResult;
    // Catalog sync can take a while; NextFlix keeps categories usable independently
    // of the item grid, so wait briefly for the provider's category list to publish.
    if (!categoryResult.items.length) {
      let syncFinished = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await api<{ status: string }>('/provider/status').catch(() => ({ status: 'unknown' }));
        if (generation !== requestGeneration) break;
        if (state.status === 'success') { syncFinished = true; break; }
        if (state.status !== 'syncing') break;
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        categoryResult = await api<{ items: Array<{ id: string; name: string }> }>(`/${section}/categories?language=${encodeURIComponent(appLanguage)}`);
        if (categoryResult.items.length) { syncFinished = true; break; }
      }
      if (syncFinished) {
        const [freshItems, freshCategories] = await Promise.all([
          api<{ items: Item[]; hasMore: boolean }>(`/${section}?page=${page}&limit=20&language=${encodeURIComponent(appLanguage)}${category ? `&category=${encodeURIComponent(category)}` : ''}${countryQuery}${searchQuery}${excludedCategoriesQuery}`),
          api<{ items: Array<{ id: string; name: string }> }>(`/${section}/categories?language=${encodeURIComponent(appLanguage)}`)
        ]);
        result = freshItems;
        categoryResult = freshCategories;
      }
    }
    if (generation !== requestGeneration) return;
    selectedCategoryBySection[section] = category;
    loadedItems = loadedItems.concat(result.items);
    if (section === 'live' && video.parentElement?.classList.contains('central-live-preview')) resetInlineLiveVideo();
    clear(content);
    const liveScreen = section === 'live' ? node('section', 'central-live-screen') : null;
    const heading = node('div', section === 'live' ? 'central-live-showcase' : 'central-list-header');
    if (section !== 'live') heading.appendChild(node('div', 'central-page-kicker', 'EXPLORE'));
    const pageTitle = node('h1', section === 'live' ? 'central-live-title' : 'central-page-title', section === 'live' ? 'Live TV' : section === 'series' ? 'Shows' : 'Movies');
    if (section === 'live') {
      const preview = node('div', 'central-live-preview');
      const previewImage = node('img'); previewImage.alt = ''; previewImage.loading = 'eager'; previewImage.decoding = 'async'; previewImage.className = 'hidden';
      const previewShade = node('div', 'central-live-preview-shade');
      const previewTitle = node('h2', 'central-live-preview-title', 'Select a channel');
      const previewStatus = node('small', 'central-live-preview-status');
      preview.append(previewImage, previewShade, previewTitle, previewStatus); heading.appendChild(preview);
      let selectedPreviewKey = '';
      const previewRequest = (): number => livePreviewGeneration;
      const updateLivePreview = (item: Item): void => {
        const urls = [...imageUrls(item.backdropUrl), ...imageUrls(item.posterUrl)];
        previewTitle.textContent = item.title;
        previewImage.classList.toggle('hidden', urls.length === 0 || (!video.paused && video.parentElement === preview));
        let imageIndex = 0;
        previewImage.onerror = () => { imageIndex += 1; if (urls[imageIndex]) previewImage.src = urls[imageIndex]; else previewImage.classList.add('hidden'); };
        if (urls.length) previewImage.src = urls[imageIndex];
      };
      const loadLivePreview = async (item: Item): Promise<void> => {
        const request = ++livePreviewGeneration;
        livePreviewSourceUrl = '';
        livePreviewSourceFormat = 'm3u8';
        previewStatus.textContent = 'Connecting to channel…';
        // Keep the inline TV preview audible like the selected stream.
        video.muted = false;
        video.pause(); video.removeAttribute('src'); video.load();
        video.classList.add('central-inline-video'); video.classList.remove('central-inline-playing');
        preview.appendChild(video);
        try {
          let resolved: { url: string };
          let format: 'm3u8' | 'ts' = 'm3u8';
          try { resolved = await api<{ url: string }>('/playback/resolve', { kind: 'live', id: item.streamId ?? item.id, format }); }
          catch (error) {
            if (!errorMessage(error).includes('HTTP 422')) throw error;
            format = 'ts';
            resolved = await api<{ url: string }>('/playback/resolve', { kind: 'live', id: item.streamId ?? item.id, format });
          }
          if (request !== previewRequest() || view !== 'live' || video.parentElement !== preview) return;
          livePreviewSourceUrl = resolved.url;
          livePreviewSourceFormat = format;
          const showVideo = (): void => {
            if (request !== previewRequest() || video.parentElement !== preview) return;
            video.classList.add('central-inline-playing');
            previewImage.classList.add('hidden'); previewStatus.textContent = '';
          };
          video.onplaying = showVideo;
          video.onerror = () => { if (request === previewRequest() && video.parentElement === preview) previewStatus.textContent = 'Channel preview unavailable'; };
          video.src = resolved.url; video.load();
          await video.play();
          showVideo();
        } catch { if (request === previewRequest() && video.parentElement === preview) previewStatus.textContent = 'Channel preview unavailable'; }
      };
      livePreviewLoader = (item) => { void loadLivePreview(item); };
      const makeLiveCard = (item: Item): HTMLButtonElement => {
        const channelCard = card(item);
        channelCard.onclick = () => {
          const key = `${item.streamId ?? item.id}`;
          lastFocus = channelCard;
          if (selectedPreviewKey === key && video.parentElement === preview) {
            void play(item, livePreviewSourceFormat, undefined, livePreviewSourceUrl || undefined); return;
          }
          selectedPreviewKey = key;
          updateLivePreview(item);
          void loadLivePreview(item);
        };
        return channelCard;
      };
      liveScreen?.appendChild(heading);
      // Keep closures available for the grid and asynchronous page loader below.
      Object.assign(heading, { updateLivePreview, makeLiveCard });
      if (result.items[0]) updateLivePreview(result.items[0]);
    } else { heading.appendChild(pageTitle); content.appendChild(heading); }
    const categoryBar = node('div', 'central-category-bar');
    if (section === 'live') categoryBar.classList.add('central-live-category-bar');
    let livePage = page;
    let liveHasMore = section === 'live' && result.hasMore;
    let liveLoading = false;
    let liveQuery = search.trim();
    let liveDataGeneration = liveSearchGeneration;
    let liveGrid: HTMLElement | null = null;
    let fetchLivePage: () => Promise<void> = async () => undefined;
    const liveShowcase = heading as HTMLElement & { makeLiveCard?: (item: Item) => HTMLButtonElement; updateLivePreview?: (item: Item) => void };
    const makeLiveCard = liveShowcase.makeLiveCard ?? card;
    const liveCountries = section === 'live' ? [...new Set(categoryResult.items.map((group) => liveCategoryCode(group.name)))].sort((a, b) => a === 'other' ? 1 : b === 'other' ? -1 : a.localeCompare(b)) : [];
    if (section === 'live') {
      const countryLabel = node('label', 'central-category-picker');
      countryLabel.appendChild(node('span', '', 'Language'));
      const countrySelect = node('select', 'central-category-select') as HTMLSelectElement;
      countrySelect.setAttribute('aria-label', 'Filter Live TV by language group');
      countrySelect.appendChild(new Option('All languages', ''));
      liveCountries.forEach((code) => countrySelect.appendChild(new Option(code === 'other' ? 'Other' : code, code)));
      countrySelect.value = country;
      countrySelect.onchange = () => {
        selectedLiveCountry = countrySelect.value; selectedCategoryBySection.live = ''; page = 1; loadedItems = [];
        void showList('live', false, '', selectedLiveCountry, selectedLiveSearch);
      };
      countryLabel.appendChild(countrySelect); categoryBar.appendChild(countryLabel);
    }
    const categoryLabel = node('label', 'central-category-picker');
    categoryLabel.appendChild(node('span', '', section === 'live' ? 'Category' : 'Genres'));
    const categorySelect = node('select', 'central-category-select') as HTMLSelectElement;
    if (section === 'live') {
      categorySelect.id = 'central-live-category-select';
      categorySelect.onkeydown = (event) => {
        if (event.key === 'ArrowRight') {
          const searchInput = content.querySelector<HTMLInputElement>('#central-live-search');
          if (searchInput) { event.preventDefault(); event.stopPropagation(); searchInput.focus(); }
        }
      };
    }
    categorySelect.setAttribute('aria-label', `Filter ${section} by genre`);
    categorySelect.appendChild(new Option('All categories', ''));
    const visibleCategories = section === 'live'
      ? categoryResult.items.filter((group) => !hiddenLiveCategoryIds.has(group.id) && (!country || liveCategoryCode(group.name) === country))
      : categoryResult.items;
    for (const group of visibleCategories) {
      if (!group.id || !group.name) continue;
      categorySelect.appendChild(new Option(group.name, group.id));
    }
    categorySelect.value = category;
    categorySelect.onchange = () => { page = 1; loadedItems = []; void showList(section, false, categorySelect.value, country, section === 'live' ? selectedLiveSearch : search); };
    categoryLabel.appendChild(categorySelect);
    categoryBar.appendChild(categoryLabel);
    if (section === 'live') {
      const searchInput = node('input', 'central-live-search') as HTMLInputElement;
      searchInput.id = 'central-live-search';
      searchInput.type = 'search';
      searchInput.readOnly = false;
      searchInput.placeholder = category ? 'Search this category' : 'Search channels';
      searchInput.setAttribute('aria-label', category ? 'Search channels in the selected category' : 'Search live TV channels');
      searchInput.value = search;
      searchInput.onkeydown = (event) => {
        const keyCode = (event as KeyboardEvent).keyCode;
        if (event.key === 'Enter' || event.key === 'OK' || keyCode === 13 || keyCode === 23) {
          event.preventDefault(); event.stopPropagation();
          const firstChannel = content.querySelector<HTMLButtonElement>('.central-grid .central-card');
          firstChannel?.focus(); firstChannel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return;
        }
        if (event.key === 'ArrowDown') {
          const firstChannel = content.querySelector<HTMLButtonElement>('.central-grid .central-card');
          if (firstChannel) { event.preventDefault(); event.stopPropagation(); firstChannel.focus(); firstChannel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault(); event.stopPropagation();
          document.querySelector<HTMLButtonElement>('#central-nav [data-view="live"]')?.focus();
        }
        if (event.key === 'ArrowLeft' && searchInput.selectionStart === 0) {
          const categorySelect = content.querySelector<HTMLSelectElement>('#central-live-category-select');
          if (categorySelect) { event.preventDefault(); event.stopPropagation(); categorySelect.focus(); }
        }
      };
      searchInput.oninput = () => {
        selectedLiveSearch = searchInput.value;
        const generation = ++liveSearchGeneration;
        window.clearTimeout(liveSearchTimer);
        liveSearchTimer = window.setTimeout(() => {
          const query = selectedLiveSearch.trim();
          page = 1; livePage = 0; liveQuery = query; liveDataGeneration = generation; liveHasMore = false; liveLoading = false; loadedItems = []; clear(grid);
          setStatus(query ? 'Searching channels…' : 'Loading channels…');
          const queryString = query ? `&q=${encodeURIComponent(query)}` : '';
          const excludedCategoriesQuery = hiddenLiveCategoryIds.size ? `&excludeCategories=${encodeURIComponent([...hiddenLiveCategoryIds].join(','))}` : '';
          void api<CatalogPage>(`/live?page=1&limit=20&language=${encodeURIComponent(appLanguage)}${selectedCategoryBySection.live ? `&category=${encodeURIComponent(selectedCategoryBySection.live)}` : ''}${selectedLiveCountry ? `&country=${encodeURIComponent(selectedLiveCountry)}` : ''}${queryString}${excludedCategoriesQuery}`)
            .then((result) => {
              if (generation !== liveSearchGeneration || view !== 'live') return;
              page = 1; livePage = 1; liveQuery = query; liveDataGeneration = generation; liveLoading = false; liveHasMore = result.hasMore; loadedItems = result.items;
              result.items.forEach((item) => grid.appendChild(makeLiveCard(item)));
              setStatus(result.items.length ? '' : query ? 'No channels match this search in the selected category.' : 'No items are available yet.');
              if (liveHasMore) void fetchLivePage();
            }).catch((error) => { if (generation === liveSearchGeneration && view === 'live') setStatus(errorMessage(error)); });
        }, 250);
      };
      categoryBar.appendChild(searchInput);
    }
    if (liveScreen) liveScreen.appendChild(categoryBar); else content.appendChild(categoryBar);
    const grid = node('div', section === 'live' ? 'central-grid central-live-grid' : 'central-grid');
    loadedItems.forEach((item) => grid.appendChild(section === 'live' ? makeLiveCard(item) : card(item)));
    if (liveScreen) {
      liveScreen.appendChild(grid); content.appendChild(liveScreen);
      if (section === 'live') window.requestAnimationFrame(fitWebosLivePreview);
    }
    else content.appendChild(grid);
    if (section === 'live') {
      const jumpCategories = categoryResult.items.filter((group) => group.id && group.name && !hiddenLiveCategoryIds.has(group.id));
      addCategoryJumpMenu('live', jumpCategories, (group) => {
        selectedLiveCountry = liveCategoryCode(group.name);
        selectedLiveSearch = '';
        selectedCategoryBySection.live = group.id;
        void showList('live', false, group.id, selectedLiveCountry, '');
      });
    }
    if (section === 'live') grid.scrollTop = 0;
    liveGrid = section === 'live' ? grid : null;
    fetchLivePage = async (): Promise<void> => {
      if (!liveScreen || !liveGrid || !liveHasMore || liveLoading || view !== 'live') return;
      liveLoading = true;
      const nextPage = livePage + 1, query = liveQuery, generation = liveDataGeneration;
      const queryString = query ? `&q=${encodeURIComponent(query)}` : '';
      const excludedCategoriesQuery = hiddenLiveCategoryIds.size ? `&excludeCategories=${encodeURIComponent([...hiddenLiveCategoryIds].join(','))}` : '';
      try {
        const next = await api<CatalogPage>(`/live?page=${nextPage}&limit=20&language=${encodeURIComponent(appLanguage)}${selectedCategoryBySection.live ? `&category=${encodeURIComponent(selectedCategoryBySection.live)}` : ''}${selectedLiveCountry ? `&country=${encodeURIComponent(selectedLiveCountry)}` : ''}${queryString}${excludedCategoriesQuery}`);
        if (generation !== liveSearchGeneration || view !== 'live') return;
        livePage = nextPage; page = nextPage; liveHasMore = next.hasMore; loadedItems = loadedItems.concat(next.items);
        next.items.forEach((item) => liveGrid!.appendChild(makeLiveCard(item)));
        setStatus('');
      } catch (error) { if (generation === liveSearchGeneration && view === 'live') setStatus(errorMessage(error)); }
      finally { liveLoading = false; }
    };
    if (section === 'live') {
      grid.addEventListener('scroll', () => {
        updatePageScrollControls();
        if (grid.scrollHeight - grid.scrollTop - grid.clientHeight <= Math.max(240, grid.clientHeight * .8)) void fetchLivePage();
      }, { passive: true });
      window.requestAnimationFrame(() => { if (liveHasMore) void fetchLivePage(); });
    } else if (result.hasMore) {
      let nextPage = 1, hasMore = true, loading = false;
      const loadNextPage = async (): Promise<void> => {
        if (!hasMore || loading || !grid.isConnected) return;
        loading = true;
        try {
          const next = await api<CatalogPage>(`/${section}?page=${nextPage + 1}&limit=20&language=${encodeURIComponent(appLanguage)}${category ? `&category=${encodeURIComponent(category)}` : ''}`);
          if (!grid.isConnected) return;
          nextPage += 1; hasMore = next.hasMore;
          next.items.forEach((item) => grid.appendChild(card(item)));
        } catch { /* Keep the currently loaded titles visible; scrolling can retry. */ }
        finally { loading = false; }
      };
      const sentinel = node('div', 'central-infinite-sentinel'); sentinel.setAttribute('aria-hidden', 'true'); content.appendChild(sentinel);
      const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadNextPage(); }, { rootMargin: '500px 0px' });
      observer.observe(sentinel);
    }
    setStatus(result.items.length ? '' : search.trim() ? 'No channels match this search in the selected category.' : category ? 'No items in this category.' : 'No items are available yet.');
    if (!append) focusReturnedCard(grid);
    if (!append && restoreLiveSearchFocus) content.querySelector<HTMLInputElement>('.central-live-search')?.focus();
  } catch (error) { if (generation === requestGeneration) setStatus(errorMessage(error)); }
}
async function showMyList(): Promise<void> {
  if (!profile) return;
  try {
    const [result, home] = await Promise.all([
      api<{ items: Item[] }>(`/profiles/${profile!.id}/my-list?language=${encodeURIComponent(appLanguage)}`),
      api<Home>(`/home?profileId=${encodeURIComponent(profile.id)}&language=${encodeURIComponent(appLanguage)}`)
    ]);
    if (view !== 'my-list') return;
    clear(content); content.appendChild(node('div', 'central-page-kicker', 'YOUR SPACE'));
    content.appendChild(node('h1', 'central-page-title', 'My Cinema'));
    const continueItems = home.rows.find((group) => group.id === 'continue')?.items || [];
    if (continueItems.length) content.appendChild(row('Continue Watching', continueItems));
    if (result.items.length) content.appendChild(row('My List', result.items));
    if (!continueItems.length && !result.items.length) content.appendChild(node('p', 'central-page-description', 'Titles you save or start watching will appear here.'));
    focusReturnedCard(content);
  } catch (error) { setStatus(errorMessage(error)); }
}
type DatabaseSummary = { counts: { movies: number; series: number; liveTv: number; episodes: number; episodeStreams?: number };
  lastRefreshed?: string | null; refresh: { status: string; phase: string; processed: number; total: number; startedAt?: string; finishedAt?: string; message?: string } };
async function showDatabase(): Promise<void> {
  clear(content);
  const page = node('section', 'central-database-page');
  page.append(node('div', 'central-page-kicker', 'CATALOG'), node('h1', 'central-page-title', 'Database information'));
  page.appendChild(node('p', 'central-db-note', 'Active stream and episode totals in the NightOwl catalog.'));
  const counts = node('div', 'central-db-counts'); page.appendChild(counts);
  const refresh = node('button', 'central-more central-db-refresh', 'Refresh catalog') as HTMLButtonElement;
  const statusMessage = node('p', 'central-db-note', 'Loading catalog information…');
  page.append(refresh, statusMessage); content.appendChild(page);
  let polling = false;
  const refreshStatus = (state: DatabaseSummary['refresh']): void => {
    const progress = state.total ? ` (${state.processed.toLocaleString()} / ${state.total.toLocaleString()})` : '';
    statusMessage.textContent = state.status === 'running' ? `${state.phase}${progress}. NightOwl compares playlist stream IDs and imports only missing entries.`
      : state.status === 'success' ? `${state.message || 'Catalog refresh complete.'}${state.finishedAt ? ` · ${new Date(state.finishedAt).toLocaleString()}` : ''}`
        : state.status === 'error' ? `${state.message || 'Refresh failed.'}${state.finishedAt ? ` · ${new Date(state.finishedAt).toLocaleString()}` : ''}`
      : 'Refresh scans the provider’s full lists and series details, then adds provider IDs that are not already in the database.';
    refresh.disabled = state.status === 'running'; refresh.textContent = state.status === 'running' ? 'Refreshing…' : 'Refresh catalog';
  };
  const loadSummary = async (): Promise<void> => {
    const data = await api<DatabaseSummary>('/database/summary');
    if (view !== 'database') return;
    clear(counts);
    const values: Array<[string, number]> = [['Movie streams', data.counts.movies], ['Series streams', data.counts.series],
      ['Live TV streams', data.counts.liveTv], ['Episodes', data.counts.episodes]];
    for (const [label, value] of values) {
      const tile = node('div', 'central-db-count'); tile.append(node('strong', '', value.toLocaleString()), node('span', '', label)); counts.appendChild(tile);
    }
    refreshStatus(data.refresh);
    if (data.refresh.status === 'idle' && data.lastRefreshed) statusMessage.textContent += ` Most recently imported stream: ${new Date(data.lastRefreshed).toLocaleString()}.`;
    if (data.refresh.status === 'running' && !polling) {
      polling = true;
      window.setTimeout(() => { polling = false; if (view === 'database') void loadSummary().catch((error) => { statusMessage.textContent = errorMessage(error); }); }, 2000);
    }
  };
  refresh.onclick = () => {
    refresh.disabled = true; statusMessage.textContent = 'Starting provider catalog check…';
    void api<{ refresh: DatabaseSummary['refresh'] }>('/provider/sync', {}).then(() => loadSummary())
      .catch((error) => { statusMessage.textContent = errorMessage(error); refresh.disabled = false; });
  };
  try { await loadSummary(); } catch (error) { statusMessage.textContent = errorMessage(error); }
}
function showSearch(): void {
  const searchPage = node('section', 'central-search-page');
  const heading = node('h1', 'central-page-title', 'Search'); searchPage.appendChild(heading);
  const input = node('input', 'central-search') as HTMLInputElement; input.type = 'search'; input.placeholder = 'Movies and series';
  searchPage.appendChild(input);
  const results = node('div', 'central-grid central-search-results'); searchPage.appendChild(results);
  results.addEventListener('scroll', updatePageScrollControls, { passive: true });
  content.appendChild(searchPage);
  let timer = 0, resultPage = 0, resultPageSize = 20, currentQuery = '', hasMore = false, searchGeneration = 0, activeSearchRequests = 0;
  let searchPreloadObserver: IntersectionObserver | null = null;
  const pageSizeForSevenRows = (): number => {
    const gridWidth = results.clientWidth || window.innerWidth * .916;
    const columns = Math.max(1, Math.floor((gridWidth + 13) / 253));
    return Math.min(80, Math.max(2, columns * 7));
  };
  let focusResultsWhenLoaded = false;
  const loadSearchPage = async (reset: boolean, focusFirstNew = false): Promise<void> => {
    const query = input.value.trim();
    if (query.length < 2 || (!reset && activeSearchRequests > 0) || view !== 'search') return;
    if (reset) {
      currentQuery = query; resultPage = 0; resultPageSize = pageSizeForSevenRows(); hasMore = false;
      clear(results);
    }
    if (query !== currentQuery) return;
    const generation = searchGeneration;
    const nextPage = reset ? 1 : resultPage + 1;
    const existingCount = results.children.length;
    activeSearchRequests += 1;
    try {
      const data = await api<{ movies: Item[]; series: Item[]; hasMore: boolean }>(`/search?q=${encodeURIComponent(query)}&page=${nextPage}&limit=${resultPageSize}&language=${encodeURIComponent(appLanguage)}`);
      if (input.value.trim() !== query || view !== 'search' || currentQuery !== query || generation !== searchGeneration) return;
      const newItems = data.movies.concat(data.series);
      newItems.forEach((item) => results.appendChild(card(item)));
      resultPage = nextPage; hasMore = data.hasMore;
      if (reset) {
        searchPreloadObserver?.disconnect();
        const sentinel = node('div', 'central-infinite-sentinel'); sentinel.setAttribute('aria-hidden', 'true'); searchPage.appendChild(sentinel);
        searchPreloadObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting) && hasMore && !activeSearchRequests) void loadSearchPage(false);
        }, { rootMargin: '700px 0px' });
        searchPreloadObserver.observe(sentinel);
      }
      setStatus(results.children.length ? '' : 'No results.');
      if ((focusFirstNew || focusResultsWhenLoaded) && newItems.length) {
        const firstNew = results.querySelectorAll<HTMLButtonElement>('.central-card')[focusFirstNew ? existingCount : 0];
        focusResultsWhenLoaded = false;
        firstNew?.focus(); firstNew?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    } catch (error) { if (input.value.trim() === query && view === 'search' && generation === searchGeneration) setStatus(errorMessage(error)); }
    finally { activeSearchRequests = Math.max(0, activeSearchRequests - 1); }
  };
  input.oninput = () => {
    searchGeneration += 1;
    window.clearTimeout(timer); const query = input.value.trim(); clear(results); hasMore = false; resultPage = 0;
    searchPreloadObserver?.disconnect(); searchPreloadObserver = null;
    searchPage.querySelector('.central-infinite-sentinel')?.remove();
    if (query.length < 2) { currentQuery = query; return; }
    currentQuery = query;
    timer = window.setTimeout(() => { void loadSearchPage(true); }, 250);
  };
  input.onkeydown = (event) => {
    const keyCode = (event as KeyboardEvent).keyCode;
    if (event.key === 'Enter' || event.key === 'OK' || keyCode === 13 || keyCode === 23) {
      event.preventDefault(); event.stopPropagation();
      const firstResult = results.querySelector<HTMLButtonElement>('.central-card');
      if (firstResult) { firstResult.focus(); firstResult.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
      if (input.value.trim().length >= 2) { focusResultsWhenLoaded = true; window.clearTimeout(timer); if (!activeSearchRequests) void loadSearchPage(true); }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      document.querySelector<HTMLButtonElement>('#central-nav [data-view="search"]')?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation();
      const firstResult = results.querySelector<HTMLButtonElement>('.central-card');
      if (firstResult) { firstResult.focus(); firstResult.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
      if (input.value.trim().length >= 2) {
        focusResultsWhenLoaded = true;
        window.clearTimeout(timer);
        if (!activeSearchRequests) void loadSearchPage(true);
      }
    }
  };
  input.focus();
}
async function openItem(item: Item): Promise<void> {
  if (item.kind === 'live') { await play(item); return; }
  if (item.kind === 'episode') {
    if (item.seriesId && item.seriesTitle) {
      await openItem({ kind: 'series', id: item.seriesId, title: item.seriesTitle, posterUrl: item.posterUrl, backdropUrl: item.backdropUrl,
        highlightEpisodeCanonicalId: item.canonicalId, highlightSeasonNumber: item.seasonNumber });
      return;
    }
    await play(item); return;
  }
  lastFocus = document.activeElement as HTMLElement;
  restoreCardKey = `${item.kind}:${item.id}`;
  scrollWindowTo(0);
  view = 'detail'; clear(content); app.classList.add('detail-open'); setStatus('Loading details…');
  try {
    const detail = await api<Item>(`/${item.kind === 'movie' ? 'movies' : 'series'}/${item.id}?language=${encodeURIComponent(appLanguage)}`);
    if (view !== 'detail') return;
    currentItem = detail;
    clear(content); setStatus('');
    const layout = node('section', `central-detail${detail.kind === 'series' ? ' central-series-detail' : ''}`);
    const selectedCardImage = lastFocus?.querySelector<HTMLImageElement>('img')?.currentSrc || lastFocus?.querySelector<HTMLImageElement>('img')?.src;
    const detailBackdrops = [...(selectedCardImage ? imageUrls(selectedCardImage) : []),
      ...imageUrls(item.backdropUrl), ...imageUrls(item.posterUrl), ...imageUrls(detail.backdropUrl), ...imageUrls(detail.posterUrl)];
    if (detailBackdrops.length) {
      const image = node('img', 'central-detail-backdrop'); image.alt = ''; let sourceIndex = 0;
      image.onerror = () => { sourceIndex += 1; if (detailBackdrops[sourceIndex]) image.src = detailBackdrops[sourceIndex]; else image.remove(); };
      image.src = detailBackdrops[sourceIndex]; layout.appendChild(image);
    }
    const detailPosters = [...imageUrls(detail.posterUrl), ...imageUrls(item.posterUrl)];
    const displayTitle = normalizeDisplayTitle(item.title || detail.title);
    if (detailPosters.length) { const poster = node('img', 'central-detail-poster'); poster.src = detailPosters[0]; poster.alt = `${displayTitle} poster`; poster.onerror = () => poster.remove(); layout.appendChild(poster); }
    const body = node('div', 'central-detail-body');
    const back = node('button', 'central-detail-back', '←  Back') as HTMLButtonElement;
    back.onclick = () => backFromDetail(); body.appendChild(back);
    body.appendChild(node('div', 'central-hero-eyebrow', detail.kind === 'series' ? 'SERIES' : 'FILM'));
    body.appendChild(node('h1', undefined, displayTitle));
    const meta = [detail.releaseYear, detail.genre, detail.durationSeconds ? `${Math.round(detail.durationSeconds / 60)} min` : ''].filter(Boolean).join(' · ');
    body.appendChild(node('div', 'central-detail-meta', meta));
    const description = detail.description?.trim() || item.description?.trim();
    body.appendChild(node('p', undefined, description || (detail.descriptionStatus === 'unavailable'
      ? 'The description could not be loaded from TMDB. Please try again later.'
      : `No information is available for this ${detail.kind === 'series' ? 'show' : 'movie'}.`)));
    let selectedStreamId = item.streamId || detail.streamId || detail.id;
    let languagePicker: HTMLElement | null = null;
    if (detail.kind === 'movie' && (detail.streams?.length ?? 0) > 0) {
      const languageStreams = detail.streams!;
      const rememberedStream = item.streamId ? languageStreams.find((stream) => (stream.providerId || stream.id) === item.streamId) : undefined;
      const languageName = (stream: NonNullable<Item['streams']>[number]): string =>
        stream.language?.trim() || (stream.languageCode && stream.languageCode !== 'und' ? stream.languageCode.toUpperCase() : 'Unlabelled');
      const orderedLanguageStreams = rememberedStream ? [rememberedStream, ...languageStreams.filter((stream) => stream !== rememberedStream)] : languageStreams;
      const distinctStreams = orderedLanguageStreams.filter((stream, index, all) => all.findIndex((candidate) =>
        (candidate.languageCode || candidate.language || 'und').toLowerCase() === (stream.languageCode || stream.language || 'und').toLowerCase()) === index);
      const selectedStream = languageStreams.find((stream) => (stream.providerId || stream.id) === selectedStreamId) ?? languageStreams[0];
      languagePicker = node('div', 'central-language-block');
      if (distinctStreams.length > 1) {
        const picker = node('label', 'central-category-picker movie-language-picker');
        picker.appendChild(node('span', '', 'Play version'));
        const select = node('select', 'central-category-select') as HTMLSelectElement;
        distinctStreams.forEach((stream) => {
          const streamId = stream.providerId || stream.id;
          select.appendChild(new Option(languageName(stream), streamId));
        });
        select.value = distinctStreams.some((stream) => (stream.providerId || stream.id) === selectedStreamId)
          ? selectedStreamId : (distinctStreams[0].providerId || distinctStreams[0].id);
        selectedStreamId = select.value;
        const selectedInfo = node('small', 'central-language-selected');
        const otherInfo = node('small', 'central-language-alternates');
        const updateLanguageInfo = (): void => {
          const current = distinctStreams.find((stream) => (stream.providerId || stream.id) === selectedStreamId) ?? distinctStreams[0];
          const currentKey = (current.languageCode || current.language || 'und').toLowerCase();
          const alternates = distinctStreams.filter((stream) => (stream.languageCode || stream.language || 'und').toLowerCase() !== currentKey).map(languageName);
          selectedInfo.textContent = `This stream will play in ${languageName(current)}.`;
          otherInfo.textContent = alternates.length ? `Other available languages: ${alternates.join(', ')}.` : 'No other language versions are available.';
        };
        select.onchange = () => { selectedStreamId = select.value; updateLanguageInfo(); };
        picker.appendChild(select); languagePicker.appendChild(picker);
        const languageInfo = node('div', 'central-language-details');
        languageInfo.append(selectedInfo, otherInfo); languagePicker.appendChild(languageInfo);
        updateLanguageInfo();
      } else {
        const onlyLanguage = languageName(selectedStream);
        languagePicker.appendChild(node('small', 'central-language-selected', `This stream will play in ${onlyLanguage}.`));
        languagePicker.appendChild(node('small', 'central-language-alternates', 'No other language versions are available.'));
      }
    }
    const actions = node('div', 'central-detail-actions');
    if (detail.kind === 'movie') {
      const playButton = node('button', 'primary', watched.has(`movie:${detail.id}`) ? '▶  Resume' : '▶  Play') as HTMLButtonElement;
      playButton.onclick = () => void play({ ...detail, streamId: selectedStreamId }); actions.appendChild(playButton);
    }
    let saved = favorites.has(`${detail.kind}:${detail.id}`);
    const favorite = node('button', 'secondary', saved ? '✓  In My List' : '＋  My List') as HTMLButtonElement;
    favorite.onclick = () => void (async () => {
      if (!profile) return;
      saved = !saved;
      try { await api(`/profiles/${profile.id}/my-list`, { kind: detail.kind, id: detail.id, saved });
        if (saved) favorites.add(`${detail.kind}:${detail.id}`); else favorites.delete(`${detail.kind}:${detail.id}`);
        favorite.textContent = saved ? '✓  In My List' : '＋  My List'; invalidateHomeCache(); }
      catch (error) { saved = !saved; setStatus(errorMessage(error)); }
    })();
    actions.appendChild(favorite); body.appendChild(actions);
    if (languagePicker) body.appendChild(languagePicker);
    if (detail.kind !== 'movie') body.appendChild(node('div', 'central-detail-audio', detail.metadata?.language ? `Language: ${detail.metadata.language}` : 'Audio and subtitle options appear during playback.'));
    layout.appendChild(body); content.appendChild(layout);
    if (detail.kind === 'series') await showEpisodes(detail.id, layout, item.highlightEpisodeCanonicalId, item.highlightSeasonNumber);
    const highlightedEpisode = content.querySelector<HTMLButtonElement>('.central-episode[data-new-episode="true"]');
    (highlightedEpisode ?? body.querySelector<HTMLButtonElement>('.primary') ?? back).focus();
  } catch (error) { setStatus(errorMessage(error)); }
}
async function showEpisodes(seriesId: string, parent: HTMLElement, highlightEpisodeCanonicalId?: string, highlightSeasonNumber?: number): Promise<void> {
  try {
    const data = await api<{ seasons: Array<{ number: number; count: number }> }>(`/series/${seriesId}/seasons`);
    if (view !== 'detail' || currentItem?.id !== seriesId) return;
    const browser = node('section', 'central-series-browser');
    const seasonPane = node('div', 'central-series-pane central-season-pane');
    const picker = node('nav', 'central-season-picker');
    picker.setAttribute('aria-label', 'Seasons');
    seasonPane.appendChild(picker);
    const episodePane = node('div', 'central-series-pane central-episode-pane');
    const episodes = node('section', 'central-episode-container');
    episodes.setAttribute('aria-label', 'Episodes');
    episodePane.appendChild(episodes);
    ensureVerticalScrollControls(seasonPane, picker);
    ensureVerticalScrollControls(episodePane, episodes);
    let selectedSeason = data.seasons.find((season) => season.number === highlightSeasonNumber)?.number ?? data.seasons[0]?.number;
    for (const season of data.seasons) {
      const button = node('button', 'central-more', `Season ${season.number} (${season.count})`) as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-pressed', `${season.number === selectedSeason}`);
      button.onclick = () => {
        selectedSeason = season.number;
        picker.querySelectorAll<HTMLButtonElement>('button').forEach((candidate) => candidate.setAttribute('aria-pressed', `${candidate === button}`));
        clear(episodes); void loadEpisodePage(seriesId, season.number, 1, episodes);
      };
      picker.appendChild(button);
    }
    browser.append(seasonPane, episodePane); parent.appendChild(browser);
    if (data.seasons.length && selectedSeason !== undefined) {
      const selectedSeasonButton = Array.from(picker.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.getAttribute('aria-pressed') === 'true');
      if (selectedSeasonButton) selectedSeasonButton.scrollIntoView({ block: 'nearest' });
      verticalScrollControls.get(picker)?.update();
      await loadEpisodePage(seriesId, selectedSeason, 1, episodes, highlightEpisodeCanonicalId);
    }
    if (!data.seasons.length) episodes.appendChild(node('p', 'central-episodes-empty', 'Episodes are still syncing. Please check again shortly.'));
  } catch (error) { setStatus(errorMessage(error)); }
}
async function loadEpisodePage(seriesId: string, season: number, episodePage: number, target: HTMLElement, highlightEpisodeCanonicalId?: string): Promise<void> {
  try {
    const result = await api<{ items: Item[]; hasMore: boolean }>(`/series/${seriesId}/seasons/${season}/episodes?page=${episodePage}&limit=20&language=${encodeURIComponent(appLanguage)}`);
    if (view !== 'detail' || currentItem?.id !== seriesId) return;
    if (episodePage === 1) clear(target);
    let foundHighlightedEpisode = false;
    for (const episode of result.items) {
      const button = node('button', 'central-episode', `${episode.episodeNumber ?? ''}. ${episode.title}`) as HTMLButtonElement;
      if (highlightEpisodeCanonicalId && episode.canonicalId === highlightEpisodeCanonicalId) {
        button.dataset.newEpisode = 'true'; button.classList.add('central-episode-new'); foundHighlightedEpisode = true;
      }
      if (episode.description) button.appendChild(node('small', undefined, episode.description));
      button.onclick = () => void play({ ...episode, kind: 'episode' }); target.appendChild(button);
    }
    const existingLoader = target.querySelector<HTMLElement>('.central-episode-sentinel');
    existingLoader?.remove();
    if (result.hasMore && highlightEpisodeCanonicalId && !foundHighlightedEpisode) {
      await loadEpisodePage(seriesId, season, episodePage + 1, target, highlightEpisodeCanonicalId);
      return;
    }
    if (result.hasMore) {
      const sentinel = node('div', 'central-infinite-sentinel central-episode-sentinel'); target.appendChild(sentinel);
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); sentinel.remove(); void loadEpisodePage(seriesId, season, episodePage + 1, target); }
      }, { root: target, rootMargin: '500px 0px' });
      observer.observe(sentinel);
    }
    verticalScrollControls.get(target)?.update();
  } catch (error) { setStatus(errorMessage(error)); }
}
function backFromDetail(): void { navigate(previousView); }
async function play(item: Item, liveFormat: 'm3u8' | 'ts' = 'm3u8', resumeAt?: number, sourceOverride?: string, forceVideoTranscode = false): Promise<void> {
  try {
    let playableItem = item;
    // Featured and shelf cards only carry compact catalog metadata. Hydrate the
    // movie once so the in-player language menu has the same provider variants
    // that are shown on its detail page.
    if (item.kind === 'movie' && !item.streams?.length) {
      try {
        const detail = await api<Item>(`/movies/${item.id}?language=${encodeURIComponent(appLanguage)}`);
        playableItem = { ...item, ...detail, id: item.id, streamId: item.streamId || detail.streamId };
      } catch { /* Keep direct playback available if metadata lookup fails. */ }
    } else if (item.kind === 'episode' && !item.streams?.length) {
      try {
        const variants = await api<{ items: NonNullable<Item['streams']> }>(`/episodes/${item.streamId ?? item.id}/streams?language=${encodeURIComponent(appLanguage)}`);
        playableItem = { ...item, streams: variants.items, streamId: item.streamId ?? item.id };
      } catch { /* Keep episode playback available if the variant lookup fails. */ }
    }
    if (playableItem.kind === 'live') livePreviewGeneration += 1;
    if (video.parentElement !== player) player.insertBefore(video, player.firstChild);
    video.classList.remove('central-inline-video');
    video.muted = false;
    playingItem = playableItem;
    player.classList.toggle('live-playback', playableItem.kind === 'live');
    updatePlayerOptionVisibility();
    clearExternalSubtitle();
    playerStatus.textContent = 'Resolving stream…';
    el('central-playing-title').textContent = normalizeDisplayTitle(playableItem.title);
    player.classList.remove('hidden');
    revealPlayerControls();
    let sourceUrl: string;
    const requiresRemux = playableItem.kind !== 'live' && ['mkv', 'avi', 'wmv', 'flv', 'mov', 'ts', 'mpeg', 'mpg'].includes((playableItem.streams?.find((stream) => stream.id === (playableItem.streamId ?? playableItem.id))?.extension ?? (playableItem as Item & { streamExtension?: string }).streamExtension ?? '').toLowerCase().replace(/^\./, ''));
    activeRemuxMode = requiresRemux ? (forceVideoTranscode ? 'transcode' : 'copy') : null;
    remuxTranscodeAttempted = forceVideoTranscode;
    if (sourceOverride) sourceUrl = sourceOverride;
    else if (requiresRemux) {
      const ticket = await api<{ url: string }>('/playback/remux-ticket', { kind: playableItem.kind, id: playableItem.streamId ?? playableItem.id, transcode: forceVideoTranscode });
      sourceUrl = `${config!.url}${ticket.url}`;
    }
    else sourceUrl = (await api<{ url: string }>(`/playback/resolve`, { kind: playableItem.kind, id: playableItem.streamId ?? playableItem.id, format: playableItem.kind === 'live' ? liveFormat : undefined })).url;
    const stream = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(stream.protocol)) throw new Error('Unsupported stream URL.');
    lastProgressSave = 0; activeLiveFormat = liveFormat;
    playerStatus.textContent = 'Buffering…';
    video.src = sourceUrl;
    video.load();
    updatePlaybackProgress();
    const position = resumeAt ?? watched.get(`${playableItem.kind}:${playableItem.id}`) ?? playableItem.positionSeconds ?? 0;
    video.onloadedmetadata = () => {
      if (position > 0) { try { video.currentTime = position; } catch { /* Live streams may not seek. */ } }
      updatePlaybackProgress();
      updatePlayerOptionVisibility();
    };
    await video.play();
    revealPlayerControls();
    el<HTMLButtonElement>('central-play-pause').focus();
  } catch (error) {
    if (item.kind === 'live' && liveFormat === 'm3u8' && errorMessage(error).includes('HTTP 422')) { await play(item, 'ts'); return; }
    playerStatus.textContent = errorMessage(error); revealPlayerControls();
  }
}
async function saveProgress(completed = false): Promise<void> {
  if (!profile || !playingItem) return;
  const positionSeconds = Number.isFinite(video.currentTime) ? Math.max(0, Math.floor(video.currentTime)) : 0;
  const durationSeconds = Number.isFinite(video.duration) ? Math.floor(video.duration) : undefined;
  watched.set(`${playingItem.kind}:${playingItem.id}`, positionSeconds);
  try { await api(`/profiles/${profile.id}/progress`, { kind: playingItem.kind, id: playingItem.id, positionSeconds, durationSeconds, completed }); invalidateHomeCache(); }
  catch { /* Playback continues if progress cannot be saved. */ }
}
function closePlayer(save = true): void {
  if (player.classList.contains('hidden')) return;
  const liveItemToPreview = playingItem?.kind === 'live' && view === 'live' && content.querySelector('.central-live-preview') ? playingItem : null;
  window.clearTimeout(playerControlsTimer); player.classList.remove('controls-hidden');
  el('central-player-stream-menu').classList.add('hidden');
  if (document.fullscreenElement === player) void document.exitFullscreen().catch(() => undefined);
  if (save && !liveItemToPreview) void saveProgress();
  if (!liveItemToPreview) { video.pause(); video.removeAttribute('src'); video.load(); }
  player.classList.add('hidden'); clearExternalSubtitle();
  playingItem = null;
  if (liveItemToPreview) {
    const preview = content.querySelector<HTMLElement>('.central-live-preview');
    if (preview) { video.classList.add('central-inline-video'); video.classList.remove('central-inline-playing'); preview.appendChild(video); livePreviewLoader?.(liveItemToPreview); }
  }
  lastFocus?.focus();
}
function showProfiles(): void {
  const panel = node('section', 'central-profile-picker');
  panel.appendChild(node('h1', undefined, 'Choose a profile'));
  const choices = node('div', 'central-profile-choices');
  for (const choice of profiles) {
    const button = node('button', 'central-profile-choice', choice.name) as HTMLButtonElement;
    button.onclick = () => { profile = choice; watched.clear(); favorites.clear(); invalidateCatalogCache(); localStorage.setItem('streamcinema.profile', choice.id); renderProfileButton(); navigate('home'); window.setTimeout(() => { void preloadBrowseScreens(); }, 0); };
    choices.appendChild(button);
  }
  panel.appendChild(choices);
  const create = node('form', 'central-profile-create') as HTMLFormElement;
  const input = node('input', 'central-profile-input') as HTMLInputElement; input.placeholder = 'New profile name'; input.maxLength = 24;
  const add = node('button', 'central-profile-add', 'Create profile') as HTMLButtonElement; add.type = 'submit';
  create.append(input, add); panel.appendChild(create);
  create.onsubmit = (event) => { event.preventDefault();
    void (async () => {
      try { const next = await api<Profile>('/profiles', { name: input.value.trim() }); profiles.push(next); profile = next; invalidateCatalogCache(); localStorage.setItem('streamcinema.profile', next.id); renderProfileButton(); navigate('home'); window.setTimeout(() => { void preloadBrowseScreens(); }, 0); }
      catch (error) { setStatus(errorMessage(error)); }
    })();
  };
  content.appendChild(panel);
}
async function showSettings(): Promise<void> {
  const panel = node('section', 'central-settings'); panel.appendChild(node('h1', undefined, 'Settings'));
  panel.appendChild(node('p', undefined, `Server: ${config?.url ?? ''}`));
  let openSubtitlesStatus!: HTMLElement;
  let openSubtitlesForm!: HTMLFormElement;
  panel.appendChild(node('h2', undefined, 'Xtream provider'));
  panel.appendChild(node('p', undefined, 'Credentials are encrypted in the server database and used by the server for playback. Saving credentials does not contact the provider or import the catalog.'));
  const form = node('form', 'provider-form') as HTMLFormElement;
  const providerUrl = node('input', 'central-search') as HTMLInputElement; providerUrl.type = 'url'; providerUrl.required = true; providerUrl.placeholder = 'https://provider.example'; providerUrl.setAttribute('aria-label', 'Xtream server URL');
  const providerUser = node('input', 'central-search') as HTMLInputElement; providerUser.type = 'text'; providerUser.autocomplete = 'off'; providerUser.required = true; providerUser.setAttribute('aria-label', 'Xtream username');
  const providerPass = node('input', 'central-search') as HTMLInputElement; providerPass.type = 'password'; providerPass.autocomplete = 'new-password'; providerPass.required = true; providerPass.setAttribute('aria-label', 'Xtream password');
  const connectProvider = node('button', 'central-more', 'Save credentials') as HTMLButtonElement; connectProvider.type = 'submit';
  const providerMessage = node('p', 'provider-message', 'Your credentials will be stored securely. No catalog sync will start from this screen.');
  void api<{ configured: boolean }>('/provider/status').then(({ configured }) => {
    providerMessage.textContent = configured ? 'Xtream credentials are saved. Enter new values below to replace them.' : 'Add your Xtream provider here. Credentials are stored securely; saving them will not start a catalog sync.';
  }).catch(() => undefined);
  form.append(node('label', undefined, 'Server URL'), providerUrl, node('label', undefined, 'Username'), providerUser,
    node('label', undefined, 'Password'), providerPass, connectProvider, providerMessage);
  form.onsubmit = (event) => {
    event.preventDefault(); connectProvider.disabled = true; providerMessage.textContent = 'Saving credentials securely…';
    void api<{ connected: boolean; catalogSyncStarted: boolean }>(`/provider/connect`, { baseUrl: providerUrl.value.trim(), username: providerUser.value.trim(), password: providerPass.value })
      .then(() => { providerPass.value = ''; providerMessage.textContent = 'Credentials saved. No provider catalog sync was started.'; })
      .catch((error) => { providerMessage.textContent = errorMessage(error); })
      .then(() => { connectProvider.disabled = false; }, () => { connectProvider.disabled = false; });
  };
  panel.appendChild(form);
  const sync = node('p', undefined, 'Loading catalog status…'); panel.appendChild(sync);
  panel.appendChild(node('h2', undefined, 'Home discovery'));
  const tmdbStatus = node('p', undefined, 'Checking TMDB configuration…'); panel.appendChild(tmdbStatus);
  {
    const tmdbForm = node('form', 'provider-form') as HTMLFormElement;
    const tmdbToken = node('input', 'central-search') as HTMLInputElement; tmdbToken.type = 'password'; tmdbToken.autocomplete = 'off'; tmdbToken.placeholder = 'TMDB API key or Read Access Token'; tmdbToken.setAttribute('aria-label', 'TMDB API key or Read Access Token');
    const saveTmdb = node('button', 'central-more', 'Save TMDB token') as HTMLButtonElement; saveTmdb.type = 'submit';
    const tmdbMessage = node('p', 'provider-message', 'The token is sent to the server over this connection and stored encrypted in its database. It is never stored in the browser or written to Git.');
    tmdbForm.append(node('label', undefined, 'TMDB API key or Read Access Token'), tmdbToken, saveTmdb, tmdbMessage);
    tmdbForm.onsubmit = (event) => {
      event.preventDefault(); saveTmdb.disabled = true;
      void api<{ configured: boolean }>('/tmdb/config', { token: tmdbToken.value }).then((result) => {
        tmdbToken.value = ''; tmdbMessage.textContent = result.configured ? 'TMDB token saved securely. Reloading home…' : 'TMDB token cleared.';
        invalidateCatalogCache();
        navigate('home');
        window.setTimeout(() => { void preloadBrowseScreens(); }, 0);
      }).catch((error) => { tmdbMessage.textContent = errorMessage(error); }).then(() => { saveTmdb.disabled = false; }, () => { saveTmdb.disabled = false; });
    };
    panel.appendChild(tmdbForm);
  }
  panel.appendChild(node('h2', undefined, 'Subtitles'));
  panel.appendChild(node('h3', undefined, 'Subtitle search preferences'));
  const subtitleLanguagePicker = node('div', 'central-subtitle-language-preferences');
  subtitleLanguagePicker.appendChild(node('p', 'central-subtitle-language-label', 'Preferred subtitle languages (select all that apply)'));
  const subtitleLanguageOptions = node('div', 'central-subtitle-language-options');
  const selectedSubtitleLanguages = new Set(subtitleSearchLanguages);
  const subtitlePreferenceMessage = node('p', 'provider-message', 'Subtitle search will offer only the languages selected here.');
  const renderSubtitlePreferenceMessage = (): void => {
    const names = availableLanguages.filter(({ code }) => selectedSubtitleLanguages.has(code)).map(({ name }) => name);
    subtitlePreferenceMessage.textContent = names.length ? `Subtitle search languages: ${names.join(', ')}.` : 'Select at least one subtitle language.';
  };
  availableLanguages.forEach(({ code, name }) => {
    const option = node('label', 'provider-hearing-preference');
    const checkbox = node('input') as HTMLInputElement; checkbox.type = 'checkbox'; checkbox.checked = selectedSubtitleLanguages.has(code);
    checkbox.onchange = () => {
      if (checkbox.checked) selectedSubtitleLanguages.add(code);
      else if (selectedSubtitleLanguages.size > 1) selectedSubtitleLanguages.delete(code);
      else { checkbox.checked = true; return; }
      subtitleSearchLanguages = availableLanguages.filter((language) => selectedSubtitleLanguages.has(language.code)).map((language) => language.code);
      localStorage.setItem('streamcinema.subtitle-languages', JSON.stringify(subtitleSearchLanguages));
      renderSubtitlePreferenceMessage();
    };
    option.append(checkbox, document.createTextNode(name)); subtitleLanguageOptions.appendChild(option);
  });
  renderSubtitlePreferenceMessage(); subtitleLanguagePicker.appendChild(subtitleLanguageOptions);
  const hearingPreference = node('label', 'provider-hearing-preference') as HTMLLabelElement;
  const hearingCheckbox = node('input') as HTMLInputElement; hearingCheckbox.type = 'checkbox'; hearingCheckbox.checked = preferHearingImpairedSubtitles;
  hearingCheckbox.onchange = () => { preferHearingImpairedSubtitles = hearingCheckbox.checked; localStorage.setItem('streamcinema.subtitle-hearing-impaired', String(preferHearingImpairedSubtitles)); };
  hearingPreference.append(hearingCheckbox, document.createTextNode('Prefer SDH / hearing-impaired subtitles in search results'));
  panel.append(subtitleLanguagePicker, hearingPreference, subtitlePreferenceMessage);
  openSubtitlesStatus = node('p', undefined, 'Checking OpenSubtitles configuration…');
  {
    const subtitlesForm = node('form', 'provider-form') as HTMLFormElement; openSubtitlesForm = subtitlesForm;
    const apiKey = node('input', 'central-search') as HTMLInputElement; apiKey.type = 'password'; apiKey.autocomplete = 'off'; apiKey.placeholder = 'OpenSubtitles API key'; apiKey.setAttribute('aria-label', 'OpenSubtitles API key');
    const saveKey = node('button', 'central-more', 'Save OpenSubtitles key') as HTMLButtonElement; saveKey.type = 'submit';
    const message = node('p', 'provider-message', 'The API key is sent to the server and stored encrypted. Subtitle search uses the OpenSubtitles REST API.');
    subtitlesForm.append(node('label', undefined, 'OpenSubtitles API key'), apiKey, saveKey, message);
    subtitlesForm.onsubmit = (event) => {
      event.preventDefault(); saveKey.disabled = true; message.textContent = 'Saving key securely…';
      void api<{ configured: boolean }>('/opensubtitles/config', { apiKey: apiKey.value.trim() })
        .then((result) => { apiKey.value = ''; message.textContent = result.configured ? 'OpenSubtitles API key saved securely.' : 'OpenSubtitles API key removed.'; openSubtitlesStatus.textContent = result.configured ? 'OpenSubtitles is configured.' : 'OpenSubtitles is not configured.'; })
        .catch((error) => { message.textContent = errorMessage(error); })
        .then(() => { saveKey.disabled = false; }, () => { saveKey.disabled = false; });
    };
  }
  const aboutHeading = node('h2', undefined, 'About & credits'); panel.appendChild(aboutHeading);
  const credits = node('div', 'central-tmdb-credits');
  const tmdbLink = document.createElement('a'); tmdbLink.href = 'https://www.themoviedb.org'; tmdbLink.target = '_blank'; tmdbLink.rel = 'noopener noreferrer'; tmdbLink.setAttribute('aria-label', 'The Movie Database');
  const tmdbLogo = node('img'); tmdbLogo.src = 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg'; tmdbLogo.alt = 'TMDB'; tmdbLink.appendChild(tmdbLogo); credits.appendChild(tmdbLink);
  credits.appendChild(node('p', '', 'This product uses the TMDB API but is not endorsed or certified by TMDB.'));
  panel.appendChild(credits);
  const reconnect = node('button', undefined, 'Change server') as HTMLButtonElement;
  reconnect.onclick = () => { localStorage.removeItem('streamcinema.config'); location.href = location.pathname; };
  panel.appendChild(reconnect);
  const initialChildren = Array.from(panel.children);
  const settingsTitle = initialChildren[0] as HTMLElement;
  const serverSummary = initialChildren[1] as HTMLElement;
  panel.replaceChildren(settingsTitle, serverSummary);
  const layout = node('div', 'central-settings-layout');
  const sidebar = node('nav', 'central-settings-sidebar'); sidebar.setAttribute('aria-label', 'Settings categories');
  const pageHost = node('div', 'central-settings-pages');
  const pageById = new Map<string, HTMLElement>();
  const navById = new Map<string, HTMLButtonElement>();
  let activeSettingsPage = 'preferences-subtitles';
  const makeGroup = (label: string): void => { sidebar.appendChild(node('div', 'central-settings-group-label', label)); };
  const makePage = (id: string, label: string): HTMLElement => {
    const navButton = node('button', 'central-settings-nav-item', label) as HTMLButtonElement;
    navButton.type = 'button'; navButton.dataset.settingsPage = id; navButton.setAttribute('aria-current', 'false');
    const pageElement = node('section', 'central-settings-page'); pageElement.dataset.settingsPanel = id;
    navButton.onclick = () => selectSettingsPage(id);
    sidebar.appendChild(navButton); pageHost.appendChild(pageElement); pageById.set(id, pageElement); navById.set(id, navButton);
    return pageElement;
  };
  makeGroup('Preferences');
  const subtitlesPage = makePage('preferences-subtitles', 'Subtitles');
  const liveCategoriesPage = makePage('preferences-live', 'Live TV categories');
  const movieCategoriesPage = makePage('preferences-movies', 'Movie categories');
  const seriesCategoriesPage = makePage('preferences-series', 'Show categories');
  makeGroup('Credentials');
  const xtreamPage = makePage('credentials-xtream', 'Xtream provider');
  const tmdbPage = makePage('credentials-tmdb', 'TMDB API key');
  const openSubtitlesPage = makePage('credentials-opensubtitles', 'OpenSubtitles API key');
  makeGroup('Account');
  const databasePage = makePage('database-information', 'Database information');
  const logoutPage = makePage('account-logout', 'Log out');
  function selectSettingsPage(id: string): void {
    activeSettingsPage = id;
    for (const [pageId, pageElement] of pageById) {
      pageElement.hidden = pageId !== id;
      navById.get(pageId)?.setAttribute('aria-current', pageId === id ? 'page' : 'false');
    }
    if (id === 'database-information') void updateDatabaseSummary().catch((error) => { databaseRefreshStatus.textContent = errorMessage(error); });
  }
  let currentPage: HTMLElement | null = null;
  for (const child of initialChildren.slice(2)) {
    if (child === openSubtitlesStatus || child === openSubtitlesForm) continue;
    if (child === aboutHeading) {
      currentPage = openSubtitlesPage;
      openSubtitlesPage.append(openSubtitlesStatus, openSubtitlesForm);
      const about = node('h3', undefined, 'About & credits'); openSubtitlesPage.appendChild(about);
      continue;
    }
    if (child instanceof HTMLHeadingElement && child.tagName === 'H2') {
      const label = child.textContent?.trim();
      if (label === 'Xtream provider') currentPage = xtreamPage;
      else if (label === 'Home discovery') { currentPage = tmdbPage; child.textContent = 'TMDB API key'; }
      else if (label === 'Subtitles') currentPage = subtitlesPage;
    }
    currentPage?.appendChild(child);
  }
  logoutPage.append(node('h2', undefined, 'Log out'), node('p', undefined, 'Sign out of NightOwl on this device. You will need your username and password to sign in again.'));
  const logoutButton = node('button', 'central-more', 'Log out') as HTMLButtonElement;
  logoutButton.onclick = () => {
    logoutButton.disabled = true;
    void (async () => {
      try { await api('/auth/logout', {}); } catch { /* Clear this browser session even if the server cannot be reached. */ }
      localStorage.removeItem('streamcinema.config');
      location.reload();
    })();
  };
  logoutPage.appendChild(logoutButton);
  databasePage.append(node('h2', undefined, 'Database information'), node('p', 'central-db-note', 'Active stream and episode totals in the NightOwl catalog.'));
  const databaseCounts = node('div', 'central-db-counts');
  const databaseRefresh = node('button', 'central-more central-db-refresh', 'Refresh catalog') as HTMLButtonElement;
  const databaseRefreshStatus = node('p', 'central-db-note', 'Loading catalog information…');
  databasePage.append(databaseCounts, databaseRefresh, databaseRefreshStatus);
  const updateDatabaseSummary = async (): Promise<void> => {
    const data = await api<DatabaseSummary>('/database/summary');
    if (view !== 'settings' || activeSettingsPage !== 'database-information') return;
    clear(databaseCounts);
    const values: Array<[string, number]> = [['Movie streams', data.counts.movies], ['Series streams', data.counts.series],
      ['Live TV streams', data.counts.liveTv], ['Episodes', data.counts.episodes]];
    for (const [label, value] of values) {
      const tile = node('div', 'central-db-count'); tile.append(node('strong', '', value.toLocaleString()), node('span', '', label)); databaseCounts.appendChild(tile);
    }
    const refreshState = data.refresh;
    const progress = refreshState.total ? ` (${refreshState.processed.toLocaleString()} / ${refreshState.total.toLocaleString()})` : '';
    databaseRefreshStatus.textContent = refreshState.status === 'running' ? `${refreshState.phase}${progress}. NightOwl compares playlist stream IDs and imports only missing entries.`
      : refreshState.status === 'success' || refreshState.status === 'error' ? `${refreshState.message || (refreshState.status === 'success' ? 'Refresh complete.' : 'Refresh failed.')}${refreshState.finishedAt ? ` · ${new Date(refreshState.finishedAt).toLocaleString()}` : ''}`
        : `Refresh scans the provider’s full lists and series details, then adds provider IDs not already in the database.${data.lastRefreshed ? ` Most recently imported stream: ${new Date(data.lastRefreshed).toLocaleString()}.` : ''}`;
    databaseRefresh.disabled = refreshState.status === 'running'; databaseRefresh.textContent = refreshState.status === 'running' ? 'Refreshing…' : 'Refresh catalog';
    if (refreshState.status === 'running') window.setTimeout(() => { void updateDatabaseSummary().catch((error) => { databaseRefreshStatus.textContent = errorMessage(error); }); }, 2000);
  };
  databaseRefresh.onclick = () => {
    databaseRefresh.disabled = true; databaseRefreshStatus.textContent = 'Starting provider catalog check…';
    void api('/provider/sync', {}).then(() => updateDatabaseSummary())
      .catch((error) => { databaseRefreshStatus.textContent = errorMessage(error); databaseRefresh.disabled = false; });
  };
  type CategorySettingsUi = { page: HTMLElement; section: 'live' | 'movies' | 'series'; filter: HTMLSelectElement; actions: HTMLButtonElement[]; grid: HTMLElement; status: HTMLElement; categories: BrowseCategory[]; hidden: Set<string>; storageKey: string };
  const categorySettingsUis: CategorySettingsUi[] = [];
  const buildCategorySettings = (pageElement: HTMLElement, section: 'live' | 'movies' | 'series', hidden: Set<string>, storageKey: string): CategorySettingsUi => {
    const label = section === 'live' ? 'Live TV' : section === 'movies' ? 'movie' : 'show';
    const description = node('p', 'central-settings-description', `Choose which provider categories appear in ${label}. Hidden categories are omitted from the ${section === 'live' ? 'channel' : label} category shelves.`);
    const filterLabel = node('label', 'central-settings-category-language');
    filterLabel.appendChild(node('span', undefined, 'Language'));
    const filter = node('select', 'central-category-select') as HTMLSelectElement;
    filter.setAttribute('aria-label', 'Filter categories by language');
    filter.appendChild(new Option('All languages', ''));
    filterLabel.appendChild(filter);
    const actionsWrap = node('div', 'central-settings-category-actions');
    const showAll = node('button', 'central-more', 'Show all') as HTMLButtonElement; showAll.type = 'button';
    const hideAll = node('button', 'central-more', 'Hide all') as HTMLButtonElement; hideAll.type = 'button';
    actionsWrap.append(showAll, hideAll);
    const grid = node('div', 'central-settings-live-category-grid central-settings-category-grid');
    const statusText = node('p', 'provider-message', `Loading ${label} categories…`);
    pageElement.append(description, filterLabel, actionsWrap, statusText, grid);
    const ui: CategorySettingsUi = { page: pageElement, section, filter, actions: [showAll, hideAll], grid, status: statusText, categories: [], hidden, storageKey };
    categorySettingsUis.push(ui);
    const persist = (): void => {
      localStorage.setItem(storageKey, JSON.stringify([...hidden]));
      if (selectedCategoryBySection[section] && hidden.has(selectedCategoryBySection[section])) selectedCategoryBySection[section] = '';
      if (section === 'movies' || section === 'series') cachedViews.delete(section);
    };
    const matchingCategories = (): BrowseCategory[] => ui.categories.filter((category) => !filter.value || liveCategoryCode(category.name) === filter.value);
    const render = (): void => {
      const categories = matchingCategories(); clear(grid);
      categories.forEach((category) => {
        const option = node('label', 'central-settings-live-category-option');
        const checkbox = node('input') as HTMLInputElement; checkbox.type = 'checkbox'; checkbox.checked = !hidden.has(category.id);
        checkbox.onchange = () => {
          if (checkbox.checked) hidden.delete(category.id); else hidden.add(category.id);
          persist();
        };
        option.append(checkbox, document.createTextNode(category.name)); grid.appendChild(option);
      });
      statusText.textContent = categories.length ? `${categories.length} categories shown in this language filter.` : 'No categories match this language filter.';
    };
    filter.onchange = render;
    showAll.onclick = () => { matchingCategories().forEach((item) => hidden.delete(item.id)); persist(); render(); };
    hideAll.onclick = () => { matchingCategories().forEach((item) => hidden.add(item.id)); persist(); render(); };
    void api<{ items: BrowseCategory[] }>(`/${section}/categories?language=${encodeURIComponent(appLanguage)}`).then((result) => {
      ui.categories = result.items;
      [...new Set(ui.categories.map((item) => liveCategoryCode(item.name)))].sort((a, b) => a === 'other' ? 1 : b === 'other' ? -1 : a.localeCompare(b))
        .forEach((code) => filter.appendChild(new Option(code === 'other' ? 'Other' : code, code)));
      render();
    }).catch((error) => { statusText.textContent = errorMessage(error); });
    return ui;
  };
  buildCategorySettings(liveCategoriesPage, 'live', hiddenLiveCategoryIds, 'streamcinema.hidden-live-categories');
  buildCategorySettings(movieCategoriesPage, 'movies', hiddenMovieCategoryIds, 'streamcinema.hidden-movie-categories');
  buildCategorySettings(seriesCategoriesPage, 'series', hiddenSeriesCategoryIds, 'streamcinema.hidden-series-categories');
  selectSettingsPage(activeSettingsPage);
  layout.append(sidebar, pageHost); panel.appendChild(layout); content.appendChild(panel);
  layout.addEventListener('keydown', (event) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const categoryGrid = active.closest<HTMLElement>('.central-settings-category-grid');
    if (categoryGrid && active instanceof HTMLInputElement && active.type === 'checkbox') {
      const ui = categorySettingsUis.find((entry) => entry.grid === categoryGrid);
      if (!ui) return;
      const currentRect = active.getBoundingClientRect();
      const currentX = currentRect.left + currentRect.width / 2, currentY = currentRect.top + currentRect.height / 2;
      const direction = event.key;
      const choices = Array.from(categoryGrid.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter((input) => input !== active && input.offsetParent !== null)
        .map((input) => {
          const rect = input.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          const primary = direction === 'ArrowLeft' ? currentX - x : direction === 'ArrowRight' ? x - currentX : direction === 'ArrowUp' ? currentY - y : y - currentY;
          const cross = direction === 'ArrowLeft' || direction === 'ArrowRight' ? Math.abs(y - currentY) : Math.abs(x - currentX);
          return { input, primary, cross, score: primary + cross * 2.5 };
        }).filter((entry) => entry.primary > 2).sort((a, b) => a.score - b.score);
      const next = choices[0]?.input;
      event.preventDefault(); event.stopPropagation();
      if (next) { next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
      else if (direction === 'ArrowUp') { ui.actions[0].focus(); ui.actions[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      return;
    }
    const activeUi = categorySettingsUis.find((ui) => ui.actions.includes(active as HTMLButtonElement));
    if (activeUi) {
      const actions = activeUi.actions;
      const index = actions.indexOf(active as HTMLButtonElement);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const next = actions[index + (event.key === 'ArrowRight' ? 1 : -1)];
        if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation(); activeUi.filter.focus(); activeUi.filter.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return;
      }
      if (event.key === 'ArrowDown') {
        const firstCategory = activeUi.grid.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (firstCategory) { event.preventDefault(); event.stopPropagation(); firstCategory.focus(); firstCategory.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        return;
      }
    }
    const activeCategoryUi = categorySettingsUis.find((ui) => ui.filter === active);
    if (activeCategoryUi && event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation(); activeCategoryUi.actions[0].focus(); activeCategoryUi.actions[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return;
    }
    if (active.closest('.central-settings-sidebar')) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const navItems = Array.from(sidebar.querySelectorAll<HTMLButtonElement>('.central-settings-nav-item'));
        const index = navItems.indexOf(active as HTMLButtonElement);
        const next = navItems[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); }
      } else if (event.key === 'ArrowRight') {
        const first = pageById.get(activeSettingsPage)?.querySelector<HTMLElement>('input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]');
        if (first) { event.preventDefault(); event.stopPropagation(); first.focus(); first.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation(); navById.get(activeSettingsPage)?.focus();
    }
  });
  panel.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.disabled) return;
    const isOk = event.key === 'Enter' || event.key === 'OK' || event.keyCode === 13 || event.keyCode === 23;
    const isUp = event.key === 'ArrowUp';
    const isDown = event.key === 'ArrowDown';
    if (!isOk && !isUp && !isDown) return;
    const focusables = Array.from(pageById.get(activeSettingsPage)?.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') ?? [])
      .filter((element) => element.offsetParent !== null);
    const currentIndex = focusables.indexOf(target);
    if (currentIndex < 0) return;
    if (target.type === 'checkbox' && isOk) {
      event.preventDefault(); event.stopPropagation(); target.click(); return;
    }
    if (isOk || isDown) {
      const next = focusables[currentIndex + 1];
      if (!next) return;
      event.preventDefault(); event.stopPropagation(); next.focus(); next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (isUp) {
      const previous = focusables[currentIndex - 1];
      if (!previous) return;
      event.preventDefault(); event.stopPropagation(); previous.focus(); previous.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  try {
    const tmdb = await api<{ configured: boolean }>('/tmdb/status');
    tmdbStatus.textContent = tmdb.configured ? 'TMDB is configured. Home rows are matched to titles in your IPTV catalog.' : 'TMDB is not configured. Home is showing recently added titles only.';
  } catch (error) { tmdbStatus.textContent = errorMessage(error); }
  try {
    const subtitles = await api<{ configured: boolean }>('/opensubtitles/status');
    openSubtitlesStatus.textContent = subtitles.configured ? 'OpenSubtitles is configured.' : 'OpenSubtitles is not configured. Add your API key to search for subtitles.';
  } catch (error) { openSubtitlesStatus.textContent = errorMessage(error); }
  try {
    const data = await api<{ source?: string; datasets: Array<{ dataset: string; status: string; rowCount?: number; lastSuccessAt?: string }> }>('/sync/status');
    sync.textContent = data.source === 'normalized_database'
      ? `Catalog is loaded from PostgreSQL: ${data.datasets.map((entry) => `${entry.dataset} ${entry.rowCount ?? 0}`).join(' · ')}. View counts and refresh it from Database.`
      : data.datasets.map((entry) => `${entry.dataset}: ${entry.status}${entry.lastSuccessAt ? ` · ${new Date(entry.lastSuccessAt).toLocaleString()}` : ''}`).join('  |  ') || 'No server sync status is available.';
  } catch (error) { sync.textContent = errorMessage(error); }
}
async function connect(next: Config): Promise<void> {
  invalidateCatalogCache();
  config = next;
  await api('/health');
  const languageData = await api<{ items: AppLanguage[] }>('/languages');
  availableLanguages = languageData.items.filter((language) => language.code !== 'und' && language.name.toLowerCase() !== 'unlabelled');
  localStorage.removeItem('streamcinema.language');
  subtitleSearchLanguages = subtitleSearchLanguages.filter((code) => availableLanguages.some((language) => language.code === code));
  if (!subtitleSearchLanguages.length) subtitleSearchLanguages = [availableLanguages.some(({ code }) => code === 'en') ? 'en' : availableLanguages[0]?.code || 'en'];
  localStorage.setItem('streamcinema.subtitle-languages', JSON.stringify(subtitleSearchLanguages));
  const result = await api<{ items: Profile[] }>('/profiles');
  profiles = result.items;
  if (!profiles.length) { const first = await api<Profile>('/profiles', { name: 'Default' }); profiles = [first]; }
  profile = profiles.find((entry) => entry.id === localStorage.getItem('streamcinema.profile')) ?? profiles[0];
  localStorage.setItem('streamcinema.profile', profile.id);
  renderProfileButton();
  localStorage.setItem('streamcinema.config', JSON.stringify(next));
  setup.classList.add('hidden'); app.classList.remove('hidden'); navigate('home');
  window.setTimeout(() => { void preloadBrowseScreens(); }, 0);
}

el<HTMLFormElement>('central-form').onsubmit = (event) => {
  event.preventDefault();
  const username = el<HTMLInputElement>('central-username').value.trim();
  const password = el<HTMLInputElement>('central-password').value;
  const button = document.querySelector<HTMLButtonElement>('#central-form button[type="submit"]');
  if (button) button.disabled = true;
  el('central-setup-error').textContent = 'Signing in…';
  void (async () => {
    try {
      const session = await loginWithAccount(username, password);
      await connect(session);
      el<HTMLInputElement>('central-username').value = '';
      el<HTMLInputElement>('central-password').value = '';
    } catch (error) {
      el('central-setup-error').textContent = errorMessage(error);
    }
    finally { if (button) button.disabled = false; }
  })();
};
document.querySelectorAll<HTMLButtonElement>('#central-app [data-view]').forEach((button) => {
  button.onclick = () => navigate(button.dataset.view as View);
});
profileButton.onclick = () => navigate('profiles');
el<HTMLButtonElement>('central-player-back').onclick = () => closePlayer();
el<HTMLButtonElement>('central-play-pause').onclick = () => { if (video.paused) void video.play(); else video.pause(); };
el<HTMLButtonElement>('central-rewind').onclick = () => { seekBy(-10); revealPlayerControls(); };
el<HTMLButtonElement>('central-forward').onclick = () => { seekBy(10); revealPlayerControls(); };
function seekTo(seconds: number): void {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  try { video.currentTime = Math.max(0, Math.min(video.duration, seconds)); updatePlaybackProgress(); } catch { /* Some live streams do not expose a seekable range. */ }
}
function seekBy(seconds: number): void { seekTo(video.currentTime + seconds); }
const seekTrack = el<HTMLInputElement>('central-player-track');
function updatePlayerOptionVisibility(): void {
  const live = playingItem?.kind === 'live';
  player.classList.toggle('live-playback', live);
  el('central-audio').classList.toggle('hidden', live);
  el('central-subtitle').classList.toggle('hidden', live);
  if (centralFullscreenButton.isConnected) centralFullscreenButton.classList.remove('hidden');
}
seekTrack.addEventListener('input', () => {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  seekTo((Number(seekTrack.value) / Number(seekTrack.max)) * video.duration);
  revealPlayerControls();
});
function showStreamLanguageMenu(): void {
  if (!playingItem) return;
  const options = el('central-player-stream-options'); clear(options);
  const heading = el('central-player-stream-menu').querySelector<HTMLElement>('.central-player-stream-menu-heading strong');
  if (heading) heading.textContent = 'Available languages';
  let optionCount = 0;
  const streams = playingItem.streams ?? [];
  const available = streams.filter((stream, index, all) => all.findIndex((candidate) =>
    (candidate.providerId || candidate.id) === (stream.providerId || stream.id)) === index);
  const languageCounts = new Map<string, number>();
  for (const stream of available) {
    const language = stream.language?.trim() || stream.languageCode?.toUpperCase() || 'Unlabelled';
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languageIndices = new Map<string, number>();
  if (available.length) {
    options.appendChild(node('h3', 'central-player-stream-group', 'Stream versions'));
    for (const stream of available) {
      const id = stream.providerId || stream.id;
      const currentId = playingItem.streamId || playingItem.id;
      const language = stream.language?.trim() || stream.languageCode?.toUpperCase() || 'Unlabelled';
      const languageIndex = (languageIndices.get(language) ?? 0) + 1; languageIndices.set(language, languageIndex);
      const version = (languageCounts.get(language) ?? 0) > 1 ? ` · Version ${languageIndex}` : '';
      const button = node('button', 'central-player-stream-option', `${language}${version}${stream.extension ? ` · ${stream.extension.toUpperCase()}` : ''}${id === currentId ? ' · Playing' : ''}`) as HTMLButtonElement;
      button.setAttribute('aria-current', id === currentId ? 'true' : 'false');
      button.onclick = () => {
        if (!playingItem || id === (playingItem.streamId || playingItem.id)) { el('central-player-stream-menu').classList.add('hidden'); return; }
        const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const nextItem = { ...playingItem, id, streamId: id };
        el('central-player-stream-menu').classList.add('hidden');
        video.pause();
        void play(nextItem, activeLiveFormat, resumeAt);
      };
      options.appendChild(button); optionCount++;
    }
  }
  const audioTracks = (video as HTMLVideoElement & { audioTracks?: { length: number; [index: number]: { enabled: boolean; label?: string; language?: string } } }).audioTracks;
  if (audioTracks?.length) {
    options.appendChild(node('h3', 'central-player-stream-group', 'Audio tracks in this stream'));
    for (let index = 0; index < audioTracks.length; index++) {
      const track = audioTracks[index];
      const trackName = track.label?.trim() || track.language?.trim()?.toUpperCase() || `Audio track ${index + 1}`;
      const button = node('button', 'central-player-stream-option', `${trackName}${track.enabled ? ' · Playing' : ''}`) as HTMLButtonElement;
      button.setAttribute('aria-current', track.enabled ? 'true' : 'false');
      button.onclick = () => {
        for (let trackIndex = 0; trackIndex < audioTracks.length; trackIndex++) audioTracks[trackIndex].enabled = trackIndex === index;
        playerStatus.textContent = `Audio track: ${trackName}`;
        el('central-player-stream-menu').classList.add('hidden'); el<HTMLButtonElement>('central-audio').focus(); revealPlayerControls();
      };
      options.appendChild(button); optionCount++;
    }
  }
  if (!optionCount) options.appendChild(node('p', undefined, 'No alternate stream languages or embedded audio tracks are available.'));
  const menu = el('central-player-stream-menu');
  menu.classList.remove('hidden'); revealPlayerControls();
  menu.querySelector<HTMLButtonElement>('.central-player-stream-option')?.focus() ?? el<HTMLButtonElement>('central-player-stream-close').focus();
}
el<HTMLButtonElement>('central-audio').onclick = showStreamLanguageMenu;
el<HTMLButtonElement>('central-player-stream-close').onclick = () => { el('central-player-stream-menu').classList.add('hidden'); el<HTMLButtonElement>('central-audio').focus(); revealPlayerControls(); };
centralFullscreenButton.onclick = () => {
  const playerWithWebkit = player as HTMLElement & { webkitRequestFullscreen?: () => void };
  const videoWithWebkit = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  const documentWithWebkit = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
  const fullscreenActive = document.fullscreenElement === player || documentWithWebkit.webkitFullscreenElement === player;
  if (fullscreenActive) {
    if (document.exitFullscreen) void document.exitFullscreen().catch(() => { playerStatus.textContent = 'Could not exit fullscreen.'; });
    else documentWithWebkit.webkitExitFullscreen?.();
  }
  else if (player.requestFullscreen) void player.requestFullscreen().catch(() => { playerStatus.textContent = 'Fullscreen is unavailable in this browser.'; });
  else if (playerWithWebkit.webkitRequestFullscreen) playerWithWebkit.webkitRequestFullscreen();
  else if (videoWithWebkit.webkitEnterFullscreen) videoWithWebkit.webkitEnterFullscreen();
  else playerStatus.textContent = 'Fullscreen is unavailable in this browser.';
  revealPlayerControls();
};
function clearExternalSubtitle(): void {
  externalSubtitleTrack?.remove(); externalSubtitleTrack = null;
  if (externalSubtitleBlobUrl) URL.revokeObjectURL(externalSubtitleBlobUrl);
  externalSubtitleBlobUrl = '';
}
function selectSubtitleTrack(selected: TextTrack | null, label: string): void {
  const tracks = video.textTracks;
  for (let index = 0; index < tracks.length; index++) tracks[index].mode = tracks[index] === selected ? 'showing' : 'disabled';
  subtitlesIndex = selected ? Array.from({ length: tracks.length }, (_, index) => tracks[index]).indexOf(selected) : tracks.length;
  playerStatus.textContent = selected ? `Subtitles: ${label}` : 'Subtitles off';
  el('central-player-stream-menu').classList.add('hidden'); revealPlayerControls();
}
function attachExternalSubtitle(vtt: string, label: string, language: string): void {
  clearExternalSubtitle();
  for (let index = 0; index < video.textTracks.length; index++) video.textTracks[index].mode = 'disabled';
  const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
  externalSubtitleBlobUrl = URL.createObjectURL(blob);
  const track = node('track') as HTMLTrackElement;
  track.kind = 'subtitles'; track.label = label;
  track.srclang = ({ eng: 'en', pol: 'pl', nld: 'nl', dut: 'nl' } as Record<string, string>)[language] ?? language;
  track.src = externalSubtitleBlobUrl; track.default = true;
  track.addEventListener('load', () => { track.track.mode = 'showing'; });
  video.appendChild(track); externalSubtitleTrack = track;
  window.setTimeout(() => { try { track.track.mode = 'showing'; } catch { /* Track may not have loaded yet. */ } }, 100);
  subtitlesIndex = 0; playerStatus.textContent = `Subtitles: ${label}`;
  el('central-player-stream-menu').classList.add('hidden'); revealPlayerControls();
}
function showSubtitleMenu(): void {
  if (!playingItem) return;
  const menu = el('central-player-stream-menu');
  const heading = menu.querySelector<HTMLElement>('.central-player-stream-menu-heading strong');
  if (heading) heading.textContent = 'Subtitles';
  const options = el('central-player-stream-options'); clear(options);
  const off = node('button', 'central-player-stream-option', 'Turn subtitles off') as HTMLButtonElement;
  off.onclick = () => selectSubtitleTrack(null, 'Off'); options.appendChild(off);
  const tracks = video.textTracks;
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    const label = track.label || track.language || `Subtitle track ${index + 1}`;
    const button = node('button', 'central-player-stream-option', `Embedded · ${label}${track.mode === 'showing' ? ' · Playing' : ''}`) as HTMLButtonElement;
    button.onclick = () => selectSubtitleTrack(track, label); options.appendChild(button);
  }
  options.appendChild(node('h3', 'central-player-stream-group', 'Search OpenSubtitles'));
  const form = node('form', 'central-subtitle-search') as HTMLFormElement;
  const language = node('select', 'central-category-select') as HTMLSelectElement;
  availableLanguages.filter(({ code }) => subtitleSearchLanguages.includes(code)).forEach(({ code, name }) => language.appendChild(new Option(name, code)));
  if (subtitleSearchLanguages.includes(appLanguage)) language.value = appLanguage;
  else if (subtitleSearchLanguages.length) language.value = subtitleSearchLanguages[0];
  const search = node('button', 'central-player-stream-option', 'Search subtitles') as HTMLButtonElement; search.type = 'submit';
  form.append(language, search); options.appendChild(form);
  const results = node('div', 'central-subtitle-results'); options.appendChild(results);
  form.onsubmit = (event) => {
    event.preventDefault(); search.disabled = true; search.textContent = 'Searching…'; clear(results);
    const sourceItem = playingItem;
    if (!sourceItem) return;
    const episode = sourceItem.kind === 'episode';
    const series = episode && currentItem?.kind === 'series' ? currentItem : null;
    const rawTitle = series?.title ?? sourceItem.title;
    const query = rawTitle.replace(/^\s*(?:[A-Z]{2,5}|NF|MULTI)\s*[-|:]\s*/i, '')
      .replace(/\s*\((?:\d{4}|MULTI SUB|[A-Z]{2,8} SUB)\).*$/i, '').replace(/\s+\d{4}\s*$/, '').trim();
    if (query.length < 3) {
      results.appendChild(node('p', undefined, 'OpenSubtitles needs at least three characters to search this title.'));
      search.disabled = false; search.textContent = 'Search subtitles'; return;
    }
    const preferredSubtitleLanguage = subtitleSearchLanguages.find((code) => availableLanguages.some((entry) => entry.code === code));
    const subtitleLanguage = availableLanguages.some((entry) => entry.code === language.value)
      ? language.value : preferredSubtitleLanguage ?? availableLanguages.find((entry) => entry.code === appLanguage)?.code ?? '';
    const rawTmdbId = series?.metadata?.tmdbId ?? sourceItem.metadata?.tmdbId;
    const tmdbId = rawTmdbId !== undefined && /^\d+$/.test(String(rawTmdbId)) ? String(rawTmdbId) : undefined;
    const seasonNumber = episode ? Number(sourceItem.seasonNumber) : undefined;
    const episodeNumber = episode ? Number(sourceItem.episodeNumber) : undefined;
    void api<{ items: Array<{ fileId:number; language:string; release:string; fileName:string; downloadCount:number; hearingImpaired:boolean }> }>('/opensubtitles/search', {
      kind: episode ? 'episode' : 'movie', id: sourceItem.streamId || sourceItem.id, query, language: subtitleLanguage,
      tmdbId,
      seasonNumber: Number.isInteger(seasonNumber) && seasonNumber! >= 0 && seasonNumber! <= 100 ? seasonNumber : undefined,
      episodeNumber: Number.isInteger(episodeNumber) && episodeNumber! >= 0 && episodeNumber! <= 5000 ? episodeNumber : undefined,
    }).then(({items}) => {
      if (!items.length) results.appendChild(node('p', undefined, 'No matching subtitles found.'));
      const orderedItems = [...items].sort((a, b) => preferHearingImpairedSubtitles
        ? Number(b.hearingImpaired) - Number(a.hearingImpaired) : Number(a.hearingImpaired) - Number(b.hearingImpaired));
      for (const subtitle of orderedItems) {
        const button = node('button', 'central-player-stream-option', `${subtitle.language} · ${subtitle.release}${subtitle.hearingImpaired ? ' · SDH' : ''} · ${subtitle.downloadCount} downloads`) as HTMLButtonElement;
        button.title = subtitle.fileName;
        button.onclick = () => {
          button.disabled = true; button.textContent = 'Downloading…';
          void api<{vtt:string}>('/opensubtitles/download',{fileId:subtitle.fileId})
            .then(({vtt}) => attachExternalSubtitle(vtt, subtitle.language, language.value))
            .catch((error) => { button.disabled = false; button.textContent = subtitle.release; setStatus(errorMessage(error)); });
        };
        results.appendChild(button);
      }
    }).catch((error) => { results.appendChild(node('p', undefined, errorMessage(error))); })
      .then(() => { search.disabled = false; search.textContent = 'Search subtitles'; }, () => { search.disabled = false; search.textContent = 'Search subtitles'; });
  };
  menu.classList.remove('hidden'); revealPlayerControls(); off.focus();
}
el<HTMLButtonElement>('central-subtitle').onclick = showSubtitleMenu;
video.ontimeupdate = () => {
  updatePlaybackProgress();
  if (Date.now() - lastProgressSave >= 15_000 && playingItem) { lastProgressSave = Date.now(); void saveProgress(); }
};
video.textTracks.addEventListener('addtrack', updatePlayerOptionVisibility);
video.onended = () => { void saveProgress(true); closePlayer(false); };
video.onerror = () => {
  if (playingItem?.kind === 'live' && activeLiveFormat === 'm3u8') { const item = playingItem; playingItem = null; void play(item, 'ts'); return; }
  if (playingItem && activeRemuxMode === 'copy' && !remuxTranscodeAttempted && (video.error?.code === MediaError.MEDIA_ERR_DECODE || video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)) {
    const item = playingItem; const resumeAt = Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : undefined;
    remuxTranscodeAttempted = true; playerStatus.textContent = 'Trying compatibility conversion…';
    void play(item, activeLiveFormat, resumeAt, undefined, true); return;
  }
  if (playingItem) { playerStatus.textContent = 'This stream could not play. Check the stream format or TV codec support.'; revealPlayerControls(); }
};
video.onwaiting = () => { playerStatus.textContent = 'Buffering…'; revealPlayerControls(); };
video.onplaying = () => { playerStatus.textContent = ''; updatePlayerOptionVisibility(); revealPlayerControls(); };
video.onclick = () => {
  if (player.classList.contains('controls-hidden')) revealPlayerControls();
  else if (video.paused) void video.play(); else video.pause();
};
function setPlayPauseIcon(isPaused: boolean): void {
  const button = el<HTMLButtonElement>('central-play-pause');
  button.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
  button.innerHTML = isPaused
    ? '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m11 6 15 10-15 10z"/></svg>'
    : '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M11 7v18M21 7v18"/></svg>';
}
let webosHomeBackPresses = 0;
let webosHomeBackResetTimer = 0;
let webosBackHintTimer = 0;
let webosExitPrompt: HTMLElement | null = null;
function resetWebosHomeBackSequence(): void {
  webosHomeBackPresses = 0;
  window.clearTimeout(webosHomeBackResetTimer);
  window.clearTimeout(webosBackHintTimer);
  document.getElementById('central-back-hint')?.remove();
}
function closeWebosExitPrompt(): void {
  webosExitPrompt?.remove();
  webosExitPrompt = null;
  document.removeEventListener('focusin', trapWebosExitPromptFocus, true);
  resetWebosHomeBackSequence();
  document.querySelector<HTMLButtonElement>('#central-nav [data-view="home"]')?.focus();
}
function openWebosExitPrompt(): void {
  resetWebosHomeBackSequence();
  const backdrop = node('section', 'webos-exit-backdrop');
  backdrop.setAttribute('role', 'alertdialog'); backdrop.setAttribute('aria-modal', 'true');
  const dialog = node('div', 'webos-exit-dialog');
  const heading = node('h2', undefined, 'Exit NightOwl?');
  const message = node('p', undefined, 'Your sign-in and viewing data will remain on this TV.');
  const actions = node('div', 'webos-exit-actions');
  const stay = node('button', 'webos-exit-stay', 'Stay') as HTMLButtonElement;
  const exit = node('button', 'webos-exit-confirm', 'Exit app') as HTMLButtonElement;
  stay.type = 'button'; exit.type = 'button';
  stay.onclick = closeWebosExitPrompt;
  exit.onclick = () => window.close();
  actions.append(stay, exit); dialog.append(heading, message, actions); backdrop.appendChild(dialog);
  document.body.appendChild(backdrop); webosExitPrompt = backdrop; stay.focus();
  document.addEventListener('focusin', trapWebosExitPromptFocus, true);
}
function trapWebosExitPromptFocus(event: FocusEvent): void {
  if (!webosExitPrompt) return;
  const stay = webosExitPrompt.querySelector<HTMLButtonElement>('.webos-exit-stay');
  const exit = webosExitPrompt.querySelector<HTMLButtonElement>('.webos-exit-confirm');
  if (!stay || !exit || event.target === stay || event.target === exit) return;
  stay.focus();
}
function handleWebosHomeBackPress(): boolean {
  if (!document.body.classList.contains('webos-client') || view !== 'home'
    || !player.classList.contains('hidden') || app.classList.contains('hidden')) return false;
  webosHomeBackPresses += 1;
  window.clearTimeout(webosHomeBackResetTimer);
  if (webosHomeBackPresses >= 2) { openWebosExitPrompt(); return true; }
  let hint = document.getElementById('central-back-hint');
  if (!hint) { hint = node('div', 'webos-back-hint'); hint.id = 'central-back-hint'; document.body.appendChild(hint); }
  hint.textContent = 'Press Back once more to exit.';
  window.clearTimeout(webosBackHintTimer);
  webosBackHintTimer = window.setTimeout(() => { document.getElementById('central-back-hint')?.remove(); }, 1800);
  webosHomeBackResetTimer = window.setTimeout(resetWebosHomeBackSequence, 3500);
  return true;
}
video.onpause = () => { setPlayPauseIcon(true); revealPlayerControls(); };
video.onplay = () => { setPlayPauseIcon(false); revealPlayerControls(); };
player.addEventListener('pointermove', () => { if (!player.classList.contains('hidden')) revealPlayerControls(); });

document.addEventListener('keydown', (event) => {
  let active = document.activeElement as HTMLElement | null;
  const key = event.keyCode;
  const isBack = [461, 10009, 8, 27].includes(key) || ['Escape', 'BrowserBack'].includes(event.key);
  if (webosExitPrompt) {
    event.preventDefault(); event.stopImmediatePropagation();
    const stay = webosExitPrompt.querySelector<HTMLButtonElement>('.webos-exit-stay');
    const exit = webosExitPrompt.querySelector<HTMLButtonElement>('.webos-exit-confirm');
    if (!stay || !exit) return;
    if (isBack) { closeWebosExitPrompt(); return; }
    if (!webosExitPrompt.contains(document.activeElement)) stay.focus();
    else if (key === 37 || key === 39) (document.activeElement === stay ? exit : stay).focus();
    else if (key === 13 || key === 23 || key === 32) (document.activeElement === exit ? exit : stay).click();
    return;
  }
  if (activeCategoryJumpMenu?.panel.classList.contains('open') && isBack) {
    event.preventDefault(); event.stopPropagation(); activeCategoryJumpMenu.close(); return;
  }
  if ((active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') && key === 8) return;
  const seekInputActive = active?.id === 'central-player-track';
  if ((active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') && !isBack && !seekInputActive) return;
  if (isBack) {
    event.preventDefault();
    if (webosExitPrompt) { closeWebosExitPrompt(); return; }
    if (!player.classList.contains('hidden') && !el('central-player-stream-menu').classList.contains('hidden')) {
      el('central-player-stream-menu').classList.add('hidden'); el<HTMLButtonElement>('central-audio').focus();
    }
    else if (!player.classList.contains('hidden')) closePlayer();
    else if (view === 'detail') backFromDetail();
    else if (view !== 'home') navigate('home');
    else if (!handleWebosHomeBackPress()) document.querySelector<HTMLButtonElement>('#central-nav [data-view="home"]')?.focus();
    return;
  }
  if (key === 23 && active?.tagName === 'BUTTON') { event.preventDefault(); active.click(); return; }
  const playerOpen = !player.classList.contains('hidden');
  if (!playerOpen && key === 37 && activeCategoryJumpMenu?.section === view && active?.closest('.central-card')) {
    const cardButton = active.closest<HTMLButtonElement>('.central-card');
    const liveGrid = cardButton?.closest<HTMLElement>('.central-live-grid');
    const shelf = cardButton?.closest<HTMLElement>('.central-cards');
    const cards = liveGrid ? Array.from(liveGrid.querySelectorAll<HTMLButtonElement>('.central-card'))
      : shelf ? Array.from(shelf.querySelectorAll<HTMLButtonElement>('.central-card')) : [];
    const index = cardButton ? cards.indexOf(cardButton) : -1;
    const isLeftEdge = liveGrid ? index >= 0 && index % 6 === 0 : index === 0;
    if (isLeftEdge) { event.preventDefault(); event.stopPropagation(); activeCategoryJumpMenu.open(); return; }
  }
  if (!playerOpen && document.body.classList.contains('webos-client') && (key === 37 || key === 39)) {
    const liveGrid = active?.closest<HTMLElement>('.central-live-grid');
    const channelCard = active?.closest<HTMLButtonElement>('.central-live-grid .central-card[data-card-key]');
    if (liveGrid && channelCard) {
      const cards = Array.from(liveGrid.querySelectorAll<HTMLButtonElement>('.central-card[data-card-key]'));
      const index = cards.indexOf(channelCard);
      const columnCount = 6;
      const nextIndex = index + (key === 39 ? 1 : -1);
      const next = cards[nextIndex];
      const staysInSameRow = next && Math.floor(index / columnCount) === Math.floor(nextIndex / columnCount);
      event.preventDefault(); event.stopPropagation();
      if (next && staysInSameRow) focusShelfItem(liveGrid, next);
      return;
    }
  }
  if (!playerOpen && document.body.classList.contains('webos-client') && (key === 37 || key === 39)) {
    const list = active?.closest<HTMLElement>('.central-cards');
    const focusedCard = active?.closest<HTMLButtonElement>('.central-card[data-card-key]');
    if (list && focusedCard) {
      const cards = Array.from(list.querySelectorAll<HTMLButtonElement>('.central-card[data-card-key]'));
      const index = cards.indexOf(focusedCard);
      const next = cards[index + (key === 39 ? 1 : -1)];
      event.preventDefault(); event.stopPropagation();
      if (next) {
        focusShelfItem(list, next);
        if (key === 39 && cards.length - index <= 4) void shelfPageLoaders.get(list)?.();
      } else if (key === 39) {
        const loadNext = shelfPageLoaders.get(list);
        if (loadNext) void loadNext().then(() => {
          const firstNewCard = list.querySelectorAll<HTMLButtonElement>('.central-card[data-card-key]')[index + 1];
          if (firstNewCard) focusShelfItem(list, firstNewCard);
        });
      } else if (list.scrollLeft > 0) list.scrollLeft = 0;
      return;
    }
  }
  if (playerOpen) {
    const controlsWereHidden = player.classList.contains('controls-hidden');
    revealPlayerControls();
    if (controlsWereHidden && [37, 38, 39, 40].includes(key)) {
      el<HTMLButtonElement>('central-play-pause').focus();
      active = document.activeElement as HTMLElement | null;
    }
    if (key === 415 || key === 19) { event.preventDefault(); if (video.paused) void video.play(); else video.pause(); }
    if (key === 412 || ['MediaRewind', 'Rewind'].includes(event.key) || event.code === 'MediaRewind') { event.preventDefault(); seekBy(-10); return; }
    if (key === 417 || ['MediaFastForward', 'FastForward'].includes(event.key) || event.code === 'MediaFastForward') { event.preventDefault(); seekBy(10); return; }
    if ([37, 38, 39, 40].includes(key)) {
      const menuOpen = !el('central-player-stream-menu').classList.contains('hidden');
      if (!menuOpen && active?.id === 'central-player-track' && (key === 37 || key === 39)) {
        event.preventDefault(); event.stopPropagation(); seekBy(key === 37 ? -10 : 10); return;
      }
      if (!menuOpen && active?.id === 'central-player-track' && key === 38) {
        event.preventDefault(); event.stopPropagation(); el<HTMLButtonElement>('central-player-back').focus(); return;
      }
      if (!menuOpen && active?.id === 'central-player-track' && key === 40) {
        event.preventDefault(); event.stopPropagation(); el<HTMLButtonElement>('central-play-pause').focus(); return;
      }
      if (!menuOpen && active?.id === 'central-player-back' && key === 40) {
        event.preventDefault(); event.stopPropagation(); seekTrack.focus(); return;
      }
      if (!menuOpen && active?.closest('.central-player-center-controls') && key === 38) {
        event.preventDefault(); event.stopPropagation(); seekTrack.focus(); return;
      }
    }
    if (![37, 38, 39, 40].includes(key)) return;
  }
  if (![37, 38, 39, 40].includes(key)) return;
  if (!playerOpen && key === 39 && active?.id === 'central-profile') {
    const searchTab = document.querySelector<HTMLButtonElement>('#central-nav [data-view="search"]');
    if (searchTab) { event.preventDefault(); event.stopPropagation(); searchTab.focus(); return; }
  }
  if (!playerOpen && key === 39 && active?.dataset.view === 'my-list') {
    const settingsButton = document.querySelector<HTMLButtonElement>('#central-settings-shortcut');
    if (settingsButton) { event.preventDefault(); event.stopPropagation(); settingsButton.focus(); return; }
  }
  if (!playerOpen && key === 37 && active?.id === 'central-settings-shortcut') {
    const myCinemaTab = document.querySelector<HTMLButtonElement>('#central-nav [data-view="my-list"]');
    if (myCinemaTab) { event.preventDefault(); event.stopPropagation(); myCinemaTab.focus(); return; }
  }
  if (!playerOpen && view === 'search' && key === 40 && active?.closest('#central-header')) {
    const searchInput = content.querySelector<HTMLInputElement>('.central-search-page input');
    if (searchInput) { event.preventDefault(); searchInput.focus(); searchInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
  }
  if (!playerOpen && view === 'search' && key === 38 && active?.closest('.central-search-results .central-card')) {
    const searchInput = content.querySelector<HTMLInputElement>('.central-search-page input');
    const resultCards = content.querySelectorAll<HTMLButtonElement>('.central-search-results .central-card');
    const firstCardTop = resultCards[0]?.getBoundingClientRect().top;
    const activeTop = active.getBoundingClientRect().top;
    if (searchInput && firstCardTop !== undefined && Math.abs(activeTop - firstCardTop) < 8) {
      event.preventDefault(); searchInput.focus(); searchInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return;
    }
  }
  if (!playerOpen && key === 38 && active?.closest('.central-hero')) {
    const activeTab = document.querySelector<HTMLButtonElement>(`#central-nav [data-view="${view}"]`);
    if (activeTab) { event.preventDefault(); activeTab.focus(); scrollWindowTo(0); return; }
  }
  if (!playerOpen && (key === 38 || key === 40)) {
    if (key === 40 && active?.dataset.moreCategories === 'true') { event.preventDefault(); return; }
    const activeRow = active?.closest<HTMLElement>('.central-row');
    const rows = Array.from(content.querySelectorAll<HTMLElement>('.central-row'));
    const rowIndex = activeRow ? rows.indexOf(activeRow) : -1;
    if (rowIndex >= 0) {
      if (document.body.classList.contains('webos-client') && key === 40 && rowIndex === rows.length - 1
        && !content.querySelector('[data-more-categories="true"]')) {
        event.preventDefault();
        const scrolling = document.scrollingElement ?? document.documentElement;
        const pageHeight = Math.max(scrolling.scrollHeight, document.body.scrollHeight, content.scrollHeight);
        scrollWindowTo(Math.max(0, pageHeight - window.innerHeight));
        return;
      }
      // Wrap from the bottom of the category list only after every category
      // has been appended. Before that, Up must always mean the previous row.
      const allCategoriesLoaded = !content.querySelector('[data-more-categories="true"]');
      if (key === 38 && allCategoriesLoaded && rowIndex === rows.length - 1 && activeRow?.dataset.categoryIndex !== undefined) {
        const firstCategory = content.querySelector<HTMLElement>('.central-category-shelves .central-row[data-category-index="0"], .central-category-shelves .central-category-spacer[data-category-index="0"]');
        if (firstCategory && firstCategory !== activeRow) {
          event.preventDefault();
          const focusFirst = (): void => {
            const firstCard = firstCategory.querySelector<HTMLButtonElement>('[data-card-key]');
            if (firstCard) focusShelfCard(firstCard, firstCategory);
            else if (firstCategory.classList.contains('central-category-spacer')) firstCategory.dispatchEvent(new Event('central-load-category-row'));
          };
            if (firstCategory.classList.contains('central-category-spacer')) firstCategory.dispatchEvent(new Event('central-load-category-row'));
            else focusFirst();
          return;
        }
      }
      if (key === 38 && rowIndex === 0) {
        const featuredAction = content.querySelector<HTMLButtonElement>('.central-hero-actions .primary');
        if (featuredAction) {
          event.preventDefault(); featuredAction.focus(); scrollWindowTo(0); return;
        }
        const activeTab = document.querySelector<HTMLButtonElement>(`#central-nav [data-view="${view}"]`);
        if (activeTab) { event.preventDefault(); activeTab.focus(); scrollWindowTo(0); return; }
      } else {
        if (key === 40 && rowIndex === rows.length - 1) {
          const moreCategories = content.querySelector<HTMLElement>('[data-more-categories="true"]');
          if (moreCategories) { event.preventDefault(); moreCategories.dispatchEvent(new Event('central-load-more-categories')); return; }
          const firstRow = rows[0];
          if (firstRow && firstRow !== activeRow) {
            event.preventDefault();
            if (firstRow.classList.contains('central-category-spacer')) {
              firstRow.dispatchEvent(new Event('central-load-category-row'));
            } else {
              const candidates = Array.from(firstRow.querySelectorAll<HTMLButtonElement>('[data-card-key]'));
              const currentRect = active?.getBoundingClientRect();
              const currentX = currentRect ? currentRect.left + currentRect.width / 2 : 0;
              const target = candidates.sort((a, b) => {
                const ax = a.getBoundingClientRect().left + a.getBoundingClientRect().width / 2;
                const bx = b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2;
                return Math.abs(ax - currentX) - Math.abs(bx - currentX);
              })[0];
              if (target) focusShelfCard(target, firstRow);
            }
            return;
          }
        }
        const nextIndex = key === 40 ? rowIndex + 1 : rowIndex - 1;
        const nextRow = rows[nextIndex];
        if (nextRow?.classList.contains('central-category-spacer')) {
          event.preventDefault();
          nextRow.dispatchEvent(new Event('central-load-category-row')); return;
        }
        const candidates = Array.from(rows[nextIndex]?.querySelectorAll<HTMLButtonElement>('[data-card-key]') ?? []);
        const currentRect = active?.getBoundingClientRect();
        const currentX = currentRect ? currentRect.left + currentRect.width / 2 : 0;
        const target = candidates.sort((a, b) => {
          const ax = a.getBoundingClientRect().left + a.getBoundingClientRect().width / 2;
          const bx = b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2;
          return Math.abs(ax - currentX) - Math.abs(bx - currentX);
        })[0];
        if (target) { event.preventDefault(); focusShelfCard(target, nextRow!); return; }
      }
    }
  }
  const current = active?.getBoundingClientRect();
  if (!current) return;
  const menuOpen = playerOpen && !el('central-player-stream-menu').classList.contains('hidden');
  const scope = menuOpen ? '#central-player-stream-menu' : playerOpen ? '#central-player' : '#central-app';
  const buttons = Array.from(document.querySelectorAll<HTMLElement>(`${scope} button:not([disabled]), ${scope} input:not([disabled]), ${scope} select:not(.webos-native-select):not([disabled]), ${scope} textarea:not([disabled]), ${scope} [role="slider"][tabindex="0"]`)).filter((button) => {
    if (button.offsetParent === null || button === active) return false;
    const style = getComputedStyle(button);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  });
  const cx = current.left + current.width / 2, cy = current.top + current.height / 2;
  let best: HTMLElement | null = null, score = Infinity;
  for (const button of buttons) {
    const rect = button.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const dx = x - cx, dy = y - cy;
    if ((key === 37 && dx >= -5) || (key === 39 && dx <= 5) || (key === 38 && dy >= -5) || (key === 40 && dy <= 5)) continue;
    const distance = (key === 37 || key === 39) ? Math.abs(dx) + Math.abs(dy) * 3 : Math.abs(dy) + Math.abs(dx) * 3;
    if (distance < score) { score = distance; best = button; }
  }
  if (best) { event.preventDefault(); best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  if (playerOpen) { event.preventDefault(); event.stopPropagation(); }
});

try {
  const localDemo = (location.hostname === '127.0.0.1' || location.hostname === 'localhost') && /(?:^|[?&])demo=1(?:&|$)/.test(location.search);
  if (localDemo) {
    void connect({ url: location.origin, token: 'local-demo-only' }).catch((error) => {
      setup.classList.remove('hidden'); el('central-setup-error').textContent = errorMessage(error);
    });
  } else {
  if (localStorage.getItem('streamcinema.auth-version') !== 'nightowl-account-v1') {
    localStorage.removeItem('streamcinema.config');
    localStorage.setItem('streamcinema.auth-version', 'nightowl-account-v1');
  }
  const saved = JSON.parse(localStorage.getItem('streamcinema.config') || 'null') as Config | null;
  if (saved?.url && saved.token) void connect(saved).catch((error) => {
    setup.classList.remove('hidden'); el('central-setup-error').textContent = errorMessage(error);
  });
  else setup.classList.remove('hidden');
  }
} catch { setup.classList.remove('hidden'); }
