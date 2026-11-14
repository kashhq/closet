import { type TSchema, Type } from '@sinclair/typebox';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { ROW_ID_MAX } from '../schemas';

/**
 * The shapes every /api/v1 resource shares (docs/plans/2026-11-12-json-
 * api.md section 2): lists, their opaque cursors, the stored lowercase
 * enums, and the rule that a null field is left out. A feature's mappers
 * (`src/web/<feature>/<resource>-resource.ts`) build on them, and MCP's
 * tools answer an entity by projecting the same mapper's record (`project`).
 */

/** A stored enum's values as its schema: the spec lists them for a client. */
export function literals<T extends string | number>(values: readonly T[]) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

/**
 * An optional input field a client may set to null, which clears it (a
 * PATCH's absent field is left alone). Plain anyOf: only because /api
 * bodies are never coerced (jsonApiValidator, validator.ts); on a coercing
 * route a branch would turn a 0 into null, or a null into "".
 */
export function Nullable<T extends TSchema>(
  schema: T,
  options: { description?: string } = {},
) {
  return Type.Optional(Type.Union([schema, Type.Null()], options));
}

/** A list's page size: `limit`, the feature's own page by default, at most 100. */
export const LIST_LIMIT_MAX = 100;

export function ListLimit(byDefault: number) {
  return Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: LIST_LIMIT_MAX,
      default: byDefault,
      description: `How many a page holds: ${byDefault} unless asked, at most ${LIST_LIMIT_MAX}`,
    }),
  );
}

/** `?cursor=`: the previous page's `nextCursor`, as it was answered. */
export const ListCursor = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9_-]+$',
  description: "The previous page's `pagination.nextCursor`",
});

const Pagination = Type.Object(
  {
    /** Absent on the last page. */
    nextCursor: Type.Optional(Type.String()),
    limit: Type.Integer(),
  },
  { title: 'Pagination' },
);

/**
 * A list's answer: `{ data, pagination }`, plus whatever the route reads
 * with it (`extra`, the grid's `total`). Never a total by default: a count
 * costs a statement.
 */
export function ListOf<
  Item extends TSchema,
  Extra extends Record<string, TSchema>,
>(item: Item, options: { title: string; description: string; extra?: Extra }) {
  return Type.Object(
    {
      data: Type.Array(item),
      pagination: Pagination,
      ...(options.extra ?? ({} as Extra)),
    },
    { title: options.title, description: options.description },
  );
}

/**
 * A keyset cursor over row ids, newest first (the grid's `before`, #192a):
 * base64url, so a client treats it as opaque and a later keyset (a sort key
 * with the id) can change it without a new parameter. A ranked list (the
 * grid's keyword search, #673: a rank, then newest first) prefixes the
 * rank; rank 0 is spelled as the plain id cursor, so one minted before the
 * list ranked still reads.
 */
const ID_CURSOR = /^(?:rank:([1-9]):)?id:([1-9]\d{0,9})$/;

export function rankedIdCursor({ rank, id }: { rank: number; id: number }) {
  const ranked = rank === 0 ? '' : `rank:${rank}:`;
  return Buffer.from(`${ranked}id:${id}`).toString('base64url');
}

/**
 * The rank and id a rankedIdCursor names, the rank one of `ranks`; any
 * other string is a 400 `validation`.
 */
export function readRankedIdCursor<Rank extends number>(
  cursor: string,
  ranks: readonly Rank[],
): { rank: Rank; id: number } {
  const match = ID_CURSOR.exec(Buffer.from(cursor, 'base64url').toString());
  const id = match ? Number(match[2]) : 0;
  const rank = ranks.find((value) => value === Number(match?.[1] ?? 0));
  if (rank === undefined || id < 1 || id > ROW_ID_MAX) {
    throw new HttpError(400, t('api.BAD_CURSOR'));
  }
  return { rank, id };
}

export function idCursor(id: number): string {
  return rankedIdCursor({ rank: 0, id });
}

