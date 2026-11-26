import { t } from '../i18n';
import { Sheet } from './sheet';

/**
 * The one confirmation sheet (#686), in every page's body: what an
 * `hx-confirm` or a `PostForm`'s `confirm` asks through, driven by
 * public/js/confirm-sheet.js (which fills the question and the destructive
 * button's label, the trigger's own words, and opens it: `openSheet`). The
 * browser's confirm() box is the server host's unstyled title, and in the
 * installed app the most consequential tap showed it. Cancel is focused
 * first, so Enter on an opened sheet never deletes; Escape and a tap
 * outside (SheetBackdrop) cancel. Static markup, so a cached tab root stays
 * byte for byte the same.
 */
export function ConfirmSheet() {
  return (
    <Sheet
      id="confirm-sheet"
      kind="choice"
      labelledBy="confirm-sheet-question"
      gap={3}
      dismiss="cancel"
    >
      <p
        id="confirm-sheet-question"
        class="text-base"
        data-confirm-question
      ></p>
      <div class="modal-action mt-0">
        <button
          type="button"
          class="btn btn-ghost"
          data-confirm-cancel
          autofocus
        >
          {t('CANCEL')}
        </button>
        <button type="button" class="btn btn-error" data-confirm-accept>
          {t('CONFIRM_ACTION')}
        </button>
      </div>
    </Sheet>
  );
}
