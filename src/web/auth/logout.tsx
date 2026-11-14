import { t } from '../i18n';
import { PostForm } from '../form';

/**
 * Signing out is a POST (a GET let any cross-site link or image sign someone
 * out). The one control is this form: Profile's last section, and the page
 * behind GET /auth/logout (old cached pages link there). A native post,
 * like every PostForm, which the service worker never relays (#542); the
 * page tells it first (`endsSession`), so its session caches go. Disabled
 * offline, where the post could not reach the server and the cookie would
 * stay.
 */

export const LOGOUT_PATH = '/auth/logout';

export function SignOutForm() {
  return (
    <PostForm id="logout-form" action={LOGOUT_PATH} endsSession>
      <button type="submit" class="btn btn-outline btn-error w-full">
        {t('LOGOUT')}
      </button>
    </PostForm>
  );
}
