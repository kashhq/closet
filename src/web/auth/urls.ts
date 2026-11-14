/**
 * The account's pages. Profile is the avatar's page (layout/app-bar.tsx):
 * the account and every setting in sections, each an anchor on the page
 * (docs/plans/2026-09-26-redesign.md, "The app bar"). A section that links
 * or redirects to itself builds its URL here: `profileSection('sharing')`.
 */
export const PROFILE_PATH = '/auth/profile';

export function profileSection(id: string): string {
  return `${PROFILE_PATH}#${id}`;
}

/**
 * Profile's own sections, which its sub-pages' back arrows return to. The
 * features' sections name theirs beside them (sharing, weather, the week,
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

/** Profile › Devices: a native client's device tokens, revoked under it (token-routes.tsx). */
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
