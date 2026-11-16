import {
  KindGuard,
  type Static,
  type TSchema,
  type TObject,
  Type,
} from '@sinclair/typebox';
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

type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * A resource as a mapper builds it before `asResource` shapes it: every
 * optional field, at every level, may also be null (MCP's tools project
 * the same record, and an agent reads "null").
 */
export type NullsKept<T> = T extends readonly (infer Item)[]
  ? readonly NullsKept<Item>[]
  : T extends object
    ? {
        [K in keyof T]: K extends OptionalKeys<T>
          ? NullsKept<Exclude<T[K], undefined>> | null | undefined
          : NullsKept<T[K]>;
      }
    : T;

/** Whether `schema` declares an explicit null (a `Nullable` field). */
function admitsNull(schema: TSchema): boolean {
  return (
    KindGuard.IsNull(schema) ||
    (KindGuard.IsUnion(schema) && schema.anyOf.some(admitsNull))
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether two object branches of one union can never both hold a value: a field both pin to different literals. */
function tellApart(a: TObject, b: TObject): boolean {
  return Object.entries(a.properties).some(([key, field]) => {
    const other = b.properties[key];
    return (
      KindGuard.IsLiteral(field) &&
      other !== undefined &&
      KindGuard.IsLiteral(other) &&
      other.const !== field.const
    );
  });
}

/**
 * Refuses a union `shapeAs` could not pick a branch of: two object branches
 * (or two array branches) no literal field tells apart would shape by the
 * first, and drop the second's keys without an error (#997). A union is
 * discriminated by a literal field (a packing warning's `kind`), or its
 * branches differ in kind (an object or null). Walks every level; throws
 * naming `name`. Run at boot over every API response (`apiResponses`) and on
 * first use by `asResource` and `project`, for a schema only MCP answers.
 */
export function assertUnambiguousUnions(
  schema: TSchema,
  name = schema.title ?? 'resource',
): void {
  if (KindGuard.IsUnion(schema)) {
    const objects = schema.anyOf.filter(KindGuard.IsObject);
    const arrays = schema.anyOf.filter(KindGuard.IsArray);
    const ambiguousObjects = objects.some((a, i) =>
      objects.slice(i + 1).some((b) => !tellApart(a, b)),
    );
    if (ambiguousObjects || arrays.length > 1) {
      throw new TypeError(
        `${name}: a union of ${ambiguousObjects ? 'objects' : 'arrays'} with no literal field telling its branches apart would lose the later branch's keys; tag each branch (Type.Literal)`,
      );
    }
    schema.anyOf.forEach((branch) => assertUnambiguousUnions(branch, name));
  } else if (KindGuard.IsObject(schema)) {
    for (const [key, field] of Object.entries(schema.properties)) {
      assertUnambiguousUnions(field, `${name}.${key}`);
    }
  } else if (KindGuard.IsArray(schema)) {
    assertUnambiguousUnions(schema.items, `${name}[]`);
  }
}

const checkedSchemas = new WeakSet<TSchema>();

function checkOnce(schema: TSchema): void {
  if (checkedSchemas.has(schema)) return;
  assertUnambiguousUnions(schema);
  checkedSchemas.add(schema);
}

/** The object or array schema `value` is, a union's branch picked by its literal fields (a packing warning's `kind`); `assertUnambiguousUnions` guarantees at most one fits. */
function containerOf(schema: TSchema, value: object, path: string): TSchema {
  if (!KindGuard.IsUnion(schema)) return schema;
  const wanted = Array.isArray(value) ? KindGuard.IsArray : KindGuard.IsObject;
  const branch = schema.anyOf.find(
    (candidate) =>
      wanted(candidate) &&
      (!KindGuard.IsObject(candidate) ||
        Object.entries(candidate.properties).every(
          ([key, field]) =>
            !KindGuard.IsLiteral(field) ||
            (value as Record<string, unknown>)[key] === field.const,
        )),
  );
  if (branch === undefined) {
    throw new TypeError(`${path}: no branch of its schema holds the value`);
  }
  return branch;
}

/**
 * `value` as `schema` holds it, at every level: only the schema's fields
 * (in the value's order), an undefined one left out, and a null one left
 * out under `drop` unless the schema declares the null. The one rule both
 * surfaces answer a resource record by (`asResource`, `project`), so an
 * internal column a record carries (a row as stored) never reaches either.
 * A value that is not JSON's (a Date, a Buffer) is a mapper's bug: the
 * mapper serializes it (`toISOString()`).
 */
function shapeAs(
  schema: TSchema,
  value: unknown,
  nulls: 'drop' | 'keep',
  path: string,
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const container = containerOf(schema, value, path);
  if (Array.isArray(value)) {
    if (!KindGuard.IsArray(container)) {
      throw new TypeError(`${path}: an array where its schema has none`);
    }
    return value.map((item: unknown, index) =>
      shapeAs(container.items, item, nulls, `${path}[${index}]`),
    );
  }
  if (!isPlainObject(value) || !KindGuard.IsObject(container)) {
    throw new TypeError(`${path}: not a plain object its schema describes`);
  }
  return shapeFields(container, value, nulls, path);
}

/** shapeAs's object level: its schema's fields, in the value's order. */
function shapeFields(
  schema: TObject,
  value: Record<string, unknown>,
  nulls: 'drop' | 'keep',
  path: string,
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const fieldSchema = schema.properties[key];
    const dropped =
      fieldSchema === undefined ||
      field === undefined ||
      (field === null && nulls === 'drop' && !admitsNull(fieldSchema));
    if (!dropped) {
      shaped[key] = shapeAs(fieldSchema, field, nulls, `${path}.${key}`);
    }
  }
  return shaped;
}

/**
 * A mapper's record as the API sends it: shaped by its resource schema,
 * every null the schema does not declare left out, however deep. Needed,
 * not cosmetic: Fastify serializes a null through a `string` schema as
 * `""`. The record keeps its nulls because MCP's tools project it too.
 */
export function asResource<S extends TSchema>(
  schema: S,
  record: NullsKept<Static<S>>,
): Static<S> {
  checkOnce(schema);
  return shapeAs(schema, record, 'drop', schema.title ?? 'resource');
}

/**
 * How another surface (MCP's tools) answers a resource mapper's record,
 * field by field: `keep` (as mapped, shaped by the field's schema, nulls
 * kept), `omit` (not that surface's: a URL an agent cannot fetch) or `own`
 * (the surface's own shape of it, handed to `project`: a nested level's
 * own projection, the agent's bare name). Every field must be listed, so a
 * field the record gains is a type error at each projection until someone
 * decides it, and `projections.spec.ts` (src/web/mcp) holds every
 * projection to its resource schema's fields.
 */
export type Projection<T> = {
  readonly [K in keyof T]-?: 'keep' | 'omit' | 'own';
};

type FieldsAs<P, As> = {
  [K in keyof P]: P[K] extends As ? K : never;
}[keyof P];

/**
 * `record` as `projection` says, in its order: the kept fields, each
 * shaped by its field of `schema` (the API's resource: a nested level
 * answers only what the API does, never a stored row's other columns),
 * then each `own` field from `own`, which must hold every one of them and
 * may add what the surface answers beside the resource (get_trip's
 * `today`).
 */
export function project<
  T extends object,
  P extends Projection<T>,
  Own extends { [K in FieldsAs<P, 'own'>]: unknown },
>(
  record: T,
  schema: TObject,
  projection: P,
  own: Own,
): Pick<T, Extract<FieldsAs<P, 'keep'>, keyof T>> & Own {
  checkOnce(schema);
  const answer: Record<string, unknown> = {};
  const fields = record as Record<string, unknown>;
  const owned = own as Record<string, unknown>;
  const title = schema.title ?? 'resource';
  for (const [field, as] of Object.entries(projection)) {
    if (as === 'keep') {
      answer[field] = shapeAs(
        schema.properties[field],
        fields[field],
        'keep',
        `${title}.${field}`,
      );
    }
    if (as === 'own') answer[field] = owned[field];
  }
  for (const [field, value] of Object.entries(owned)) {
    if (!(field in answer)) answer[field] = value;
  }
  return answer as Pick<T, Extract<FieldsAs<P, 'keep'>, keyof T>> & Own;
}
