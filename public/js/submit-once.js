/**
 * A native post submits once (the double-submit guard of every PostForm,
 * src/web/form.tsx, marked `data-submit-once`): a double tap or an
 * impatient second tap on a slow network would otherwise post twice (two
 * outfits from one gallery pick). The server stays the real guard where a
 * duplicate matters (pickIdea); this spares the second request.
 *
 * - The first submit marks the form; a second one while marked is cancelled.
 * - Its submit buttons (its `elements`, so those outside it joined through
 *   `form=` too) are disabled a tick later: disabling the submitter in
 *   the submit event itself would drop its name=value from the post (the
 *   plan page's outfitId, the gallery's feeling).
 * - Only buttons enabled at that moment are disabled, marked `submitDisabled`,
 *   and only those are re-enabled: a control the offline guard
 *   (connectivity.js, `offlineDisabled`) or the page disabled keeps its state.
 * - Everything is released when the page comes back from the back/forward
 *   cache (pageshow persisted: the post left, the user returned) and on an
 *   htmx request error. A refused post re-renders a new page (4xx), so it
 *   starts unmarked.
 *
 * Listeners sit on the document once, at module evaluation (a module runs
 * once per document; boosted navigations swap only the body).
 */

const FORM_MARK = 'submitting';
const BUTTON_MARK = 'submitDisabled';

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !('submitOnce' in form.dataset)) {
    return;
  }
  // A confirm() the person declined cancelled it already: nothing is sent.
  if (event.defaultPrevented) return;
  if (FORM_MARK in form.dataset) {
    event.preventDefault();
    return;
  }
  form.dataset[FORM_MARK] = '';
  // The form's `elements`, never a query inside it: they include the
  // controls outside it that name it in `form=` (an action bar's Save,
  // Laundry's Mark washed, select mode's verbs).
  setTimeout(() => {
    for (const control of form.elements) {
      if (isSubmitter(control)) disable(control);
    }
  });
});

function isSubmitter(control) {
  return (
    (control instanceof HTMLButtonElement ||
      control instanceof HTMLInputElement) &&
    control.type === 'submit'
  );
}

function disable(button) {
  if (button.disabled) return;
  button.disabled = true;
  button.dataset[BUTTON_MARK] = '';
}

function release() {
  for (const button of document.querySelectorAll(
    `[data-submit-disabled]`,
  )) {
    button.disabled = false;
    delete button.dataset[BUTTON_MARK];
  }
  for (const form of document.querySelectorAll('form[data-submitting]')) {
    delete form.dataset[FORM_MARK];
  }
}

window.addEventListener('pageshow', (event) => {
  if (event.persisted) release();
});
document.addEventListener('htmx:responseError', release);
document.addEventListener('htmx:sendError', release);
