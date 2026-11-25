/**
 * The snap strip's observer (src/web/strip/snap-strip.tsx): which item a
 * strip holds is the one scrolled to its centre. Swiping is the browser's
 * own scroll-snap, so there are no touch handlers here at all; an
 * IntersectionObserver per strip, rooted on the strip with its margins
 * pulled in to a line down the middle, says which item crosses that line,
 * and that item becomes the choice: its `data-snap-value` goes into the
 * strip's hidden input (the element right after the strip),
 * and `data-selected` and `aria-selected` move to it.
 *
 * - initSnapStrips(root) centres each strip on its `data-selected` item and
 *   starts watching it. page-mount.ts calls it on every visit (a
 *   boosted navigation brings new strips; a <script src> module would run
 *   once per document); htmx:load covers strips swapped in later and a
 *   history restore, whose snapshot keeps the chosen item marked. Calling it
 *   twice on a strip is harmless, and a strip's next page (new items in a
 *   watched strip) is observed as it lands.
 * - A page of items swapped in before the chosen item (a strip loading
 *   backwards, Styling's newer garments, #996) keeps the chosen item where
 *   it sat, so the observer never chooses what slid into the middle; one
 *   that arrives mid-scroll waits for the scroll to end, so a fling runs
 *   its course.
 * - A tap on a neighbour centres it (and so chooses it) instead of opening
 *   it; a tap on the chosen item behaves as the item does (a boosted link
 *   opens).
 * - A mouse has two more ways in (#311): the strip's previous/next buttons
 *   (`data-snap-step`, CSS-hidden on touch devices) and the arrow keys while
 *   focus is in a strip. Both centre the neighbour of the chosen item (or of
 *   the one a step is already heading for), so the choice moves through the
 *   same observer and `snap-strip:choose`; an arrow on a focused item moves
 *   focus to that neighbour at once.
 * - A page with rules of its own listens on the document, nothing else:
 *   `snap-strip:choose` (cancelable, on the strip, detail.item) before an
 *   item is chosen, cancelled to keep the choice as it is;
 *   `snap-strip:chosen` (not cancelable, on the strip, detail.item) once it
 *   is, `data-selected` moved; `snap-strip:watch` (on the strip) after it
 *   has been (re)scanned. Styling's locks use the first and last, its
 *   preview the second.
 *
 * - From `lg` a strip that is not a choice may be a `row` or a `grid`
 *   (SnapStrip's `desktop`, `data-snap-desktop`): browsed, not chosen from.
 *   Such a strip gets no observer and no centring there; a `row`'s steps
 *   page by its visible width and the arrow keys move focus item to item.
 *   Decided by a media query, never by measuring: when the strip is first
 *   watched, and again whenever the query changes (a tablet rotating across
 *   `lg`), which attaches or detaches the observer and the tap-to-centre.
 *   A browsed strip's own box is observed (`resized`), so a desktop window
 *   resized within `lg` re-syncs its steps when the row starts or stops
 *   overflowing (#1117).
 *
 * Evaluated once per document: the listeners below sit on the document and
 * serve every page's strips.
 */

/** Strips already watched, each with its observer (null for a browsed one). */
const watched = new WeakMap();

/** Tailwind's `lg`, where `row` and `grid` strips stop being strips. */
const DESKTOP = window.matchMedia('(min-width: 64rem)');
const BROWSE_MODES = new Set(['row', 'grid']);

/** Strips watched as browsed: a `row` or `grid` at `lg`. */
const browsed = new WeakSet();

/**
 * A browsed strip's box: whether it can page either way changes with its
 * width (a window resized within `lg`) as well as its scroll. Observed only
 * while browsed; a strip swapped out reports a zero box and is let go.
 */
const resized = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (!target.isConnected) resized.unobserve(target);
    else if (browsed.has(target)) syncSteps(target);
  }
});

// A tablet rotating across `lg` (an installed PWA keeps its document) changes
// every watched strip's mode; strips not yet watched pick it up at their first watch.
DESKTOP.addEventListener('change', () => {
  for (const strip of document.querySelectorAll('[data-snap-strip]')) {
    if (watched.has(strip) && browsed.has(strip) !== wantsBrowsed(strip)) {
      applyMode(strip);
      watch(strip);
    }
  }
});

export function initSnapStrips(root) {
  if (!root) return;
  for (const strip of root.querySelectorAll('[data-snap-strip]')) watch(strip);
}

/** Whether `strip` is browsed (a `row` or `grid`) at the viewport's current width. */
function wantsBrowsed(strip) {
  return DESKTOP.matches && BROWSE_MODES.has(strip.dataset.snapDesktop);
}

