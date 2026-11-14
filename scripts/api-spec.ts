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
  return spec;
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
