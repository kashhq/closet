/**
 * The API's parity manifest (#191; docs/plans/2026-11-12-json-api.md
 * section 5): every /api/v1 operation, and how every page write route and
 * every MCP write tool relates to one. A feature is done when its domain
 * function has a page caller, an API caller, and an MCP caller where an
 * agent needs it (AGENTS.md). test/integration/api-parity.spec.ts holds the
 * app to this file.
 */

/**
 * Every /api/v1 route's operationId. apiPlugin refuses a route whose id is
 * not here (requireContract), so a twin below can name only a real one, and
 * a typo fails tsc.
 */
export const OPERATIONS = [
  'getOpenApi',
  'signIn',
  'signOut',
  'getMe',
  // #192a: the wardrobe's reads (no page write twins them; their matrix
  // routes are GET /wardrobe and GET /wardrobe/:id).
  'listGarments',
  'getGarment',
  // #192b: the garment writes, each its page route's twin (PAGE_WRITES).
  'createGarment',
  'updateGarment',
  'deleteGarment',
  'setGarmentStatus',
  'setGarmentCondition',
  'cloneGarment',
  'addGarmentCopies',
  'tagGarment',
  'bulkUpdateGarments',
  // #192c: the photo, the repair log and the link import.
  'replaceGarmentPhoto',
  'rotateGarmentPhoto',
  'saveGarmentCutout',
  'retryGarmentCutout',
  'logGarmentRepair',
  'deleteGarmentRepair',
  'importGarmentFromLink',
  // #193a: wears, washes and away, then outfits.
  'wearGarment',
  'unwearGarment',
  'washGarment',
  'washGarments',
  'setGarmentAway',
  'listOutfits',
  'getOutfit',
  'createOutfit',
  'updateOutfit',
  'deleteOutfit',
  'reactToOutfit',
  // #193b: the calendar, Today's Wear this, the week plan and its template.
  'listCalendarEntries',
  'createCalendarEntry',
  'replaceCalendarEntryOutfit',
  'setCalendarEntryWorn',
  'deleteCalendarEntry',
  'wearOutfit',
  'planWeek',
  'undoWeekPlan',
  'getWeekTemplate',
  'saveWeekTemplate',
  // #194a: trips and packing.
  'listTrips',
  'getTrip',
  'createTrip',
  'updateTrip',
  'deleteTrip',
  'addTripOutfit',
  'removeTripOutfit',
  'wearTripOutfit',
  'setTripGarmentPacked',
  'addTripItem',
  'setTripItemPacked',
  'removeTripItem',
  'copyTripItems',
  // #194b: the wishlist (Muse's inbox, its decisions, "Bought it") and
  // capsules. A new wishlist item, and "Bought a different one", are
  // createGarment's (`destination`, `boughtForNeedId`).
  'getWishlist',
  'markWishlistSeen',
  'getWishlistNeed',
  'decideWishlistPick',
  'decideWishlistNeed',
  'buyWishlistItem',
  'returnGarment',
  'getGoesWith',
  'listCapsules',
  'getCapsule',
  'createCapsule',
  'updateCapsule',
  'deleteCapsule',
  'changeCapsuleMembers',
  'changeGarmentCapsules',
  // #193c: ideas (the Ideas tab and Styling's Shuffle), the pick, clashes,
  // the temperature feedback and outfit selfies.
  'listIdeas',
  'pickOutfit',
  'avoidGarmentPair',
  'allowGarmentPair',
  'sendTemperatureFeedback',
  'setCalendarEntrySelfie',
  'deleteSelfie',
  'getSelfiePhoto',
  // #193d: saved looks (Inspiration), their pieces, the match view's read
  // and its two writes, and the photo's bytes to the owner's device.
  'listLooks',
  'createLook',
  'importLookFromLink',
  'getLook',
  'updateLook',
  'deleteLook',
  'replaceLookPhoto',
  'addLookPiece',
  'setLookPieces',
  'updateLookPiece',
  'deleteLookPiece',
  'getLookRecreation',
  'saveLookAsOutfit',
  'findLookPiece',
  'getLookPhoto',
  // #195a: Today's read, and the weather: the forecast where you are and a
  // trip's, the settings, the place search and a trip's destination.
  'getToday',
  'getWeather',
  'searchPlaces',
  'setWeatherHome',
  'clearWeatherHome',
  'setWeatherHere',
  'clearWeatherHere',
  'setTemperatureUnit',
  'resetTemperatureOffset',
  'getTripWeather',
  'setTripDestination',
  // #588: insights and the year in review (reads), sizes, measurements and
  // the brand hint.
  'getInsights',
  'getRecap',
  'getSizes',
  'saveMeasurements',
  'setLengthUnit',
  'listBrandSizes',
  'addBrandSize',
  'updateBrandSize',
  'deleteBrandSize',
  // #195c: the style profile and its outfit rules, and the wardrobes shared
  // with you (sharing admin stays web-only: SHARING_ADMIN).
  'getStyleProfile',
  'saveStyleProfile',
  'addOutfitRule',
  'deleteOutfitRule',
  'listSharedWardrobes',
  // #196b: the changes feed (a native client's sync; no page twin).
  'listChanges',
] as const;
export type OperationId = (typeof OPERATIONS)[number];

