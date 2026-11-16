/**
 * The app's sheets (src/web/layout/sheet.tsx, #1062) and, among them, its
 * own confirmation, in place of the browser's confirm() box.
 *
 * Every sheet opens through `openSheet(dialog, trigger)`: a control with
 * `data-sheet-open="<id>"` (sheetOpener) opens that sheet on a click, with
 * itself as the trigger. Escape, the first focus and the inert page are
 * `showModal()`'s; this adds what the browser does not: Tab and Shift+Tab
 * cycle inside the sheet (a modal dialog lets Tab out of its last control
 * into the browser's own toolbar); focus goes back to the trigger on close
 * (Safari never focuses a tapped button, so the browser's own return had
 * nothing to go back to), or to its menu's summary when the trigger sat in
 * a `<details>` menu that closed; and a `menu` sheet's trigger becomes the
 * anchor main.css hangs the sheet under from lg (`data-sheet-anchor`).
 *
 * The confirmation (#686: the box is titled with the server host and
 * unstyled; guards.conf `@native-confirm` refuses a new one) is one
 * `<dialog id="confirm-sheet">` (src/web/layout/confirm-sheet.tsx) serving
 * every ask:
 *
 * - htmx's `hx-confirm` (`htmx:confirm`): the request is issued only once
 *   the sheet says yes;
 * - `PostForm`'s `data-confirm` (`submit`): a native post, so password
 *   saving and the no-boost rules stay; the submit is held and sent again,
 *   as it was, once confirmed;
 * - `confirmAction()`, for a script (the outbox's sign-out discard), which
 *   imports this module through the import map.
 *
 * The destructive button is labelled with the trigger's own words ("Delete",
 * "Archive"). Keyboard: Cancel takes focus (autofocus), Escape and a tap
 * outside cancel, and focus returns to the trigger. The listeners sit on the
 * document once, at module evaluation.
 */

const FOCUSABLE =
  'a[href], button, input, select, textarea, summary, [tabindex]';

/**
 * Whether a radio is its group's Tab stop: the checked one, or the first
 * while none is (a group is one stop; the arrow keys move inside it). The
 * group is the radio's form's (the bulk sheet's chips join theirs by
 * `form=`), else the sheet's.
 */
function isRadioStop(radio, dialog) {
  const named = radio.form?.elements.namedItem(radio.name);
  const group =
    named instanceof RadioNodeList
      ? [...named]
      : [
          ...dialog.querySelectorAll(
            `input[type="radio"][name="${CSS.escape(radio.name)}"]`,
          ),
        ];
  const checked = group.find((input) => input.checked);
  return checked ? checked === radio : group[0] === radio;
}

/** The sheet's Tab stops in document order: shown, enabled, not inert. */
function tabStops(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.disabled &&
      !element.closest('[inert]') &&
      element.getClientRects().length > 0 &&
      !(
        element instanceof HTMLInputElement &&
        element.type === 'radio' &&
        element.name &&
        !isRadioStop(element, dialog)
      ),
  );
}

/** Tab past the sheet's last stop goes to its first, Shift+Tab the other way. */
function keepTabInside(event) {
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget;
  const stops = tabStops(dialog);
  if (stops.length === 0) return;
  const [first, last] = [stops[0], stops[stops.length - 1]];
  const active = document.activeElement;
  const leaving = event.shiftKey
    ? active === first || active === dialog
    : active === last;
  if (!leaving && dialog.contains(active)) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}

/** Where focus goes back to: the trigger, or the summary of the menu it closed. */
function returnTarget(trigger) {
  const menu = trigger.closest('details');
  return menu && !menu.open ? menu.querySelector('summary') : trigger;
}

/**
 * Opens a sheet as a modal, keeps Tab inside it and gives focus back to
 * `trigger` when it closes. Without a trigger (a script's ask) the
 * browser's own return stands.
 *
 * @param {HTMLDialogElement} dialog
 * @param {Element | null | undefined} trigger
 */
