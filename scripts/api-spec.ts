import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import Fastify, { type FastifySchema } from 'fastify';
import { join } from 'node:path';
import { pino } from 'pino';
import { PROJECT_ROOT } from '../src/project-root';
import { DEVICE_TOKEN_SCHEME } from '../src/web/api/contract';
import { type ApiOptions, registerApi } from '../src/web/api/plugin';
import { createSignInLimits } from '../src/web/auth/sign-in';
import {
  BEARER_REFUSAL_LIMIT,
  LINK_IMPORT_LIMIT,
} from '../src/web/security/rate-limit';
import { assignSurface } from '../src/web/surface';

/**
 * The API's OpenAPI 3.1 document, generated from the TypeBox schemas the
 * /api/v1 routes declare (#190; plan section 5). `npm run api:spec` writes
 * it to SPEC_PATH, which GET /api/v1/openapi.json serves as committed, and
 * scripts/api-spec.spec.ts fails when the committed file is not what this
 * generates: a contract change is a reviewed diff. @fastify/swagger is a
 * devDependency, imported only here.
 */
export const SPEC_PATH = join(PROJECT_ROOT, 'src/web/api/openapi.json');

/**
 * The plugin is registered on a bare instance that never listens or serves
 * a request: registration only passes these references to hooks and
 * handlers, so nothing behind them is ever called. Each is the type's
 * shape and no more; the cast says it is not a working app. `weather` is
 * there so the routes that exist only with WEATHER_ENABLED are in the
 * spec: it documents every feature on.
 */
function unservedOptions(): ApiOptions {
  const logger = pino({ level: 'silent' });
  return {
    config: { timeZone: 'UTC' },
    logger,
    apiLogger: logger,
    mcpLogger: logger,
    weather: {},
  } as unknown as ApiOptions;
}

export async function generateApiSpec(): Promise<unknown> {
  const app = Fastify();
  await app.register(fastifySwagger, {
    transform: ({ schema, url }) => ({
      schema: withMultipartBody(schema),
      url,
    }),
    // A shared schema is a component named by its $id (Problem).
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' ? json.$id : `def-${i}`,
    },
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Closet API',
        // The contract's version, never the build's: the sha would make
        // every commit a spec change.
        version: 'v1',
        description:
          "Closet's JSON API for native clients. Sign in with POST /api/v1/auth/token and send the device token as `Authorization: Bearer <token>`. A 401 on any route means sign in again. Errors are RFC 9457 problem+json; switch on `code`.",
      },
      components: {
        securitySchemes: {
          [DEVICE_TOKEN_SCHEME]: {
            type: 'http',
            scheme: 'bearer',
            description:
              'A device token from POST /api/v1/auth/token, valid until revoked or unused for 90 days.',
          },
        },
      },
      security: [{ [DEVICE_TOKEN_SCHEME]: [] }],
    },
  });
  await app.register(fastifyRateLimit, { global: false });
  app.addHook('onRoute', assignSurface);
  await registerApi(app, {
    ...unservedOptions(),
    signInLimits: createSignInLimits(app),
    bearerRefusalLimit: app.createRateLimit(BEARER_REFUSAL_LIMIT),
    linkImportLimit: app.createRateLimit(LINK_IMPORT_LIMIT),
    inspirationLinkLimit: app.createRateLimit(LINK_IMPORT_LIMIT),
  });
  await app.ready();
  const spec: unknown = app.swagger();
  await app.close();
  markOptionalBodies(spec);
  nameSchemas(spec);
  return spec;
}

const SCHEMA_REF = '#/components/schemas/';

/** Keywords whose values are data, not schemas: an example carrying a `title` is not a component (#1169). */
const DATA_KEYWORDS = new Set([
  'default',
  'example',
  'examples',
  'const',
  'enum',
]);

/** Keywords whose value maps user-chosen names to schemas: the names are never keywords (a property may be called `default`). */
const NAME_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/**
 * What a client generator needs and TypeBox's inlining withholds (#714):
 * every titled schema becomes one component, named by its title and
 * referenced where it was copied; an `anyOf` of single-value literals of one
 * type is one `enum`; a union of objects that each carry a literal `resource`
 * is a `oneOf` discriminated by it, with the mapping. Emitter-only: the routes still
 * serialize through the inline schemas, so no response changes.
 *
 * Two shapes under one title would make one name mean two types, so the
 * emit fails and the title gets renamed at its source.
 */
