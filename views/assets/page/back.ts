/**
 * The app bar's back arrow (src/web/layout/app-bar.tsx, `data-history-back`)
 * goes back like a native app's: to the page the user came from, as history
 * holds it (htmx's snapshot: Styling's rows as they were left), whenever
 * that page is in the app. On a cold entry (a shared link, a push
 * notification, a fresh launch of the installed app) there is nothing in the
 * app to go back to, and the arrow follows its href, the page's fixed
 * parent, as the boosted link it is.
 *
 * "The previous entry is in the app" is recorded, never guessed. Every
 * history entry this tab makes carries its trail, the app's entries from the
 * cold one up to itself, in history.state:
 *  - history.state is per entry, so back/forward, a reload and the bfcache
 *    each find the trail of the entry they land on; it is per tab, and it
 *    works everywhere, iOS Safari standalone included (the Navigation API
 *    reached Safari only in 26.x, and would need this as its fallback).
 *  - A same-origin document.referrer cannot tell: a boosted navigation never
 *    changes it. sessionStorage cannot either: nothing in the History API
 *    says which entry a back/forward landed on.
 * htmx overwrites an entry's state with `{htmx: true}` when it snapshots the
 * page (before every navigation, and on every history restore), so the
 * trail on screen is kept here and written back after each.
 *
 * A native post (every PostForm, src/web/form.tsx) loads a new
 * document, whose entry starts without state: the submit hands the trail
 * over in sessionStorage, and the next document takes it only when its
 * referrer is the page that posted (a push notification's navigation never
 * matches).
 *
 * A form page (AppBar `formPage`: an edit or add page, Styling where it can
 * save) is done once saved or cancelled. Its Cancel (`CancelLink`) is a back
 * arrow too, and on a cold entry, where the arrow and Cancel go forward to
 * their href, that entry counts as the form's exit. The page its save or
 * exit lands on goes back past it, past a refused attempt's
 * re-render, and past the entries of its own page (the garment as it was
 * before the edit). Garment, Edit, Save, back: to where the garment page was
 * opened from, never to the stale form. "Its own page" is the pathname: a
 * page that saves in place lands on itself with a flag in the query
 * (`?saved=1`), and back from it skips the copy from before the save.
 *
 * A save makes what history holds stale: htmx's snapshots (and a bfcached
 * document) were taken before it, so the Wardrobe went back to showing the
 * garment's old name. Each trail entry keeps when its page was rendered
 * (`at`), a native post records when the tab last saved (sessionStorage),
 * and an entry restored from history that was rendered before that save is
 * reloaded in place (no new entry; its trail survives in history.state, and
 * the reload renders it anew). Every stale entry refreshes once, however far
 * back; one rendered after the last save (anything after signing in) is
 * restored as it was. A document a back/forward loads again counts as
 * restored (the browser's HTTP cache answers it). htmx writes (autosave,
 * hx-post) are not saves here: they answer the part of the page they change.
 *
 * Evaluated once per document (a module; boosted navigations swap only the
 * body): the listeners sit on the document and the window.
 */
import { FORM_PAGE, HISTORY_BACK } from '../../../src/web/page-contract';

/** One history entry of the app: its path, how it was reached, when rendered. */
interface TrailEntry {
  path: string;
  /** Reached by a form page's save or exit, so back goes past that form. */
  afterForm: boolean;
  at: number;
}

const STATE_KEY = 'closetTrail';
const HANDOFF_KEY = 'closet-back-handoff';
const SAVED_AT_KEY = 'closet-back-saved-at';
/** Plenty for any real back chain; keeps history.state small. */
const TRAIL_LIMIT = 50;

const here = () => location.pathname + location.search;
const last = (entries: TrailEntry[]) => entries[entries.length - 1];
const pathnameOf = (path: string) => path.split('?')[0];
/** A new entry for the page on screen, rendered now. */
const entryHere = (afterForm: boolean): TrailEntry => ({
  path: here(),
  afterForm,
  at: Date.now(),
});
const coldTrail = () => [entryHere(false)];
/**
 * What the logs name a page by: its first path segment. Paths can carry
 * secrets (an invite token: the server's `secretPath` routes) and queries
 * whatever the user typed, and the console is readable by anything on the
 * page.
 */
