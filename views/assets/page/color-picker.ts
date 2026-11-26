/**
 * The garment form's colour field (ColorPicker, garment-form.tsx): a
 * <details> listing one checkbox per built-in colour, with a search box
 * over the list and the ticked colours as pills in its summary. The
 * checkboxes are the form's own `color` fields and the server renders the
 * pills, the placeholder and the count for what it ticked, so without this
 * module the field still works; here they follow the ticks, the search
 * narrows the list, and Clear all unticks everything.
 *
 * Loaded once from the layout's head. Every listener is delegated on the
 * document, so a picker brought in by a boosted navigation or a fragment
 * swap (the properties fragment) needs no setup; `htmx:load` re-reads the
 * ticks of new content, which a history restore can bring back unticked
 * from its snapshot while the pills kept their markup.
 */

import {
  COLOR_OPTION,
  COLOR_PICKER,
  COLOR_PILL,
  colorPickerPartSelector,
  type ColorPickerPart,
} from '../../../src/web/page-contract';

const PICKER = `[${COLOR_PICKER}]`;

function part<T extends HTMLElement>(
  picker: HTMLDetailsElement,
  name: ColorPickerPart,
): T | null {
  return picker.querySelector<T>(colorPickerPartSelector(name));
}

function checkboxes(picker: HTMLDetailsElement): HTMLInputElement[] {
  return [
    ...picker.querySelectorAll<HTMLInputElement>(
      `[${COLOR_OPTION}] input[type="checkbox"]`,
    ),
  ];
}

/** Shows the pill of each ticked colour, the placeholder for none, and the count. */
function showTicked(picker: HTMLDetailsElement) {
  const ticked = new Set(
    checkboxes(picker)
      .filter((box) => box.checked)
      .map((box) => box.value),
  );
  for (const pill of picker.querySelectorAll<HTMLElement>(`[${COLOR_PILL}]`)) {
    pill.hidden = !ticked.has(pill.getAttribute(COLOR_PILL) ?? '');
  }
  const placeholder = part(picker, 'placeholder');
  if (placeholder) placeholder.hidden = ticked.size > 0;
  const count = part(picker, 'count');
  if (count) count.textContent = String(ticked.size);
}

/** Hides the colours whose name does not contain `query`; says so when none is left. */
function narrowTo(picker: HTMLDetailsElement, query: string) {
  const needle = query.trim().toLowerCase();
  let shown = 0;
  for (const option of picker.querySelectorAll<HTMLElement>(
    `[${COLOR_OPTION}]`,
  )) {
    const matches = (option.getAttribute(COLOR_OPTION) ?? '').includes(needle);
    option.hidden = !matches;
    if (matches) shown += 1;
  }
  const empty = part(picker, 'empty');
  if (empty) empty.hidden = shown > 0;
}

function resetSearch(picker: HTMLDetailsElement) {
  const search = part<HTMLInputElement>(picker, 'search');
  if (search) search.value = '';
  narrowTo(picker, '');
}

function pickerOf(target: EventTarget | null): HTMLDetailsElement | null {
  if (!(target instanceof Element)) return null;
  const picker = target.closest(PICKER);
  return picker instanceof HTMLDetailsElement ? picker : null;
}

const isPart = (target: EventTarget | null, name: ColorPickerPart) =>
  target instanceof Element && target.matches(colorPickerPartSelector(name));

document.addEventListener('change', (event) => {
  const picker = pickerOf(event.target);
  if (picker) showTicked(picker);
});

document.addEventListener('input', (event) => {
  const picker = pickerOf(event.target);
  if (picker && isPart(event.target, 'search')) {
    narrowTo(picker, (event.target as HTMLInputElement).value);
  }
});

// Enter in the search box would submit the garment form.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && isPart(event.target, 'search')) {
    event.preventDefault();
  }
});

document.addEventListener('click', (event) => {
  // A tap anywhere outside an open picker closes it.
  for (const open of document.querySelectorAll<HTMLDetailsElement>(
    `${PICKER}[open]`,
  )) {
    if (!(event.target instanceof Node) || !open.contains(event.target)) {
      open.open = false;
    }
  }
  const picker = pickerOf(event.target);
  if (!picker || !isPart(event.target, 'clear')) return;
  for (const box of checkboxes(picker)) box.checked = false;
  resetSearch(picker);
  showTicked(picker);
});

// `toggle` does not bubble: caught on its way down.
document.addEventListener(
  'toggle',
  (event) => {
    const picker = event.target;
    if (!(picker instanceof HTMLDetailsElement) || !picker.matches(PICKER)) {
      return;
    }
    if (picker.open) {
      // After the browser's own focus on the summary the tap gave.
      setTimeout(() => part(picker, 'search')?.focus(), 10);
    } else {
      resetSearch(picker);
    }
  },
  true,
);

function showTickedWithin(root: ParentNode) {
  for (const picker of root.querySelectorAll<HTMLDetailsElement>(PICKER)) {
    showTicked(picker);
  }
}

document.addEventListener('htmx:load', (event) => {
  if (event.target instanceof Element) {
    const picker = pickerOf(event.target);
    if (picker) showTicked(picker);
    else showTickedWithin(event.target);
  }
});

// A module runs after parsing; the browser may have restored ticks by then.
showTickedWithin(document);
