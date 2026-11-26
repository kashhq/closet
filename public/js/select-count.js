/**
 * Select mode's "N selected" (SelectForm, src/web/wardrobe/wardrobe-page.tsx):
 * the boxes checked in the form, recounted on every toggle and whenever htmx
 * settles new content into it. The count is shown in the page's action bar,
 * outside the form: the form's `data-select-count` names its element's id.
 * The grid's next page arrives through the sentinel's swap and fires no change event, yet the capsule picker renders
 * members on it checked, and Save posts them: the count must include them.
 *
 * "Select all N" (`data-select-all`, #677) posts `all=1` and the server acts
 * on every garment of the filters, loaded or not, so while it is checked the
 * count is its `data-total`, every tile shown is checked (later pages as
 * they arrive), and unchecking a tile unchecks it: the selection is then
 * the tiles still checked.
 *
 * A kept selection's garments the page does not show (a later page, or out
 * of the filters after a verb changed them) ride as hidden `data-carried`
 * ids, counted and posted; the page that brings the tile drops its twin, so
 * the tile's own box decides from then on.
 *
 * Evaluated once per document: the listeners sit on the document and serve
 * every select-mode page a boosted navigation brings. The server renders the
 * first page's count, but this module loads after the page does, so a box
 * toggled before it ran fired a change nobody heard (a quick tap, or any tap
 * under load: #247). It counts once when it runs, to catch up.
 */

const FORM = '[data-select-count]';
const TILES = 'input[type=checkbox][name=ids]';
const CARRIED = 'input[data-carried]';

function count(form) {
  const shown = document.getElementById(form.dataset.selectCount);
  if (!shown) return;
  const all = form.querySelector('[data-select-all]');
  if (all?.checked) {
    for (const box of form.querySelectorAll(TILES)) box.checked = true;
    shown.textContent = all.dataset.total ?? '';
    return;
  }
  shown.textContent = String(
    form.querySelectorAll(`${TILES}:checked, ${CARRIED}`).length,
  );
}

function dropShownCarried(form) {
  for (const twin of form.querySelectorAll(CARRIED)) {
    if (form.querySelector(`${TILES}[value="${twin.value}"]`)) {
      twin.remove();
    }
  }
}

function toggled(event) {
  const target = event.target;
  const form = target instanceof Element && target.closest(FORM);
  if (!form) return;
  if (target.matches('[data-select-all]') && !target.checked) {
    for (const box of form.querySelectorAll(TILES)) box.checked = false;
  } else if (target.matches(TILES) && !target.checked) {
    const all = form.querySelector('[data-select-all]');
    if (all) all.checked = false;
  }
  count(form);
}

function settled(event) {
  const form = event.target instanceof Element && event.target.closest(FORM);
  if (!form) return;
  dropShownCarried(form);
  count(form);
}

document.addEventListener('change', toggled);
// Fired on each element a swap inserted, and bubbles to the form.
document.addEventListener('htmx:afterSettle', settled);
document.querySelectorAll(FORM).forEach(count);