/** Puts `strip` in the mode its width calls for: a browsed one has no observer, a strip has the centre-line one. */
function applyMode(strip) {
  watched.get(strip)?.disconnect();
  heading.delete(strip);
  if (wantsBrowsed(strip)) {
    browsed.add(strip);
    watched.set(strip, null);
    resized.observe(strip);
  } else {
    browsed.delete(strip);
    resized.unobserve(strip);
    watched.set(strip, observe(strip));
  }
}

function watch(strip) {
  if (!watched.has(strip)) applyMode(strip);
  const observer = watched.get(strip);
  // A strip's next page arrives as new items: observing one twice is a no-op.
  if (observer) {
    for (const item of strip.querySelectorAll('[data-snap-item]')) {
      observer.observe(item);
    }
  }
  syncSteps(strip);
  strip.dispatchEvent(new CustomEvent('snap-strip:watch', { bubbles: true }));
}

/** Centres the strip's chosen item and watches its centre line. */
function observe(strip) {
  centre(strip, strip.querySelector('[data-selected]'), 'instant');
  return new IntersectionObserver((entries) => chooseFrom(strip, entries), {
    root: strip,
    // A zero-width band down the middle: an item intersects it only while
    // it covers the centre, which is where scroll-snap parks the choice.
    rootMargin: '0px -50% 0px -50%',
    threshold: 0,
  });
}

function chooseFrom(strip, entries) {
  // Between a page landing before the chosen item and the strip being put
  // back (one task, unless htmx is ever given a swap delay): what crossed
  // the middle was pushed there, not swiped.
  if (anchors.has(strip)) return;
  const crossing = entries.find((entry) => entry.isIntersecting);
  if (!crossing) return;
  const proceed = strip.dispatchEvent(
    new CustomEvent('snap-strip:choose', {
      bubbles: true,
      cancelable: true,
      detail: { item: crossing.target },
    }),
  );
  if (proceed) choose(strip, crossing.target);
}

function choose(strip, item) {
  // SnapStrip emits its input directly after the strip, so strips sharing a
  // container each write to their own.
  // A strip without a `name` has no input and writes nothing.
  const field = strip.nextElementSibling;
  if (field instanceof HTMLInputElement && field.type === 'hidden') {
    // A hidden input's value is its attribute, so htmx's history snapshot
    // keeps the choice too.
    field.value = item.dataset.snapValue;
  }
  for (const other of strip.querySelectorAll('[data-snap-item]')) {
    const chosen = other === item;
    other.toggleAttribute('data-selected', chosen);
    // Only an `option` has a selected state (snapItem's `listbox: false`).
    if (other.hasAttribute('aria-selected')) {
      other.setAttribute('aria-selected', String(chosen));
    }
  }
  syncSteps(strip);
  // Also when the item was already chosen (the first watch centres it):
  // a listener mirroring the choice must be idempotent.
  strip.dispatchEvent(
    new CustomEvent('snap-strip:chosen', { bubbles: true, detail: { item } }),
  );
}

/** Scrolls `item` to the middle of its strip. */
export function centre(strip, item, behavior) {
  if (!item) return;
  const left = item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2;
  strip.scrollTo({ left, behavior });
}

function smooth() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : 'smooth';
}

