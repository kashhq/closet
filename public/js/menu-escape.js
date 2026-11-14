/**
 * Escape closes an open app bar menu (the <details class="dropdown"> the
 * title, a scope, the garment's and the outfit's ⋯ put in the bar): a native
 * <details> has no keyboard dismissal, so a keyboard or Switch Control user
 * could only toggle its summary again. Focus goes back to the summary, as a
 * dialog's does. An Escape inside a dialog is the dialog's (the confirm sheet
 * opened from a menu returns focus to the menu's button, which must still be
 * there). One document listener at module evaluation (boosted navigations
 * swap only the body).
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (event.target instanceof Element && event.target.closest('dialog')) return;
  const open = document.querySelector('.app-bar details[open]');
  if (!open) return;
  open.removeAttribute('open');
  open.querySelector(':scope > summary')?.focus();
});
