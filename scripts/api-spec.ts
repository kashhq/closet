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

/**
 * What a client generator needs and TypeBox's inlining withholds (#714):
 * every titled schema becomes one component, named by its title and
 * referenced where it was copied; an `anyOf` of single-value string enums
 * is one `enum`; a union of objects that each carry a literal `resource`
 * is discriminated by it, with the mapping. Emitter-only: the routes still
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

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!isRecord(node)) return node;
    const visited: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      visited[key] = visit(value);
    }
    const schema = discriminated(
      collapseEnums(visited),
      (ref) => registered[ref.slice(SCHEMA_REF.length)],
    );
    const { title } = schema;
    if (typeof title !== 'string' || '$ref' in schema) return schema;
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

  // The shared schemas (Problem, named by its $id and titled alike) first.
  for (const shared of Object.values(
    isRecord(components.schemas) ? components.schemas : {},
  ))
    visit(shared);
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

/** `anyOf: [{ type: 'string', enum: ['a'] }, ...]` as one `enum`. */
function collapseEnums(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const { anyOf, ...rest } = schema;
  if (!Array.isArray(anyOf) || anyOf.length === 0) return schema;
  const values: unknown[] = [];
  for (const branch of anyOf) {
    if (
      !isRecord(branch) ||
      Object.keys(branch).length !== 2 ||
      branch.type !== 'string' ||
      !Array.isArray(branch.enum) ||
      branch.enum.length !== 1
    ) {
      return schema;
    }
    values.push(branch.enum[0]);
  }
  return { ...rest, type: 'string', enum: values };
}

/** A discriminator on `resource` for a union whose every branch carries one literal. */
function discriminated(
  schema: Record<string, unknown>,
  resolve: (ref: string) => unknown,
): Record<string, unknown> {
  const { anyOf } = schema;
  if (!Array.isArray(anyOf) || anyOf.length < 2) return schema;
  const mapping: Record<string, string> = {};
  for (const branch of anyOf) {
    if (!isRecord(branch) || typeof branch.$ref !== 'string') return schema;
    const target = resolve(branch.$ref);
    const resource =
      isRecord(target) && isRecord(target.properties)
        ? target.properties.resource
        : undefined;
    if (
      !isRecord(resource) ||
      !Array.isArray(resource.enum) ||
      resource.enum.length !== 1 ||
      typeof resource.enum[0] !== 'string'
    ) {
      return schema;
    }
    mapping[resource.enum[0]] = branch.$ref;
  }
  if (Object.keys(mapping).length !== anyOf.length) return schema;
  return { ...schema, discriminator: { propertyName: 'resource', mapping } };
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
