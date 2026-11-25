/**
 * The one-line behaviours a control asks for by a `data-*` attribute
 * (page-contract.ts, "actions.ts"): what were inline `on*` handlers until
 * the CSP refused inline script (#672). Every listener is delegated on the
 * document, registered once at evaluation (a head module: a boosted
 * navigation swaps only the body), so a control a swap brings works with
 * nothing run again.
 *
 * Clicks, submits and closes are heard in the capture phase, ahead of every
 * listener on the control itself or below the document: htmx's own on a
 * boosted link or an hx-* control, and confirm-sheet.js's sheet opener,
 * where the inline handler, on the control, ran first.
 *
 * Without script each control does what it did before: the forms and links
 * post or follow natively, and the rest (a sheet, a copy) needed script
 * already.
 */

import {
  CHECKS_ON_TAP,
  CLOSES_MENU,
  CLOSES_SHEET,
  COPY_FLASHED,
  COPY_RESTING,
  COPY_TEXT,
  DISMISS,
  DISMISSABLE,
  NATIVE_WITHOUT,
  PHOTO_PICK,
  RESETS_ON_CLOSE,
  SELECTS_ON_TAP,
  SUBMITS_VIA,
} from '../../../src/web/page-contract';

const FLASH_MS = 1000;

/** The closest element carrying `attribute`, from the event's target up. */
function marked(event: Event, attribute: string): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(`[${attribute}]`);
}

function copy(button: HTMLElement) {
  const text = button.getAttribute(COPY_TEXT) ?? '';
  const resting = button.getAttribute(COPY_RESTING) ?? '';
  const flashed = button.getAttribute(COPY_FLASHED) ?? '';
  navigator.clipboard
    .writeText(text)
    .then(() => {
      button.classList.replace(resting, flashed);
      setTimeout(() => button.classList.replace(flashed, resting), FLASH_MS);
    })
    .catch((error: unknown) => {
      // Refused by the browser (no permission, no focus): the field beside
      // it, where there is one, still selects on a tap.
      console.warn('[actions] the copy was refused', error);
    });
}

document.addEventListener(
  'click',
  (event) => {
    const without = marked(event, NATIVE_WITHOUT);
    if (
      without &&
      !document.getElementById(without.getAttribute(NATIVE_WITHOUT) ?? '')
    ) {
      // htmx's request would need that element: follow the href instead.
      event.stopImmediatePropagation();
      return;
    }
    const checks = marked(event, CHECKS_ON_TAP);
    if (checks) {
      const input = document.getElementById(
        checks.getAttribute(CHECKS_ON_TAP) ?? '',
      );
      if (input instanceof HTMLInputElement) input.checked = true;
    }
    marked(event, CLOSES_MENU)?.closest('details')?.removeAttribute('open');
    marked(event, CLOSES_SHEET)?.closest('dialog')?.close();
    const dismiss = marked(event, DISMISS);
    if (dismiss) dismiss.closest(`[${DISMISSABLE}]`)?.remove();
    const field = marked(event, SELECTS_ON_TAP);
    if (field instanceof HTMLInputElement) field.select();
    const copies = marked(event, COPY_TEXT);
    if (copies) copy(copies);
  },
  true,
);

document.addEventListener(
  'submit',
  (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute(SUBMITS_VIA)) {
      return;
    }
    const via = document.getElementById(form.getAttribute(SUBMITS_VIA) ?? '');
    if (!window.htmx || !(via instanceof HTMLFormElement)) return;
    event.preventDefault();
    via.requestSubmit();
  },
  true,
);

// `close` does not bubble: heard on its way down.
document.addEventListener(
  'close',
  (event) => {
    const dialog = event.target;
    if (
      dialog instanceof HTMLDialogElement &&
      dialog.hasAttribute(RESETS_ON_CLOSE)
    ) {
      dialog.querySelector('form')?.reset();
    }
  },
  true,
);

document.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.hasAttribute(PHOTO_PICK)) {
    return;
  }
  import('photo-input')
    .then((photoInput) => photoInput.preparePhoto(input))
    .then((file) => {
      if (file) input.form?.requestSubmit();
    })
    .catch((error: unknown) => {
      console.error('[actions] the photo could not be prepared', error);
    });
});