const routeKind = (path: string) => `/${path.split(/[/?#]/)[1] ?? ''}`;

/** The page on screen is a form its save leaves (AppBar `formPage`). */
const onFormPage = () =>
  document.querySelector(`header.app-bar[${FORM_PAGE}]`) !== null;

/** history.state as this module and htmx leave it. */
const stateOf = (value: unknown) =>
  (value ?? undefined) as { [STATE_KEY]?: unknown } | undefined;

/**
 * A trail read back from history.state or the handoff, if it is one: a
 * list of entries ending at `path`.
 */
function trailEndingAt(value: unknown, path: string): TrailEntry[] | null {
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry: Partial<TrailEntry> | null | undefined) =>
        typeof entry?.path === 'string' &&
        typeof entry.afterForm === 'boolean' &&
        typeof entry.at === 'number',
    );
  return valid && last(value as TrailEntry[]).path === path
    ? (value as TrailEntry[])
    : null;
}

/** The trail of the entry on screen. */
let trail: TrailEntry[] = [];

function remember(entries: TrailEntry[]) {
  trail = entries.slice(-TRAIL_LIMIT);
  history.replaceState(
    { ...(history.state as object | null), [STATE_KEY]: trail },
    '',
  );
}

/**
 * The trail a native post from the referring page handed over. Read once:
 * whatever this document's entry is, the handoff is spent.
 */
function takeHandoff(): { trail: TrailEntry[]; afterForm: boolean } | null {
  let handoff: { trail?: unknown; afterForm?: unknown } | null;
  try {
    handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? 'null') as {
      trail?: unknown;
      afterForm?: unknown;
    } | null;
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch (error) {
    console.warn('[back] could not read the handed-over trail', error);
    return null;
  }
  if (!handoff || !document.referrer) return null;
  const referrer = new URL(document.referrer);
  if (referrer.origin !== location.origin) return null;
  const from = trailEndingAt(
    handoff.trail,
    referrer.pathname + referrer.search,
  );
  return from ? { trail: from, afterForm: handoff.afterForm === true } : null;
}

// This document's first entry: its own trail when it has one (a reload, a
// back/forward into another document), the one a native post handed over,
// or a cold entry.
{
  const handoff = takeHandoff();
  const stored = trailEndingAt(stateOf(history.state)?.[STATE_KEY], here());
  if (stored) {
    // A reload (pull to refresh, the save's own) renders the page anew; a
    // back/forward load may come from the HTTP cache (below).
    if (navigationType() === 'back_forward') trail = stored;
    else
      remember([...stored.slice(0, -1), { ...last(stored), at: Date.now() }]);
  } else if (handoff) {
    remember([...handoff.trail, entryHere(handoff.afterForm)]);
  } else {
    console.debug(`[back] cold entry at ${routeKind(here())}`);
    remember(coldTrail());
  }
}

/**
 * How many entries back the arrow goes: to the one before this, skipping
 * the form page this entry left as done (and, while each skipped entry was
 * itself one, the form before it) and, once in such a chain, entries of
 * this very page (the garment as it was before its edit). Outside a form
 * chain an entry of the same page is a place of its own (Insights before
 * `?unworn=30`). 0 when that runs past the trail's start: nothing in the
 * app to go back to.
 */
function stepsBack(entries: TrailEntry[]) {
  const current = entries.length - 1;
  const page = pathnameOf(entries[current].path);
  let from = current;
  let target = current - 1;
  let inFormChain = false;
  while (target >= 0) {
    if (entries[from].afterForm) inFormChain = true;
    else if (!inFormChain || pathnameOf(entries[target].path) !== page) break;
    from = target;
    target -= 1;
  }
  return target < 0 ? 0 : current - target;
}

/**
 * Where a form page's back arrow or Cancel is going forward to on a cold
 * entry (its href): the entry it pushes is the form's exit, done like a
 * save, so its own back arrow does not return into the abandoned form.
 */
let formExit: string | null = null;