export function isOperationId(id: string): id is OperationId {
  return (OPERATIONS as readonly string[]).includes(id);
}

/**
 * The endpoint issues that will give a pending route its twin (plan section
 * 6). An issue leaves this list when its last pending route does.
 */
type EndpointIssue =
  /** Insights, sizes. */
  | '#195'
  /** A garment's or outfit's public link: Share and Stop sharing (#669). */
  | '#959';

/**
 * A write's API twin: one operation, or each of the few a write that takes
 * two shapes splits into (POST /calendar plans an outfit, or with `replace`
 * changes an entry's; schedule_outfit likewise), any of which its matrix
 * route's `api` may reach.
 */
export type Twin = OperationId | readonly [OperationId, ...OperationId[]];

/** A twin's operations, one or several. */
export function twinOperations(twin: Twin): readonly OperationId[] {
  return typeof twin === 'string' ? [twin] : twin;
}

/**
 * How a write relates to the API, exactly one of:
 *  - `api`: the twin's operationId (or ids, Twin); its matrix cases replay
 *    on the twin (the matrix route's `api`) and must answer the same outcome;
 *  - `webOnly`: why a native client never gets it (plan section 6, owner
 *    decision 9: step-up credentials, sharing admin, exports, the browser's
 *    own plumbing);
 *  - `pending`: the endpoint issue that adds its twin.
 */
export type Parity =
  | { readonly api: Twin }
  | { readonly webOnly: string }
  | { readonly pending: EndpointIssue };

/**
 * MCP's view: a tool's API twin, the endpoint issue that adds it, or why
 * only an agent calls it (Muse's provenance-carrying suggestions). Listed,
 * not required: MCP and API parity is not retrofitted (#191).
 */
export type ToolParity =
  | { readonly api: Twin }
  | { readonly agentOnly: string }
  | { readonly pending: EndpointIssue };

