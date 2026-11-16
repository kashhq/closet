import type {
  FastifyInstance,
  FastifySchemaCompiler,
  RouteOptions,
} from 'fastify';
import { sharedValidators } from '../schema-validators';

/**
 * The /api/v1 scope's validator compiler (apiPlugin): a JSON body is
 * validated as sent, never coerced. Fastify's ajv coerces types by default
 * (`coerceTypes: 'array'`), which the pages need (a form posts strings, a
 * single row as scalars) but which corrupts JSON: a `0`, `""` or `false`
 * meets `{ type: 'null' }` as null and `"3"` passes as 3. Querystring and
 * params arrive as strings, so they keep the coercing compiler (`?limit=20`).
 *
 * A querystring is also closed: a parameter the route does not declare is a
 * 400 naming it (#577), never silently ignored (a client's misspelled
 * `?categroy=` would answer the unfiltered list). The one place, so a route
 * added later is strict without work; a parameter a route accepts must be
 * declared. `removeAdditional` is off for it: with `additionalProperties:
 * false`, ajv's default would strip the key instead of failing. Off for
 * bodies too, so a body schema that closes itself (the style profile's,
 * replaced whole) refuses a key it lacks; an open one is unaffected, and
 * ajv's stripping inside an `anyOf` would mutate the body under the
 * branches still to try.
 *
 * Both are @fastify/ajv-compiler, the factory Fastify itself builds its
 * compiler with (through sharedValidators, as the root's: one compile per
 * schema per process), with the root's options (app.ts sets none), so formats,
 * `useDefaults` and `removeAdditional` stay as on every other route. Built
 * on the first route compiled, when the scope's shared schemas (Problem)
 * are all added; a request schema referring to one a child scope adds
 * would fail the boot as an unresolved $ref, never pass unchecked.
 */
export function jsonApiValidator(
  scope: FastifyInstance,
): FastifySchemaCompiler<unknown> {
  let compilers: { body: Compile; other: Compile; query: Compile } | undefined;
  return (route) => {
    if (!compilers) {
      // Fastify types its schema bucket as unknown values; they are the
      // JSON schemas addSchema took, which is what the factory wants.
      const shared = scope.getSchemas() as Parameters<
        typeof sharedValidators
      >[0];
      compilers = {
        body: sharedValidators(shared, {
          customOptions: { coerceTypes: false, removeAdditional: false },
        }),
        other: sharedValidators(shared, { customOptions: {} }),
        query: sharedValidators(shared, {
          customOptions: { removeAdditional: false },
        }),
      };
    }
    // The factory's compiler takes the route definition (it reads
    // `.schema`), though its types name only a schema.
    switch (route.httpPart) {
      case 'body':
        return compilers.body(route);
      case 'querystring':
        return compilers.query({
          ...route,
          schema: { ...(route.schema as object), additionalProperties: false },
        });
      default:
        return compilers.other(route);
    }
  };
}

type Compile = ReturnType<typeof sharedValidators>;

/**
 * apiPlugin's onRoute hook: a route that declares no querystring gets an
 * empty one, so the closed-querystring rule (above) holds for it too: Fastify
 * compiles a schema only for a part the route declares. Adds nothing to the
 * OpenAPI document (no properties, no parameters).
 */
export function declareQuerystring(route: RouteOptions): void {
  route.schema ??= {};
  route.schema.querystring ??= { type: 'object', properties: {} };
}
