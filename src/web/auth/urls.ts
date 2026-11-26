/**
 * The account's pages. Profile is the avatar's page (layout/app-bar.tsx):
 * an index of the account's settings, one row each, every row an anchor
 * (#728, docs/decisions.md 2026-11-14). A setting's own page goes back to
 * its row: `profileSection('sharing')`. The rows keep the ids the sections
 * had, so a link from before the split (`/auth/profile#sharing`) still
 * lands on the row that opens the page.
 */
export const PROFILE_PATH = '/auth/profile';

export function profileSection(id: string): string {
  return `${PROFILE_PATH}#${id}`;
}

/**
 * A setting's own page under Profile (`/auth/profile/<one segment>`: style,
 * sizes, sharing, weather, week, notifications), which sign-in may return
 * to (return-to.ts), as may Devices (`DEVICES_PATH`, not under Profile
 * by path). Their fragments and writes are deeper or POST-only.
 */
export const PROFILE_PAGE = /^\/auth\/profile\/[a-z-]+$/;

/**
 * Profile's own rows, which their pages' back arrows return to. The
 * features' rows name theirs beside them (sharing, weather, the week,
 * notifications).
 */
export const ACCOUNT_SECTION_ID = 'account';
export const STYLE_SECTION_ID = 'style';
export const AGENT_ACCESS_SECTION_ID = 'agent-access';
export const DEVICES_SECTION_ID = 'devices';
export const EXPORT_SECTION_ID = 'export';
export const SIGN_OUT_SECTION_ID = 'sign-out';

/**
 * Sign out everywhere (#700): ends every other session of the account
 * behind the current password; linked from Profile › Sign out.
 */
export const SIGN_OUT_EVERYWHERE_PATH = '/auth/sign-out-everywhere';

/** Agent access: the MCP endpoint's personal access tokens (token-routes.tsx). */
export const TOKENS_PATH = '/auth/tokens';

/** Profile › Devices: a native client's device tokens, listed and revoked here (token-routes.tsx). */
export const DEVICES_PATH = '/auth/devices';

/**
 * A revoke redirect's `?revoked=` / `?deviceRevoked=` (1: revoked, 0:
 * nothing to revoke) as its notice; any other value shows nothing (URL
 * state, never a 400).
 */
export function revokeNotice(
  value: string | undefined,
): 'revoked' | 'revoke-gone' | undefined {
  if (value === '1') return 'revoked';
  if (value === '0') return 'revoke-gone';
  return undefined;
}
