import { t } from '../i18n';
import { SavedToast, StripFlags } from '../layout/parts';
import { ALREADY_SAVED_FLAG, type AlreadySaved } from './urls';

/**
 * "Already saved" after a pick that found its outfit (a double tap, a
 * retried post), or "Saved the agent's outfit" when it was one of the agent's
 * proposals the save made the owner's (#335): on the outfit page for a
 * save, on the week for a plan. Nothing without `kind`; the flag is
 * stripped from the address either way, so a reload does not replay it.
 */
export function AlreadySavedToast({
  kind,
}: {
  kind: AlreadySaved | undefined;
}) {
  return (
    <>
      {kind && (
        <SavedToast
          id="already-saved-toast"
          text={t(
            kind === 'agent' ? 'gallery.SAVED_AGENT' : 'gallery.ALREADY_SAVED',
          )}
        />
      )}
      <StripFlags names={[ALREADY_SAVED_FLAG]} />
    </>
  );
}
