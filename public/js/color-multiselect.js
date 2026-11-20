/**
 * The garment form's colour picker (src/web/wardrobe/garment-form.tsx,
 * ColorMultiSelect): a <details> holding one checkbox per built-in colour,
 * a search box that filters them, and the checked ones shown as pills in the
 * summary. The checkboxes are the form's `color` fields; this script only
 * mirrors them. The server renders every option and validates what is
 * posted, so there is nothing to create here.
 *
 * Every node is built with createElement and textContent, never innerHTML:
 * option values and labels are data, and a value spliced into markup was a
 * stored XSS (audit2-correctness H5).
 *
 * Loaded once from the layout's head; it initialises each picker on load and
 * after every htmx swap (boosted navigations swap the body).
 */
(function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function initMultiselect(det) {
    if (det.dataset.msReady) return;
    det.dataset.msReady = 'true';

    const pillsEl = det.querySelector('.ms-pills');
    const searchEl = det.querySelector('.ms-search-input');
    const optionsEl = det.querySelector('.ms-options');
    const emptyEl = det.querySelector('.ms-empty');
    const countEl = det.querySelector('.ms-count');
    const clearBtn = det.querySelector('.ms-clear');
    const placeholder = det.dataset.placeholder || '';
    const selectedLabel = det.dataset.selectedLabel || '';

    const boxes = () => [
      ...optionsEl.querySelectorAll('input[type="checkbox"]'),
    ];

    // A pill is text, never a control: the pills are the summary's content,
    // and a button inside <summary> is a control inside a control (axe's
    // nested-interactive, #1210) and a mis-tap that opens the list. A colour
    // comes off by its checkbox in the list, or Clear all.
    function pillFor(box) {
      const option = box.closest('.ms-option');
      const pill = el('span', 'ms-pill badge badge-ghost');
      // The option's own swatch and label, whatever colour it is.
      const swatch = option.querySelector('.ms-swatch');
      if (swatch) pill.append(el('span', swatch.className));
      pill.append(el('span', 'capitalize', box.value));
      return pill;
    }

    function renderPills() {
      const checked = boxes().filter((box) => box.checked);
      if (checked.length === 0) {
        pillsEl.replaceChildren(el('span', 'ms-placeholder', placeholder));
      } else {
        pillsEl.replaceChildren(...checked.map(pillFor));
      }
      countEl.textContent = `${checked.length} ${selectedLabel}`;
    }

    function filterOptions(query) {
      const needle = query.trim().toLowerCase();
      let visible = 0;
      for (const box of boxes()) {
        const match = !needle || box.value.includes(needle);
        box.closest('.ms-option').classList.toggle('hidden', !match);
        if (match) visible++;
      }
      emptyEl.hidden = visible > 0;
    }

    optionsEl.addEventListener('change', renderPills);
    searchEl.addEventListener('input', () => filterOptions(searchEl.value));
    // Enter in the search box must not submit the garment form.
    searchEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    clearBtn.addEventListener('click', () => {
      for (const box of boxes()) box.checked = false;
      searchEl.value = '';
      filterOptions('');
      renderPills();
    });
    det.addEventListener('toggle', () => {
      if (det.open) {
        setTimeout(() => searchEl.focus(), 10);
      } else {
        searchEl.value = '';
        filterOptions('');
      }
    });

    renderPills();
  }

  function initAll(root) {
    (root || document).querySelectorAll('.color-ms').forEach(initMultiselect);
  }

  // Close an open picker on a click anywhere else.
  document.addEventListener('click', (event) => {
    document.querySelectorAll('.color-ms[open]').forEach((det) => {
      if (!det.contains(event.target)) det.open = false;
    });
  });

  document.addEventListener('DOMContentLoaded', () => initAll());
  document.addEventListener('htmx:afterSwap', (event) =>
    initAll(event.detail.target),
  );
})();
