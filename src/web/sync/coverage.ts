/**
 * What the changes feed covers (#716), as data: every GET of /api/v1 is
 * either backed by the feed (a client that keeps the named feed resources
 * can answer it offline, deriving what the feed shapes leave out) or online
 * only, with the reason. Rendered into listChanges' description
 * (api-routes.ts), so the contract states it; coverage.spec.ts fails on a
 * GET of openapi.json in no row or two, a row naming an operation that is
 * not there, and a feed resource no row names.
 */

interface CoverageRowBase {
  /** What a client screen shows, in the contract's words. */
  what: string;
  /** The GET operations that answer it (operationId); none for a feed-only resource. */
  reads: readonly string[];
}

export type CoverageRow = CoverageRowBase &
  (
    | {
        /** The feed resources (FEED's `name`s) a client derives it from. */
        feed: readonly string[];
      }
    | {
        /** Why it is fetched on demand: what it reads that the feed does not carry. */
        onlineOnly: string;
      }
  );

/** The feed's own read: neither of the two, the means of the first. */
export const FEED_OPERATION = 'listChanges';

export const READ_COVERAGE: readonly CoverageRow[] = [
  {
    what: "Garments (a share's too)",
    reads: ['listGarments', 'getGarment'],
    feed: ['garment', 'wear', 'capsule'],
  },
  {
    what: 'Wears, washes and away',
    reads: [],
    feed: ['wear', 'garment'],
  },
  {
    what: 'Outfits, the agent’s proposals included',
    reads: ['listOutfits', 'getOutfit'],
    feed: ['outfit', 'garment', 'calendarEntry'],
  },
  {
    what: 'The calendar and its selfies',
    reads: ['listCalendarEntries'],
    feed: ['calendarEntry', 'outfit', 'selfie'],
  },
  {
    what: "Plan my week's batches (for their undo)",
    reads: [],
    feed: ['weekPlan'],
  },
  {
    what: 'The week template',
    reads: ['getWeekTemplate'],
    feed: ['weekTemplate'],
  },
  {
    what: 'Trips and their packing',
    reads: ['listTrips', 'getTrip'],
    feed: ['trip', 'outfit', 'garment', 'calendarEntry'],
  },
  {
    what: "Capsules (a share's too)",
    reads: ['listCapsules', 'getCapsule'],
    feed: ['capsule', 'garment'],
  },
  {
    what: 'Sizes and measurements',
    reads: ['getSizes', 'listBrandSizes'],
    feed: ['brandSize', 'measurements'],
  },
  {
    what: 'The style profile and its outfit rules',
    reads: ['getStyleProfile'],
    feed: ['styleProfile'],
  },
  {
    what: 'Requests to your agent',
    reads: ['listAgentRequests', 'getAgentRequest'],
    // The agent's name is the read's: no request write follows a token's rename.
    feed: ['agentRequest', 'garment', 'trip'],
  },
  {
    what: 'Today',
    reads: ['getToday'],
    onlineOnly:
      "its forecast and suggestions; its entries are the feed's calendarEntry",
  },
  {
    what: 'Ideas, clashes and avoided pairs',
    reads: ['listIdeas', 'getGoesWith'],
    onlineOnly:
      "generated on the server (the seeded generator, the forecast), and the avoided pairs are not synced; the outfit rules are the feed's styleProfile",
  },
  {
    what: 'The wishlist: the agent’s inbox and needs',
    reads: ['getWishlist', 'getWishlistNeed'],
    onlineOnly:
      "the needs and suggestions are not synced; its garments are the feed's garment",
  },
  {
    what: 'Saved looks and their photos',
    reads: ['listLooks', 'getLook', 'getLookRecreation', 'getLookPhoto'],
    onlineOnly: 'not synced (owner decision, 2026-11-13)',
  },
  {
    what: 'Selfie photos',
    reads: ['getSelfiePhoto'],
    onlineOnly: 'image bytes, fetched when shown',
  },
  {
    what: "Insights and the year's recap",
    reads: ['getInsights', 'getRecap'],
    onlineOnly: 'figures computed on the server over the whole history',
  },
  {
    what: "Weather, places and a trip's forecast",
    reads: ['getWeather', 'searchPlaces', 'getTripWeather'],
    onlineOnly: 'a live forecast and the weather settings',
  },
  {
    what: 'Shared wardrobes',
    reads: ['listSharedWardrobes'],
    onlineOnly:
      "who shares with you and how; a sync's `snapshot` lists their ids",
  },
  {
    what: "You, and this API's spec",
    reads: ['getMe', 'getOpenApi'],
    onlineOnly: "the account and the server's features, read at sign-in",
  },
];

/** READ_COVERAGE as a markdown table, for listChanges' description. */
export function coverageTable(rows: readonly CoverageRow[]): string {
  const code = (names: readonly string[]) =>
    names.map((name) => `\`${name}\``).join(', ');
  return [
    '| What | Reads | Kept fresh by |',
    '| --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.what} | ${row.reads.length > 0 ? code(row.reads) : 'none: the feed only'} | ${'feed' in row ? `this feed: ${code(row.feed)}` : `fetching it online: ${row.onlineOnly}`} |`,
    ),
  ].join('\n');
}