// A neighbour peeking at the edge: a tap brings it to the middle (and so
// chooses it); only the chosen item's tap reaches the item. In the capture
// phase: an item may be a boosted link, and htmx's own click listener on it
// would start the navigation before a listener on the document heard the
// click bubble up. A page that makes neighbours inert (Styling's locked
// rows) gets no click on them at all: it lands on the strip.
document.addEventListener(
  'click',
  (event) => {
    const item = event.target.closest('[data-snap-item]');
    if (!item || item.hasAttribute('data-selected')) return;
    const strip = item.closest('[data-snap-strip]');
    // A browsed strip has no centre to bring a tile to: the tap is the tile's.
    if (!strip || browsed.has(strip)) return;
    // A tile's own button or link in a strip that opted in works first time.
    if (
      strip.hasAttribute('data-snap-tap-through') &&
      event.target.closest('button, a, input, label, summary')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    centre(strip, item, smooth());
  },
  { capture: true },
);

/**
 * The item a step is heading for, per strip, while its smooth scroll is in
 * flight: `data-selected` only moves when the observer sees the item cross
 * the centre, so steps count from here (a quick second press would
 * otherwise repeat the first) and the step buttons say where it can go next.
 */
const heading = new WeakMap();

/** The strip's items and the index steps count from: the item a step is heading for, else the chosen one. */
function position(strip) {
  const items = [...strip.querySelectorAll('[data-snap-item]')];
  const aimed = heading.get(strip);
  const at = aimed?.isConnected
    ? items.indexOf(aimed)
    : items.findIndex((item) => item.hasAttribute('data-selected'));
  return { items, at };
}

/** The item `step` places from `at`; null past an end or when it is inert (a locked Styling row's neighbours, which stay unchosen). */
function stepTarget({ items, at }, step) {
  const target = at < 0 ? undefined : items[at + step];
  return target && !target.inert ? target : null;
}

/** Centres the item `step` places from where the strip is or is heading; the item, or null when there is none to go to. */
function stepStrip(strip, step) {
  const target = stepTarget(position(strip), step);
  if (!target) return null;
  heading.set(strip, target);
  centre(strip, target, smooth());
  syncSteps(strip);
  return target;
}

/**
 * Previous/next say whether they would move the strip: not at an end, not
 * onto an inert item. `aria-disabled`, not `disabled`: a disabled button
 * loses focus to <body>, so a key held on Next would drop it at the end.
 * The server renders both disabled (the strip does nothing before this
 * script runs). Styling calls this when a lock makes neighbours inert.
 */
export function syncSteps(strip) {
  const buttons = strip.parentElement.querySelectorAll('[data-snap-step]');
  if (browsed.has(strip)) {
    for (const button of buttons) {
      const canPage = canPageBy(strip, Number(button.dataset.snapStep));
      button.setAttribute('aria-disabled', String(!canPage));
    }
    return;
  }
  const where = position(strip);
  for (const button of buttons) {
    const target = stepTarget(where, Number(button.dataset.snapStep));
    button.setAttribute('aria-disabled', String(!target));
  }
}

/**
 * Whether a browsed strip can page that way: not at its start or end. A
 * grid never scrolls, so both stay disabled (and CSS hides them there).
 * One pixel of slack: a fractional scroll width rounds.
 */
function canPageBy(strip, step) {
  if (step < 0) return strip.scrollLeft > 1;
  return strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-snap-step]');
  if (!button) return;
  const strip = button.parentElement.querySelector('[data-snap-strip]');
  if (!strip) return;
  const step = Number(button.dataset.snapStep);
  if (!browsed.has(strip)) {
    stepStrip(strip, step);
  } else if (canPageBy(strip, step)) {
    // A page at a time; snapping parks the next item at the start. The
    // buttons re-sync when the scroll ends (`stopped`).
    strip.scrollBy({ left: step * strip.clientWidth, behavior: smooth() });
  }
});

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

// Arrow keys while focus is in a strip (an item or the scroller itself). Not
// in a field: its caret keys are its own.
document.addEventListener('keydown', (event) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return;
  if (event.target.closest('input, textarea, select, [contenteditable]'))
    return;
  const strip = event.target.closest('[data-snap-strip]');
  if (!strip) return;
  event.preventDefault();
  const source = event.target.closest('[data-snap-item]');
  if (browsed.has(strip)) {
    focusBeside(strip, source, step);
    return;
  }
  const target = stepStrip(strip, step);
  // A focused item hands focus to the step's target now, not when the
  // observer chooses it: Enter or a held key's next repeat then acts on
  // where the strip is going, never the item it is leaving, and nothing
  // moves focus later (it would pull it from wherever the user went since).
  // No scroll: the smooth one is already under way. The strip itself keeps
  // focus when it was the focus target.
  if (target && event.target === source) {
    if (!target.matches(FOCUSABLE)) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }
});

/**
 * A browsed strip's arrow keys: focus moves to the item beside the one
 * holding it (from the strip itself, ArrowRight reaches its first item),
 * scrolled into view where it is a row. Nothing is chosen.
 */
function focusBeside(strip, source, step) {
  const items = [...strip.querySelectorAll('[data-snap-item]')];
  const target = items[(source ? items.indexOf(source) : -1) + step];
  if (!target) return;
  if (!target.matches(FOCUSABLE)) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: smooth(),
  });
}

/**
 * A page landing before the chosen item (Styling's newer garments, #996)
 * would push it aside, and the observer would choose whatever slid into
 * the middle. So the swap is bracketed: `htmx:beforeSwap` records where the
 * chosen item sits in the strip's viewport (measured from the item, so a
 * browser's own scroll anchoring or re-snap changes nothing) and the same
 * task's `htmx:afterSwap` puts it back, before the browser lays out and the
 * observer looks; `htmx:afterRequest` (also the same task, and the only
 * event an empty page fires) clears it whatever the answer was, so no
 * anchor outlives its request. Not at `htmx:load`: htmx fires that after
 * its settle delay, a frame or two later. A page after the chosen item
 * moves nothing and is not anchored.
 *
 * Putting the strip back is an instant scroll, which would cut a finger's
 * fling (or a step's smooth scroll) short, so a page that arrives while the
 * strip is scrolling is held and swapped in once it stops.
 */