// Capture phase: ahead of htmx's own click listener on the (boosted) link,
// which would otherwise also navigate forward to the href.
document.addEventListener(
  'click',
  (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    const link = event.target.closest<HTMLAnchorElement>(`a[${HISTORY_BACK}]`);
    if (!link) return;
    const steps = stepsBack(trail);
    if (steps === 0) {
      const href = new URL(link.href);
      if (onFormPage()) formExit = href.pathname + href.search;
      console.info(
        `[back] nothing in-app before ${routeKind(here())}: following its link to ${routeKind(href.pathname)}`,
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    console.info(
      `[back] ${routeKind(here())} -> ${routeKind(trail[trail.length - 1 - steps].path)} (${steps} back)`,
    );
    history.go(-steps);
  },
  { capture: true },
);

// htmx has just snapshotted the page being left, dropping the trail from its
// entry. A boosted navigation is never a form page's save (every post form
// is a native PostForm, test/integration/pages.ts): its entry is afterForm
// only as a form page's cold exit (formExit), never for another link a form
// page holds (Styling's garments, the garment form's "Add from a link").
document.addEventListener('htmx:beforeHistoryUpdate', () => remember(trail));
document.addEventListener('htmx:pushedIntoHistory', () => {
  const afterForm = formExit === here();
  formExit = null;
  remember([...trail, entryHere(afterForm)]);
});
document.addEventListener('htmx:replacedInHistory', () => {
  remember([...trail.slice(0, -1), { ...entryHere(last(trail).afterForm) }]);
});

// Back/forward within this document: the entry landed on has its own trail
// (event.state, read before htmx's restore overwrites it). An entry without
// one is a fragment link's (`#day-…`: the same address, a new entry, no
// state), which continues the trail, or one made before this module
// shipped, which starts cold. htmx:historyRestore writes it back once htmx
// is done with the entry.
window.addEventListener('popstate', (event) => {
  const stored = trailEndingAt(stateOf(event.state)?.[STATE_KEY], here());
  if (stored) remember(stored);
  else if (last(trail).path === here()) {
    remember([...trail, entryHere(false)]);
  } else remember(coldTrail());
});
document.addEventListener('htmx:historyRestore', () => {
  remember(trail);
  reloadIfStale('history restore');
});

// Safari (and Chromium) may bring a whole document back from the bfcache
// instead. When it lands on another of its entries, popstate and htmx's
// restore follow and reload it above; the task after pageshow catches the
// entry the document was left on.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) setTimeout(() => reloadIfStale('bfcache'));
});
// A document a back/forward loads again is no fresher: the browser answers
// history navigations from its HTTP cache where it can, and the worker's
// tab roots open from the page cache (only a reload revalidates them).
// Once loaded: a reload while the page's modules and the worker's
// registration are still loading aborts them mid-flight.
if (navigationType() === 'back_forward') {
  window.addEventListener('load', () => reloadIfStale('back/forward load'), {
    once: true,
  });
}

function navigationType() {
  return (
    performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
  )?.type;
}

/** Reloads the entry on screen if it was rendered before the tab's last save. */
function reloadIfStale(how: string) {
  if (last(trail).at >= lastSavedAt()) return;
  console.info(
    `[back] ${routeKind(here())} restored (${how}) from before a save: reloading`,
  );
  location.reload();
}

function lastSavedAt() {
  try {
    return Number(sessionStorage.getItem(SAVED_AT_KEY) ?? 0);
  } catch (error) {
    console.warn('[back] could not read when the tab last saved', error);
    return 0;
  }
}

function recordSave() {
  try {
    sessionStorage.setItem(SAVED_AT_KEY, String(Date.now()));
  } catch (error) {
    console.warn('[back] could not record the save', error);
  }
}

// A native submit leaves this document: hand the trail to the next one. A
// boosted form's submit is htmx's (prevented), as is one a confirm() or
// submit-once (loaded before this module) cancelled.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (
    event.defaultPrevented ||
    !(form instanceof HTMLFormElement) ||
    (form.target && form.target !== '_self')
  ) {
    return;
  }
  const posts = form.method === 'post';
  if (posts) recordSave();
  const handoff = { trail, afterForm: posts && onFormPage() };
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  } catch (error) {
    console.warn('[back] could not hand the trail over', error);
  }
});