export function nameSchemas(spec: unknown): void {
  if (!isRecord(spec) || !isRecord(spec.paths)) return;
  const components: Record<string, unknown> = isRecord(spec.components)
    ? spec.components
    : {};
  const registered: Record<string, unknown> = {};
  const shapeOf = new Map<string, string>();

  const visit = (node: unknown, hoist = true): unknown => {
    if (Array.isArray(node)) return node.map((item) => visit(item));
    if (!isRecord(node)) return node;
    const visited: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) visited[key] = value;
      else if (NAME_MAP_KEYWORDS.has(key) && isRecord(value))
        visited[key] = Object.fromEntries(
          Object.entries(value).map(([name, property]) => [
            name,
            visit(property),
          ]),
        );
      else visited[key] = visit(value);
    }
    const schema = discriminated(
      collapseEnums(visited),
      (ref) => registered[ref.slice(SCHEMA_REF.length)],
    );
    const { title } = schema;
    if (!hoist || typeof title !== 'string' || '$ref' in schema) return schema;
    const shape = canonical(schema);
    const known = shapeOf.get(title);
    if (known !== undefined && known !== shape) {
      throw new Error(
        `The title "${title}" names two schemas in the API spec; titles name components, so rename one.`,
      );
    }
    shapeOf.set(title, shape);
    registered[title] = schema;
    return { $ref: `${SCHEMA_REF}${title}` };
  };

  // The shared schemas (Problem, named by its $id) keep their names, titled
  // or not; only what is inside them is processed.
  for (const [name, shared] of Object.entries(
    isRecord(components.schemas) ? components.schemas : {},
  )) {
    const processed = visit(shared, false);
    registered[name] = processed;
    shapeOf.set(name, canonical(processed));
  }
  spec.paths = visit(spec.paths);
  spec.components = { ...components, schemas: registered };
}

/** A schema as text with its keys sorted: two copies differing only in key order are one shape. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    isRecord(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)),
        )
      : nested,
  );
}

const LITERAL_TYPES = ['string', 'number', 'integer', 'boolean'];

/** A branch that is exactly one literal: `{ type, enum: [value] }`. */
function singleLiteral(
  branch: unknown,
): { type: string; value: unknown } | undefined {
  if (!isRecord(branch) || Object.keys(branch).length !== 2) return undefined;
  const { type, enum: values } = branch;
  if (typeof type !== 'string' || !LITERAL_TYPES.includes(type)) {
    return undefined;
  }
  if (!Array.isArray(values) || values.length !== 1) return undefined;
  return { type, value: values[0] };
}

/** `anyOf: [{ type: 'number', enum: [1] }, ...]` as one `enum` of that type. */
function collapseEnums(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const { anyOf, ...rest } = schema;
  if (!Array.isArray(anyOf) || anyOf.length === 0) return schema;
  const literals = anyOf.map(singleLiteral);
  const [first] = literals;
  if (!first || literals.some((l) => l?.type !== first.type)) return schema;
  return {
    ...rest,
    type: first.type,
    enum: literals.map((literal) => literal?.value),
  };
}

/** The one string a union branch's `resource` property allows, if it is one. */
function resourceLiteral(target: unknown): string | undefined {
  if (!isRecord(target) || !isRecord(target.properties)) return undefined;
  const literal = singleLiteral(target.properties.resource);
  return typeof literal?.value === 'string' ? literal.value : undefined;
}

/**
 * A union whose every branch is a component carrying one literal `resource`
 * becomes a discriminated `oneOf` (generators honour a discriminator only
 * there; the literals make the branches mutually exclusive).
 */
function discriminated(
  schema: Record<string, unknown>,
  resolve: (ref: string) => unknown,
): Record<string, unknown> {
  const { anyOf, ...rest } = schema;
  if (!Array.isArray(anyOf) || anyOf.length < 2) return schema;
  const mapping: Record<string, string> = {};
  for (const branch of anyOf) {
    if (!isRecord(branch) || typeof branch.$ref !== 'string') return schema;
    const value = resourceLiteral(resolve(branch.$ref));
    if (value === undefined) return schema;
    mapping[value] = branch.$ref;
  }
  if (Object.keys(mapping).length !== anyOf.length) return schema;
  return {
    ...rest,
    oneOf: anyOf,
    discriminator: { propertyName: 'resource', mapping },
  };
}

/**
 * A multipart route's body, for the spec only: its `multipartBody` (the
 * parts it reads, contract.ts) as the operation's multipart/form-data
 * request body. The route itself declares no `body`, which Fastify would
 * validate: a multipart body is read by the handler (request.files()),
 * never parsed before it.
 */
function withMultipartBody(schema: FastifySchema): FastifySchema {
  if (!schema.multipartBody) return schema;
  return {
    ...schema,
    body: { content: { [MULTIPART]: { schema: schema.multipartBody } } },
  };
}

const MULTIPART = 'multipart/form-data';

/**
 * @fastify/swagger marks every declared body required (it assumes Fastify
 * demands one), but Fastify validates an absent body as null: a body whose
 * schema admits null may be left out, and the spec says so (#546: a clone
 * or a copy without a body).
 */
function markOptionalBodies(spec: unknown): void {
  if (!isRecord(spec) || !isRecord(spec.paths)) return;
  for (const methods of Object.values(spec.paths)) {
    if (!isRecord(methods)) continue;
    for (const operation of Object.values(methods)) {
      if (!isRecord(operation)) continue;
      const { requestBody } = operation;
      if (isRecord(requestBody) && everyMediaAdmitsNull(requestBody)) {
        requestBody.required = false;
      }
    }
  }
}

function everyMediaAdmitsNull(requestBody: Record<string, unknown>): boolean {
  const media = isRecord(requestBody.content)
    ? Object.values(requestBody.content)
    : [];
  return (
    media.length > 0 &&
    media.every((type) => isRecord(type) && admitsNull(type.schema))
  );
}

function admitsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === 'null') return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some(admitsNull);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The file's bytes: what `npm run api:spec` writes and the drift test compares. */
export function serializeSpec(spec: unknown): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