// The web-only reasons (plan section 6, owner decision 9), each said once.
const STEP_UP = {
  webOnly:
    'step-up: changes or hands out a credential behind the current password, which a token never stands in for',
} as const;
const AGENT_ACCESS = {
  webOnly:
    'agent access and the Devices list: managing the credentials themselves',
} as const;
const SHARING_ADMIN = {
  webOnly: 'sharing admin: invites, accepting, declining and removing a share',
} as const;
const ORDER_MAIL = {
  webOnly: 'the order-email import: a review list of the household inbox',
} as const;
const MULTI_ADD = { webOnly: 'the multi-add drafts (plan section 6)' } as const;
// Select mode's Archive and Mark washed (#677) act on the grid's selection,
// or on "Select all" resolved from its filters, which only the page holds:
// a client keeps its own selection and calls the writes that take ids.
const GRID_SELECTION = {
  webOnly:
    "select mode's verbs over the grid's selection or filters: a client archives through PUT /garments/{id}/status and washes through POST /garments/washes",
} as const;
const WEB_PUSH = {
  webOnly:
    "Web Push: the browser's subscription and its reminders (a native client's push is APNs, #197)",
} as const;
const BROWSER_TELEMETRY = {
  webOnly: "the browser's own telemetry: web vitals and client errors",
} as const;
const FORM_FRAGMENT = {
  webOnly: "redraws part of a page's form and writes nothing",
} as const;
const FORM_STAGING = {
  webOnly:
    "stages a photo for the add form a person reviews before saving: the API saves at once (POST /garments, POST /garments/link-imports) and a garment's photo is PUT /garments/{id}/photo (plan section 7)",
} as const;

type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Every page route that is not a GET, keyed `METHOD /template` as Fastify
 * registered it (every optional feature on), a POST that only renders
 * included. A new one fails the parity spec until it is classified here; a
 * removed one fails until its line goes.
 */
export const PAGE_WRITES: Readonly<
  Record<`${WriteMethod} /${string}`, Parity>
