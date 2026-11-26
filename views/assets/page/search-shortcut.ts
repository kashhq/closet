/**
 * `/` focuses the page's search (owner decision 5 of the desktop plan,
 * docs/plans/2026-11-16-desktop-layout.md §7): the field marked
 * `data-search-shortcut`, one a page (the Wardrobe's, wardrobe-page.tsx).
 * A script because no attribute binds a key to a field (`accesskey` needs a
 * modifier).
 *
 * The key is left alone while it is text: in a field that takes typing, in
 * an editable element, with a modifier (Shift is how some layouts type
 * `/`, so it is not one), or under an open dialog, which owns the keyboard.
 * One document listener at module evaluation (boosted navigations swap only
 * the body).
 */

import { SEARCH_SHORTCUT } from '../../../src/web/page-contract';

// Inputs that take no typing, where `/` means nothing of its own.
const KEYLESS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function takesTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) return !KEYLESS.has(target.type);
  return (
    target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
}

document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (takesTyping(event.target)) return;
  if (document.querySelector('dialog[open]')) return;
  const field = document.querySelector(`[${SEARCH_SHORTCUT}]`);
  if (!(field instanceof HTMLElement)) return;
  event.preventDefault();
  field.focus();
});
