import { HttpError } from './errors';
import { t, type StringKey } from './i18n';

/**
 * The typed refusals a domain function throws when the actor may not have
 * what it asked for (#188; docs/plans/2026-11-12-json-api.md section 4).
 * The policy is access.ts's: what the actor cannot see is NotFound, worded
 * as an unknown id would be, so ids never reveal whose data exists; what
 * they can see but may not change is Forbidden. Pages render either as the
 * error page, an MCP tool answers its message, the API its `code`.
 *
 * Only these spell a 404 or 403 (guards.conf [refusals]): a route or tool
 * that refuses by hand is the duplication #188 removes. NotServed is the
 * one a route may throw, since no resource or actor decides it.
 */

/** One message per resource, so every surface words a refusal the same way. */
const NOT_FOUND_MESSAGE = {
  account: 'refusal.notFound.account',
  agentRequest: 'refusal.notFound.agentRequest',
  avoidedPair: 'refusal.notFound.avoidedPair',
  brand: 'refusal.notFound.brand',
  calendarEntry: 'refusal.notFound.calendarEntry',
  capsule: 'refusal.notFound.capsule',
  draft: 'refusal.notFound.draft',
  garment: 'refusal.notFound.garment',
  garmentPhoto: 'refusal.notFound.garmentPhoto',
  inspiration: 'refusal.notFound.inspiration',
  inspirationPiece: 'refusal.notFound.inspirationPiece',
  need: 'refusal.notFound.need',
  orderItem: 'refusal.notFound.orderItem',
  outfit: 'refusal.notFound.outfit',
  outfitRule: 'refusal.notFound.outfitRule',
  repair: 'refusal.notFound.repair',
  selfie: 'refusal.notFound.selfie',
  share: 'refusal.notFound.share',
  trip: 'refusal.notFound.trip',
  wardrobe: 'refusal.notFound.wardrobe',
  weekPlan: 'refusal.notFound.weekPlan',
  wishlistItem: 'refusal.notFound.wishlistItem',
} as const satisfies Record<string, StringKey>;

export type Resource = keyof typeof NOT_FOUND_MESSAGE;

export class NotFound extends HttpError {
  constructor(
    readonly resource: Resource,
    options: { logDetail?: string } = {},
  ) {
    super(404, t(NOT_FOUND_MESSAGE[resource]), options);
    this.name = 'NotFound';
  }
}

/**
 * Why a refusal the actor can see the reason for is one, where "Forbidden"
 * alone would be misread (an agent retrying a filter it may never use).
 */
const FORBIDDEN_REASON = {
  launderOnly: 'refusal.forbidden.launderOnly',
} as const satisfies Record<string, StringKey>;

export type ForbiddenReason = keyof typeof FORBIDDEN_REASON;

export class Forbidden extends HttpError {
  constructor(options: { logDetail?: string; reason?: ForbiddenReason } = {}) {
    const { reason, ...rest } = options;
    super(
      403,
      t(reason ? FORBIDDEN_REASON[reason] : 'refusal.FORBIDDEN'),
      rest,
    );
    this.name = 'Forbidden';
  }
}

/**
 * A path the server answers as if it did not exist: the status text alone,
 * no resource named, since no actor asked for one. Not an access decision
 * but a request concern its route owns, so guards.conf `@not-served` lists
 * the sites that may throw it, each with its reason: the public image
 * server's name that is no stored photo, a private photo's name, a share id
 * with no photo and bytes missing from storage (src/web/files), and
 * /metrics asked through a proxy (src/web/metrics/routes.ts), and an OAuth
 * discovery name while OAuth is off (src/web/oauth/routes.ts). Its body is
 * the bare `{ statusCode, message }` those public routes always answered,
 * or on the `oauth` surface `{ error: "not_found", error_description }`.
 */
export class NotServed extends HttpError {
  constructor(options: { logDetail?: string } = {}) {
    super(404, undefined, options);
    this.name = 'NotServed';
  }
}