> = {
  // Account and credentials.
  'POST /auth/login': { api: 'signIn' },
  'POST /auth/logout': { api: 'signOut' },
  'POST /auth/register': {
    webOnly:
      'account creation: a native client signs in to an account made here',
  },
  'POST /auth/validate/register': FORM_FRAGMENT,
  'POST /auth/validate/update-email': FORM_FRAGMENT,
  'POST /auth/change-password': STEP_UP,
  'POST /auth/update-email': STEP_UP,
  'POST /auth/delete-account': STEP_UP,
  'POST /auth/sign-out-everywhere': STEP_UP,
  'POST /auth/tokens': STEP_UP,
  'POST /auth/tokens/:id/revoke': AGENT_ACCESS,
  'POST /auth/devices/:id/revoke': AGENT_ACCESS,

  // The wardrobe.
  'POST /wardrobe': { api: 'createGarment' },
  'POST /wardrobe/properties-fragment': FORM_FRAGMENT,
  'POST /wardrobe/:id': { api: 'updateGarment' },
  'DELETE /wardrobe/:id': { api: 'deleteGarment' },
  'POST /wardrobe/:id/archive': { api: 'setGarmentStatus' },
  'POST /wardrobe/:id/restore': { api: 'setGarmentStatus' },
  'POST /wardrobe/:id/share': { pending: '#959' },
  'POST /wardrobe/:id/share/stop': { pending: '#959' },
  'POST /wardrobe/:id/clone': { api: 'cloneGarment' },
  'POST /wardrobe/:id/copies': { api: 'addGarmentCopies' },
  'POST /wardrobe/:id/condition': { api: 'setGarmentCondition' },
  'POST /wardrobe/:id/repairs': { api: 'logGarmentRepair' },
  'POST /wardrobe/:id/repairs/:repairId/delete': {
    api: 'deleteGarmentRepair',
  },
  'POST /wardrobe/:id/tag': { api: 'tagGarment' },
  'POST /wardrobe/bulk': { api: 'bulkUpdateGarments' },
  'POST /wardrobe/bulk/archive': GRID_SELECTION,
  'POST /wardrobe/bulk/washed': GRID_SELECTION,
  'POST /wardrobe/bulk/capsule': { api: 'changeCapsuleMembers' },
  'POST /wardrobe/:id/photo': { api: 'replaceGarmentPhoto' },
  'POST /wardrobe/:id/photo/rotate': { api: 'rotateGarmentPhoto' },
  'POST /wardrobe/:id/nobg': { api: 'saveGarmentCutout' },
  'POST /wardrobe/:id/cutout/retry': { api: 'retryGarmentCutout' },
  'POST /wardrobe/new/photo': FORM_STAGING,
  'POST /wardrobe/new/drafts/discard': MULTI_ADD,
  'POST /wardrobe/new/from-link': { api: 'importGarmentFromLink' },
  'POST /wardrobe/new/from-link/photo': FORM_STAGING,
  'POST /wardrobe/orders/:id/add': ORDER_MAIL,
  'POST /wardrobe/orders/:id/dismiss': ORDER_MAIL,

  // Wears, washes and away.
  'POST /wardrobe/:id/wear': { api: 'wearGarment' },
  'POST /wardrobe/:id/washed': { api: 'washGarment' },
  'POST /wardrobe/:id/away': { api: 'setGarmentAway' },
  'POST /laundry': { api: 'washGarments' },
  'POST /today/wear': { api: 'wearOutfit' },

  // Outfits, styling and ideas.
  'POST /outfits': { api: 'createOutfit' },
  'POST /outfits/:id': { api: 'updateOutfit' },
  'DELETE /outfits/:id': { api: 'deleteOutfit' },
  'POST /outfits/:id/share': { pending: '#959' },
  'POST /outfits/:id/share/stop': { pending: '#959' },
  'POST /outfits/:id/love': { api: 'reactToOutfit' },
  'POST /outfits/:id/dismiss': { api: 'reactToOutfit' },
  'POST /outfits/:id/undo': { api: 'reactToOutfit' },
  // A pick goes where its destination says (pickTo): saved or planned, an
  // entry's place (`replace`), a trip (POST /trips/{id}/outfits with the
  // garments). Styling's Save is a pick too, or with Include picks on a
  // slot write (createOutfit), or an edit (the outfit's PATCH); its
  // Shuffle and "Add row" are GETs (GET /ideas).
  'POST /styling': {
    api: [
      'pickOutfit',
      'replaceCalendarEntryOutfit',
      'addTripOutfit',
      'createOutfit',
      'updateOutfit',
    ],
  },
  'POST /outfits/ideas/pick': {
    api: ['pickOutfit', 'replaceCalendarEntryOutfit', 'addTripOutfit'],
  },
  'POST /outfits/ideas/avoid': { api: 'avoidGarmentPair' },
  'POST /outfits/ideas/allow': { api: 'allowGarmentPair' },
  'POST /outfits/ideas/feedback': { api: 'sendTemperatureFeedback' },

  // Saved looks (#22, #193d). The share confirmation's Save is POST
  // /inspiration (createLook's twin); a native client's own share sheet
  // posts there itself.
  'POST /inspiration': { api: 'createLook' },
  'POST /inspiration/link': { api: 'importLookFromLink' },
  'POST /inspiration/share': {
    webOnly:
      "the installed web app's share target: the service worker answers Android's post on the phone and the server's fallback writes nothing, answering a redirect (a native app's share sheet saves through createLook or importLookFromLink)",
  },
  'POST /inspiration/:id': { api: 'updateLook' },
  'POST /inspiration/:id/delete': { api: 'deleteLook' },
  'POST /inspiration/:id/photo': { api: 'replaceLookPhoto' },
  'POST /inspiration/:id/pieces': { api: 'addLookPiece' },
  'POST /inspiration/:id/pieces/:position': { api: 'updateLookPiece' },
  'POST /inspiration/:id/pieces/:position/delete': { api: 'deleteLookPiece' },
  'POST /inspiration/:id/pieces/:position/find': { api: 'findLookPiece' },
  'POST /inspiration/:id/recreate/outfit': { api: 'saveLookAsOutfit' },

  // The calendar, the week plan and selfies.
  'POST /calendar': {
    api: ['createCalendarEntry', 'replaceCalendarEntryOutfit'],
  },
  'POST /calendar/:id/delete': { api: 'deleteCalendarEntry' },
  // Undo's post (#686): the page's toast carries the removed entry's fields;
  // a client restores by createCalendarEntry with what it just deleted.
  'POST /calendar/restore': {
    webOnly:
      'the toast Undo of a removal: a native client undoes with createCalendarEntry',
  },
  'POST /calendar/:id/worn': { api: 'setCalendarEntryWorn' },
  'POST /calendar/:id/selfie': { api: 'setCalendarEntrySelfie' },
  'POST /selfies/:id/delete': { api: 'deleteSelfie' },
  'POST /calendar/plan-week': { api: 'planWeek' },
  'POST /calendar/plan-week/:id/undo': { api: 'undoWeekPlan' },
  'POST /auth/profile/week': { api: 'saveWeekTemplate' },

  // Trips and packing; the destination is located from GET /weather/places.
  'POST /trips': { api: 'createTrip' },
  'POST /trips/:id': { api: 'updateTrip' },
  'DELETE /trips/:id': { api: 'deleteTrip' },
  'POST /trips/:id/destination': { api: 'setTripDestination' },
  'POST /trips/:id/outfits': { api: 'addTripOutfit' },
  'POST /trips/:id/outfits/:tripOutfitId/delete': {
    api: 'removeTripOutfit',
  },
  'POST /trips/:id/outfits/:tripOutfitId/wear': {
    api: 'wearTripOutfit',
  },
  'POST /trips/:id/items': { api: 'addTripItem' },
  'POST /trips/:id/items/copy': { api: 'copyTripItems' },
  'POST /trips/:id/items/packed': { api: 'setTripItemPacked' },
  'POST /trips/:id/items/:itemId/delete': { api: 'removeTripItem' },
  'POST /trips/:id/packed': { api: 'setTripGarmentPacked' },

  // The wishlist (Muse's inbox).
  'POST /wardrobe/:id/choose': { api: 'decideWishlistPick' },
  'POST /wardrobe/:id/dismiss': { api: 'decideWishlistPick' },
  'POST /wardrobe/:id/undo': { api: 'decideWishlistPick' },
  'POST /wardrobe/:id/bought': { api: 'buyWishlistItem' },
  'POST /wardrobe/:id/returned': { api: 'returnGarment' },
  'POST /wardrobe/wishlist/needs/:id/dismiss': { api: 'decideWishlistNeed' },
  'POST /wardrobe/wishlist/needs/:id/undo': { api: 'decideWishlistNeed' },
  'POST /wardrobe/wishlist/seen': { api: 'markWishlistSeen' },

  // Capsules.
  'POST /capsules': { api: 'createCapsule' },
  'POST /capsules/:id': { api: 'updateCapsule' },
  'DELETE /capsules/:id': { api: 'deleteCapsule' },
  'POST /capsules/:id/garments': { api: 'changeCapsuleMembers' },
  'POST /wardrobe/:id/capsules': { api: 'changeGarmentCapsules' },

  // Sizes, the style profile, the weather.
  'POST /auth/profile/sizes/measurements': { api: 'saveMeasurements' },
  'POST /auth/profile/sizes/unit': { api: 'setLengthUnit' },
  'POST /auth/profile/sizes/brands': { api: 'addBrandSize' },
  'POST /auth/profile/sizes/brands/:id': { api: 'updateBrandSize' },
  'POST /auth/profile/sizes/brands/:id/delete': { api: 'deleteBrandSize' },
  'POST /auth/profile/style': { api: 'saveStyleProfile' },
  'POST /auth/profile/style/rules': { api: 'addOutfitRule' },
  'POST /auth/profile/style/rules/:id/delete': { api: 'deleteOutfitRule' },
  'POST /weather/home': { api: 'setWeatherHome' },
  'POST /weather/home/clear': { api: 'clearWeatherHome' },
  'POST /weather/here': { api: 'setWeatherHere' },
  'POST /weather/here/clear': { api: 'clearWeatherHere' },
  'POST /weather/unit': { api: 'setTemperatureUnit' },
  'POST /weather/feedback': { api: 'sendTemperatureFeedback' },
  'POST /weather/offset/reset': { api: 'resetTemperatureOffset' },

  // Sharing admin.
  'POST /wardrobe-share/create-invite-link': SHARING_ADMIN,
  'POST /wardrobe-share/invite/:token/accept': SHARING_ADMIN,
  'POST /wardrobe-share/invite/:token/decline': SHARING_ADMIN,
  'POST /wardrobe-share/:id/remove': SHARING_ADMIN,

  // The browser's plumbing.
  'POST /push/subscribe': WEB_PUSH,
  'POST /push/unsubscribe': WEB_PUSH,
  'POST /push/test': WEB_PUSH,
  'POST /push/reminders': WEB_PUSH,
  'POST /push/reminders/form': WEB_PUSH,
  'POST /metrics/vitals': BROWSER_TELEMETRY,
  'POST /errors/client': BROWSER_TELEMETRY,
};

