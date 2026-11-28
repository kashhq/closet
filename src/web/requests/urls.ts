import { QUEUEABLE_ROUTES } from '../../offline-writes';

/**
 * "Ask your agent"'s pages (#1286; docs/plans/2026-11-27-mcp-oauth.md
 * section 3.6). The ask posts to REQUESTS_PATH, the outbox's `request` kind
 * (src/offline-writes.ts), so the two are one string.
 */
export const REQUESTS_PATH = QUEUEABLE_ROUTES.request;

export function requestUrl(id: number, suffix = ''): string {
  return `${REQUESTS_PATH}/${id}${suffix}`;
}

/** The list's next page: the requests older than `before` (an id keyset). */
export function olderRequestsUrl(before: number): string {
  return `${REQUESTS_PATH}?before=${before}`;
}