/** The id an idCursor names; any other string is a 400 `validation`. */
export function readIdCursor(cursor: string): number {
  return readRankedIdCursor(cursor, [0]).id;
}

/**
 * A position cursor, for a list whose order is not a keyset of its rows
 * (the trips: upcoming first, by a phase that moves with the day, #194a):
 * the count already answered. A row added or removed between pages shifts
 * the next one by it, which a short list re-read in full tolerates.
 */
const OFFSET_CURSOR = /^at:([1-9]\d{0,5})$/;

export function offsetCursor(offset: number): string {
  return Buffer.from(`at:${offset}`).toString('base64url');
}

/** The offset an offsetCursor names; any other string is a 400 `validation`. */
export function readOffsetCursor(cursor: string): number {
  const match = OFFSET_CURSOR.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) throw new HttpError(400, t('api.BAD_CURSOR'));
  return Number(match[1]);
}

/** A mapped resource with its null fields left out, as the API sends them. */
export type WithoutNulls<T> = {
  [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

/**
 * `value` without its null fields (one level: a nested object maps its own).
 * Needed, not cosmetic: Fastify serializes a null through a `string` schema
 * as `""`.
 */
export function withoutNulls<T extends object>(value: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== null),
  ) as WithoutNulls<T>;
}

/** A record with its null fields left out at every level, arrays' items included. */
export type WithoutNullsDeep<T> = T extends readonly (infer Item)[]
  ? WithoutNullsDeep<Item>[]
  : T extends object
    ? WithoutNulls<{ [K in keyof T]: WithoutNullsDeep<T[K]> }>
    : T;

/**
 * A mapper's record as the API sends it: every null left out, however
 * deep. For a mapper whose record keeps its nulls because another surface
 * projects from it (MCP's tools: an agent reads "null"), so the API's rule
 * is applied once, here, and never forgotten at one nested level.
 */
export function withoutNullsDeep<T>(value: T): WithoutNullsDeep<T> {
  if (Array.isArray(value)) {
    return value.map(withoutNullsDeep) as WithoutNullsDeep<T>;
  }
  if (typeof value !== 'object' || value === null) {
    return value as WithoutNullsDeep<T>;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, withoutNullsDeep(field)]),
  ) as WithoutNullsDeep<T>;
}

/**
 * How another surface (MCP's tools) answers a resource mapper's record,
 * field by field: `keep` (as mapped, the whole value), `omit` (not that
 * surface's: a URL an agent cannot fetch) or `own` (the surface's own
 * shape of it, handed to `project`: a nested level's own projection, the
 * agent's bare name). Every field must be listed, so a field the record
 * gains is a type error at each projection until someone decides it, and
 * `projections.spec.ts` (src/web/mcp) holds every projection to its
 * resource schema's fields.
 */
export type Projection<T> = {
  readonly [K in keyof T]-?: 'keep' | 'omit' | 'own';
};

type FieldsAs<P, As> = {
  [K in keyof P]: P[K] extends As ? K : never;
}[keyof P];

/**
 * `record` as `projection` says, in its order: the kept fields, then each
 * `own` field from `own`, which must hold every one of them and may add
 * what the surface answers beside the resource (get_trip's `today`).
 */
export function project<
  T extends object,
  P extends Projection<T>,
  Own extends { [K in FieldsAs<P, 'own'>]: unknown },
>(
  record: T,
  projection: P,
  own: Own,
): Pick<T, Extract<FieldsAs<P, 'keep'>, keyof T>> & Own {
  const answer: Record<string, unknown> = {};
  const fields = record as Record<string, unknown>;
  const owned = own as Record<string, unknown>;
  for (const [field, as] of Object.entries(projection)) {
    if (as === 'keep') answer[field] = fields[field];
    if (as === 'own') answer[field] = owned[field];
  }
  for (const [field, value] of Object.entries(owned)) {
    if (!(field in answer)) answer[field] = value;
  }
  return answer as Pick<T, Extract<FieldsAs<P, 'keep'>, keyof T>> & Own;
}