const anchors = new WeakMap();

/** Per strip, the page held until it stops scrolling: its sentinel and the server's HTML. */
const held = new WeakMap();

/** Strips between a `scroll` and the end of that scroll. */
const scrolling = new WeakSet();

/**
 * Without `scrollend` (older WebKit), a scroll has ended once no scroll
 * event has come for this long: a fling's momentum and a smooth scroll
 * both send one a frame.
 */
const SCROLL_QUIET_MS = 150;
const quiet = new WeakMap();
const HAS_SCROLLEND = 'onscrollend' in window;

document.addEventListener(
  'scroll',
  (event) => {
    const strip = event.target;
    if (!(strip instanceof Element) || !strip.matches('[data-snap-strip]'))
      return;
    scrolling.add(strip);
    if (HAS_SCROLLEND) return;
    clearTimeout(quiet.get(strip));
    quiet.set(
      strip,
      setTimeout(() => stopped(strip), SCROLL_QUIET_MS),
    );
  },
  { capture: true, passive: true },
);

document.addEventListener(
  'scrollend',
  (event) => {
    const strip = event.target;
    if (strip instanceof Element && strip.matches('[data-snap-strip]')) {
      stopped(strip);
    }
  },
  { capture: true },
);

/** Whatever ended the scroll (arrival, a swipe taking over, a finger letting go), the strip's own state is the truth again. */
function stopped(strip) {
  scrolling.delete(strip);
  // A browsed row's steps follow where it scrolled to; a strip's, the step.
  if (heading.delete(strip) || browsed.has(strip)) syncSteps(strip);
  const page = held.get(strip);
  if (!page) return;
  held.delete(strip);
  if (!page.sentinel.isConnected) return;
  console.debug('[snap-strip] a held page lands: the strip has stopped');
  // The choice may have moved while the page waited.
  const item = chosenAfter(strip, page.sentinel);
  if (item) anchor(strip, page.sentinel, item);
  // Synchronous like the request's own swap (no swap or settle delay), so
  // the strip is put back before the browser lays it out.
  window.htmx.swap(page.sentinel, page.html, { swapStyle: 'outerHTML' });
  keepAnchor(strip, page.sentinel);
}

/** The strip's chosen item when `sentinel`'s page lands before it, else null. */
function chosenAfter(strip, sentinel) {
  const item = strip.querySelector('[data-selected]');
  const after =
    item &&
    !sentinel.contains(item) &&
    sentinel.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING;
  return after ? item : null;
}

function anchor(strip, sentinel, item) {
  anchors.set(strip, {
    sentinel,
    item,
    left: item.offsetLeft - strip.scrollLeft,
  });
}

/** Scrolls `strip` so the item anchored for `sentinel`'s page is where it was before the swap, and forgets the anchor. */
function keepAnchor(strip, sentinel) {
  const kept = anchors.get(strip);
  if (!kept || kept.sentinel !== sentinel) return;
  anchors.delete(strip);
  if (!kept.item.isConnected) return;
  const left = kept.item.offsetLeft - kept.left;
  if (left !== strip.scrollLeft) strip.scrollTo({ left, behavior: 'instant' });
}

document.addEventListener('htmx:beforeSwap', (event) => {
  const { detail } = event;
  // A failed page swaps nothing (request-failures.js), so nothing to keep.
  if (!detail.shouldSwap || detail.isError) return;
  const sentinel = detail.target;
  const strip = sentinel?.closest?.('[data-snap-strip]');
  const item = strip && chosenAfter(strip, sentinel);
  if (!item) return;
  if (scrolling.has(strip) || heading.has(strip)) {
    detail.shouldSwap = false;
    held.set(strip, { sentinel, html: detail.serverResponse });
    console.debug('[snap-strip] a page waits for the strip to stop');
    return;
  }
  anchor(strip, sentinel, item);
});

// `detail.target` is the request's swap target (the sentinel) in both;
// `detail.elt` is not: htmx rewrites it for each element it fires on.
function putBack(event) {
  const strip = event.target.closest?.('[data-snap-strip]');
  if (strip) keepAnchor(strip, event.detail.target);
}
document.addEventListener('htmx:afterSwap', putBack);
document.addEventListener('htmx:afterRequest', putBack);

// Strips swapped in after the page loaded, and history restores.
document.addEventListener('htmx:load', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const strip = target.closest('[data-snap-strip]');
  if (strip) watch(strip);
  else initSnapStrips(target);
});
