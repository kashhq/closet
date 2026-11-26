/**
 * A shared photo is deleted from the device only once its look is saved
 * (#22d). The confirmation page (share-confirm.js) marks the stash it posts
 * in sessionStorage; the look's page, where a successful save lands
 * (src/web/inspiration/show-page.tsx), calls forgetSavedShare, which
 * deletes that stash and the mark. A save that fails (the login page, an
 * error page, a dropped connection) lands elsewhere, so going back still
 * finds the photo; the stash's own hour (SHARE_STASH_MAX_AGE_MS) or the
 * next share removes it otherwise.
 *
 * Its own module so the look's page loads nothing else of the share.
 */

const MARK = 'closet.share-saving';

/** Where the shared photo is stashed (share-target.ts's stash). */
interface Stash {
  cache: string;
  key: string;
}

export function markSaving(stash: Stash) {
  sessionStorage.setItem(MARK, JSON.stringify(stash));
}

/** The confirmation page, shown again: nothing of it is being saved. */
export function clearSaving() {
  sessionStorage.removeItem(MARK);
}

export async function forgetSavedShare() {
  const marked = sessionStorage.getItem(MARK);
  if (!marked) return;
  sessionStorage.removeItem(MARK);
  try {
    const { cache, key } = JSON.parse(marked) as Stash;
    await (await caches.open(cache)).delete(key);
    console.info('[share] the saved share was deleted from the device');
  } catch (err) {
    console.warn('[share] could not delete the saved share', err);
  }
}