const MUSE_ROUND = {
  agentOnly:
    "Muse's suggestion round: what the agent proposes carries its token, and the owner decides it in the inbox",
} as const;

/**
 * The rows a tool's write stamps with the calling token (#682,
 * src/web/write-origin.ts): `outfit` (outfit.proposed_by_token_id),
 * `calendarEntry` (outfit_calendar planned_by 'agent' + its token),
 * `tripOutfit`, `garment` (garment.suggested_by_token_id).
 */
export type Stamped = 'outfit' | 'calendarEntry' | 'tripOutfit' | 'garment';

/**
 * What a writing tool leaves of the agent: the rows it stamps (each with a
 * scenario in test/integration/mcp-attribution.spec.ts, which fails one
 * that writes no stamp, and a `none` tool that writes one), why it stamps
 * nothing, or Muse's round, whose provenance is its own (mcp-muse.spec.ts).
 */
export type Attribution =
  | { readonly stamps: readonly Stamped[] }
  | { readonly none: string }
  | { readonly museRound: true };

export type McpWrite = ToolParity & { readonly attribution: Attribution };

const EDITS = {
  none: 'an edit of what exists: who made it does not change',
} as const;
const RECORDS = {
  none: "the person's record (a wear, a wash): never the agent's choice",
} as const;
const MUSE = { museRound: true } as const;

