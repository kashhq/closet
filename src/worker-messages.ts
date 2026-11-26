/**
 * Every message the pages and the service worker post each other, by its
 * `type`. Both sides import these names (views/assets/src-sw.ts, the page
 * modules), so a rename or a name only one side knows fails the type check
 * instead of going silent. Pure: no DOM, no worker globals.
 */

/** Page to worker; the worker's handler is the `message` listener in src-sw.ts. */
export const PAGE_MESSAGES = {
  /** The waiting worker takes over (sent by workbox-window's messageSkipWaiting). */
  skipWaiting: 'SKIP_WAITING',
  /** A page this active worker does not control asks to be claimed. */
  claimClients: 'CLAIM_CLIENTS',
  /** A cached page asks for the server's copy; answered on the sent MessagePort. */
  revalidatePage: 'REVALIDATE_PAGE',
  /** The page asks for a run of the offline warm-up. */
  warmPages: 'WARM_PAGES',
  /** A sign-in, sign-out or account change is leaving the page. */
  sessionEnding: 'SESSION_ENDING',
  /**
   * After a drain saved queued writes: `{ type, paths }`, the saved records'
   * paths. The worker refetches the cached pages that show them
   * (`showsQueuedWrite`), so a page reopened offline later shows the synced
   * state, not the one cached before the tap (src-sw.ts, refetchSyncedPages).
   * The pages on screen take the server's copy themselves
   * (OUTBOX_SYNCED_EVENT, src/offline-writes.ts).
   */
  outboxSynced: 'OUTBOX_SYNCED',
} as const;

/** Worker to page. */
export const WORKER_MESSAGES = {
  /** Which build is this page of? Answered on the sent MessagePort. */
  buildQuery: 'BUILD_QUERY',
} as const;

export type PageMessageType =
  (typeof PAGE_MESSAGES)[keyof typeof PAGE_MESSAGES];
export type WorkerMessageType =
  (typeof WORKER_MESSAGES)[keyof typeof WORKER_MESSAGES];

/** A page-to-worker message that carries nothing but its type. */
export interface BareMessage {
  type: Exclude<PageMessageType, 'REVALIDATE_PAGE' | 'OUTBOX_SYNCED'>;
}

export interface RevalidatePageMessage {
  type: typeof PAGE_MESSAGES.revalidatePage;
  url: string;
  fragment: boolean;
}

export interface OutboxSyncedMessage {
  type: typeof PAGE_MESSAGES.outboxSynced;
  paths: string[];
}

export type PageMessage =
  | BareMessage
  | RevalidatePageMessage
  | OutboxSyncedMessage;
