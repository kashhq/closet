import { Type } from '@sinclair/typebox';
import { OCCASIONS } from '../wardrobe/occasions';

/**
 * Request schema pieces more than one feature validates with (TypeBox, see
 * AGENTS.md, Web layer: Validation).
 */

/** The largest row id: Postgres serials are 32-bit. Every id check's bound. */
export const ROW_ID_MAX = 2_147_483_647;

/**
 * Marks a schema as a resource id. A symbol key, so it is neither a JSON
 * Schema keyword (ajv strict mode would refuse it) nor part of openapi.json;
 * TypeBox's Clone and CloneType keep symbol keys. Read by the authorization
 * coverage guard (test/integration/authorization-coverage.spec.ts): a route
 * whose body or querystring carries one needs a matrix case.
 */
export const RESOURCE_ID = Symbol('closet.resourceId');

/**
 * A row id in a path or a form: anything larger than ROW_ID_MAX would fail
 * in the query as a 500 instead of here as a 400. Every id of a row some
 * user owns is a RowId, never a bare Type.Integer(): the guard keys on it.
 */
export const RowId = Type.Integer({
  minimum: 1,
  maximum: ROW_ID_MAX,
  [RESOURCE_ID]: true,
});

/**
 * A calendar day, 'YYYY-MM-DD'. `format: 'date'` is ajv-formats' full-date
 * (a real calendar date), the rule parseIsoDate (src/web/calendar/
 * calendar-date.ts) applies to query parameters that fall back instead.
 */
export const IsoDateSchema = Type.String({ format: 'date' });

/**
 * A wear's or wash's instant as its tap posts it (#676: the outbox's `at`,
 * an API client's): ajv-formats' date-time, with its offset. Judged by
 * tapInstant (src/offline-writes.ts) before it is stored.
 */
export const TapInstantSchema = Type.String({ format: 'date-time' });

/**
 * `?ownerId=`: the wardrobe a request addresses, the requester's own when
 * absent or empty (the pages only add it for a shared wardrobe). Anything
 * else is a 400: it names whose data to read.
 */
export const OwnerQuery = Type.Object({
  ownerId: Type.Optional(Type.Union([Type.Literal(''), RowId])),
});

/** `/:id` of a garment's route (wardrobe, wears, wishlist, capsules). */
export const GarmentParams = Type.Object({ id: RowId });

/**
 * One of a property's values as a form posts it ('' for the reset chip).
 * Only the form's own chips post these, so anything else is a hand-made
 * request: a 400 from the schema, not a message under a field. Also the
 * style profile's budget band (src/web/style/validation.ts).
 */
export function choice(values: readonly (string | number)[]) {
  return Type.Optional(
    Type.Union([
      Type.Literal(''),
      ...values.map((value) => Type.Literal(String(value))),
    ]),
  );
}

/** The member of `set` a form or query posted; '' (the reset chip) is none. */
export function pick<T extends string | number>(
  set: readonly T[],
  posted: string,
): T | null {
  return set.find((value) => String(value) === posted) ?? null;
}

/**
 * A calendar entry's occasion (src/wardrobe/occasions.ts) in a form: POST
 * /calendar and the outfit form. Anything else is a 400: it is data a write
 * stores (a `?occasion=` in a URL is navigation state, parseDestination's).
 */
export const OccasionSchema = Type.Union(
  OCCASIONS.map((occasion) => Type.Literal(occasion)),
);