/** Every MCP tool with `writes: true`, by name (src/web/mcp/tools/). */
export const MCP_WRITES: Readonly<Record<string, McpWrite>> = {
  update_garment: { api: 'updateGarment', attribution: EDITS },
  add_garment_copy: { api: 'addGarmentCopies', attribution: EDITS },
  add_garment_from_link: {
    api: 'importGarmentFromLink',
    attribution: { stamps: ['garment'] },
  },
  create_outfit: {
    api: 'createOutfit',
    attribution: { stamps: ['outfit', 'calendarEntry'] },
  },
  schedule_outfit: {
    api: ['createCalendarEntry', 'replaceCalendarEntryOutfit'],
    attribution: { stamps: ['calendarEntry'] },
  },
  pick_outfit: {
    api: 'pickOutfit',
    attribution: { stamps: ['outfit', 'calendarEntry'] },
  },
  mark_worn: {
    api: ['setCalendarEntryWorn', 'wearGarment'],
    attribution: RECORDS,
  },
  mark_washed: { api: 'washGarments', attribution: RECORDS },
  plan_week: {
    api: 'planWeek',
    attribution: {
      none: "the week planner's choice (auto), whoever pressed the button: its re-plan may still swap it",
    },
  },
  add_inspiration: {
    api: 'importLookFromLink',
    attribution: { none: "a saved look is the owner's own library" },
  },
  set_inspiration_pieces: { api: 'setLookPieces', attribution: EDITS },
  set_capsule_membership: { api: 'changeCapsuleMembers', attribution: EDITS },
  plan_trip_outfit: {
    api: 'addTripOutfit',
    attribution: { stamps: ['tripOutfit', 'outfit'] },
  },
  create_option_group: { ...MUSE_ROUND, attribution: MUSE },
  suggest_garment: { ...MUSE_ROUND, attribution: MUSE },
  suggest_outfit: { ...MUSE_ROUND, attribution: MUSE },
  finish_round: { ...MUSE_ROUND, attribution: MUSE },
};
