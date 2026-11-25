/**
 * Styling's rows (src/web/styling/styling-row.tsx, #42) are snap strips: the
 * shared observer (snap-strip.js) centres the chosen item, chooses the one
 * scrolled to the middle into the row's `garmentId` and centres a tapped
 * neighbour. This module is what is Styling's own: the row locks.
 *
 * - initStyling(root) is page-mount.ts's one call, on #styling-rows: it loads these
 *   listeners and starts the strips under `root` (see initSnapStrips).
 * - A locked row is frozen (#106): CSS stops its strip scrolling under a
 *   finger (styling-row.tsx), its neighbours are inert (#146: out of the tab
 *   order, the accessibility tree and hit testing, so neither Tab nor a tap
 *   reaches one), and whatever else scrolls it is undone rather than
 *   chosen. Centring on load still runs (the shared observer), so a row
 *   opened locked ("Style this") sits on its garment. The server renders a
 *   locked row's inert neighbours; setLocked owns every change after that
 *   (the lock's field, its attribute and the neighbours), and a strip's
 *   next page is made inert as it lands in a locked row (`snap-strip:watch`).
 *
 * - The preview (#468; the phone's bar since #664) has a slot per row; the
 *   server draws it and sends it again with every rows answer, and between them a choice
 *   moves without a request, so each `snap-strip:chosen` copies the chosen
 *   item's look (its plinth's children) into its row's slot. It follows a
 *   swipe offline as choosing does. A changed slot asks the fit line
 *   (#468b, GET /styling/fit) again.
 *
 * Evaluated once per document: the listeners below sit on the document and
 * serve every page's rows.
 */
import { centre, initSnapStrips, syncSteps } from 'snap-strip';

export function initStyling(root) {
  initSnapStrips(root);
  syncPreviewToggle();
}

// From lg the preview is always the whole outfit (each `group-open:` class
// has its `lg:` twin), so the summary's toggle is a dead stop: make it inert
// (out of the tab order and the tree). `open` is never touched, so the
// visitor's own state survives a resize. Evaluated once per document, so the
// one listener serves every visit.
const WIDE = matchMedia('(min-width: 64rem)');
WIDE.addEventListener('change', syncPreviewToggle);

function syncPreviewToggle() {
  const details = document.querySelector('[data-preview-toggle]');
  if (!details) return;
  details.querySelector(':scope > summary').inert = WIDE.matches;
}

// A locked row keeps its garment whatever moved the strip. Its hidden
// overflow stops fingers and wheels and its inert neighbours take no
// focus, but a script's scroll still moves it (scrollIntoView, or a
// browser revealing a focused descendant, as Firefox did before #146), so
// cancel the choice and put it back in the middle instead.
document.addEventListener('snap-strip:choose', (event) => {
  const strip = event.target;
  if (!strip.matches('.styling-strip') || !rowLocked(rowOf(strip))) return;
  event.preventDefault();
  if (!event.detail.item.hasAttribute('data-selected')) {
    centre(strip, strip.querySelector('[data-selected]'), 'instant');
  }
});

// The next page's request does not carry the row's lock.
document.addEventListener('snap-strip:watch', (event) => {
  const strip = event.target;
  if (strip.matches('.styling-strip')) syncLock(rowOf(strip));
});

// The preview follows each row's choice.
document.addEventListener('snap-strip:chosen', (event) => {
  const strip = event.target;
  if (strip.matches('.styling-strip')) mirror(rowOf(strip), event.detail.item);
});

/**
 * The row's preview slot (`data-preview-slot`, its index among the rows)
 * shows the chosen item's look, or nothing for "No garment". The slot keeps
 * the chosen id, so a choice already shown (a strip's first watch centres
 * the server's choice) costs nothing.
 */
function mirror(row, item) {
  const rows = [
    ...row.parentElement.querySelectorAll(':scope > [data-styling-row]'),
  ];
  const slot = document.querySelector(
    `#styling-preview [data-preview-slot="${rows.indexOf(row)}"]`,
  );
  const value = item.dataset.snapValue;
  if (!slot || slot.dataset.previewGarment === value) return;
  slot.dataset.previewGarment = value;
  const plinth = value ? item.querySelector('[data-styling-plinth]') : null;
  slot.replaceChildren(
    ...(plinth ? [...plinth.children].map((look) => look.cloneNode(true)) : []),
  );
  askFit();
}

/**
 * The fit line (#468b) asks again for the changed outfit (its hx-trigger
 * debounces). Shown at every width since #664; absent without the weather
 * or over a shared wardrobe.
 */
function askFit() {
  document
    .getElementById('styling-fit-line')
    ?.dispatchEvent(new CustomEvent('styling:outfit-changed'));
}

function rowOf(element) {
  return element.closest('[data-styling-row]');
}

/** The row's lock, the same state the strip's CSS freezes on. */
function rowLocked(row) {
  return row.querySelector('.styling-lock:checked') !== null;
}

/**
 * A locked row's neighbours are inert, its chosen item is not; unlocked,
 * none is. The `inert` property reflects to its attribute, so htmx's
 * history snapshot (innerHTML) keeps it. The strip's steps follow: none
 * goes to an inert item.
 */
function syncLock(row) {
  const locked = rowLocked(row);
  for (const item of row.querySelectorAll('.styling-item')) {
    item.inert = locked && !item.hasAttribute('data-selected');
  }
  syncSteps(row.querySelector('.styling-strip'));
}

/**
 * The lock was toggled: the row's `lock` field (what Shuffle and Save
 * post), the checkbox's `checked` attribute (htmx's history snapshot is
 * innerHTML, which drops the property) and its neighbours' inert, together.
 */
function setLocked(lock) {
  const row = rowOf(lock);
  row.querySelector('input[name="lock"]').value = lock.checked ? '1' : '';
  lock.toggleAttribute('checked', lock.checked);
  syncLock(row);
  console.debug(
    `[styling] ${row.dataset.stylingRow} row ${lock.checked ? 'locked' : 'unlocked'}`,
  );
}

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches('.styling-lock')) {
    setLocked(target);
  }
});