export function openSheet(dialog, trigger) {
  if (dialog.open) return;
  const anchored = dialog.dataset.sheet === 'menu' && trigger;
  if (anchored) trigger.setAttribute('data-sheet-anchor', '');
  dialog.addEventListener('keydown', keepTabInside);
  dialog.addEventListener(
    'close',
    () => {
      dialog.removeEventListener('keydown', keepTabInside);
      if (anchored) trigger.removeAttribute('data-sheet-anchor');
      const target = trigger && returnTarget(trigger);
      if (target?.isConnected) target.focus();
    },
    { once: true },
  );
  dialog.showModal();
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const opener = event.target.closest('[data-sheet-open]');
  if (!opener) return;
  const dialog = document.getElementById(opener.dataset.sheetOpen);
  if (dialog instanceof HTMLDialogElement) openSheet(dialog, opener);
});

const sheet = () => document.getElementById('confirm-sheet');

let asking = null;

/**
 * @param {{ question: string, label?: string, trigger?: Element | null }} ask
 * @returns {Promise<boolean>} true when confirmed
 */
export function confirmAction({ question, label, trigger }) {
  const dialog = sheet();
  // No sheet on the page (an error page without the layout): decline rather
  // than act without asking.
  if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(false);
  // One ask at a time: a second tap while the sheet is open is declined.
  if (asking) return Promise.resolve(false);

  const accept = dialog.querySelector('[data-confirm-accept]');
  dialog.querySelector('[data-confirm-question]').textContent = question;
  accept.dataset.defaultLabel ??= accept.textContent;
  accept.textContent = label || accept.dataset.defaultLabel;

  let confirmed = false;
  asking = new Promise((resolve) => {
    accept.onclick = () => {
      confirmed = true;
      dialog.close();
    };
    dialog.querySelector('[data-confirm-cancel]').onclick = () =>
      dialog.close();
    // After openSheet's own close listener, so focus is back on the
    // trigger before the confirmed request runs.
    openSheet(dialog, trigger);
    dialog.addEventListener(
      'close',
      () => {
        asking = null;
        resolve(confirmed);
      },
      { once: true },
    );
  });
  return asking;
}

const labelOf = (element) => element?.textContent?.trim() || undefined;

document.addEventListener('htmx:confirm', (event) => {
  const { question, elt, issueRequest } = event.detail;
  if (!question) return;
  event.preventDefault();
  void confirmAction({ question, label: labelOf(elt), trigger: elt }).then(
    (confirmed) => {
      if (confirmed) issueRequest(true);
    },
  );
});

/** Forms already confirmed, released once through the held submit's resend. */
const confirmedForms = new WeakSet();

// Bubble phase, like the inline handler this replaced: after the outbox's
// capture-phase holds (a deletion drains its queue before it is asked), and
// registered before submit-once.js (the layout loads this module first),
// which skips a submit that is already prevented.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.confirm) return;
  if (confirmedForms.delete(form)) return;
  event.preventDefault();
  const submitter = event.submitter;
  void confirmAction({
    question: form.dataset.confirm,
    label: labelOf(submitter),
    trigger: submitter ?? form,
  }).then((confirmed) => {
    if (!confirmed) return;
    confirmedForms.add(form);
    form.requestSubmit(submitter);
  });
});

// The server's refusal to delete unasked (src/web/announce.ts askFirst, #686):
// a page that judged the write reversible was stale. A yes posts it again with
// the fields the server named (`confirmed`).
document.addEventListener('closet:confirm', (event) => {
  const { question, label, action, fields } = event.detail;
  void confirmAction({ question, label, trigger: event.target }).then(
    (confirmed) => {
      if (!confirmed) return;
      window.htmx.ajax('post', action, {
        source: document.body,
        target: 'body',
        values: fields,
      });
    },
  );
});
