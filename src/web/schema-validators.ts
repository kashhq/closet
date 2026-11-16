import { AjvCompiler } from '@fastify/ajv-compiler';
import type { FastifySchemaCompiler } from 'fastify';

type Build = ReturnType<typeof AjvCompiler>;
type RouteSchemaDef = Parameters<FastifySchemaCompiler<unknown>>[0];
type Validate = ReturnType<ReturnType<Build>>;

const factory = AjvCompiler();
const compiled = new Map<string, Validate>();

/**
 * Fastify's validator factory (@fastify/ajv-compiler, the one it builds by
 * default) with every compiled validator kept for the process, keyed by
 * what decides it: the scope's shared schemas, the ajv options, the part
 * of the request and the schema itself, as JSON. A schema compiles once per
 * process, not once per app: production boots one app, but the integration
 * tier boots one per spec file in each worker (about 185 a run), and
 * compiling every route's schemas was most of a boot (#724). A validator is
 * a pure function of those inputs, so apps may share it; ajv sets
 * `validate.errors` per call and Fastify reads it at once, as concurrent
 * requests on one app already do.
 *
 * The key cannot hold what JSON cannot (ajv `plugins`, `onCreate`: functions),
 * so they are refused rather than ignored: a validator compiled without a
 * plugin an app asked for would be handed back silently (#1083). No app sets
 * them; one that needs them takes its own factory.
 *
 * Used by createApp (the root's compiler, `schemaController`) and
 * jsonApiValidator (the /api/v1 scope's three, src/web/api/validator.ts).
 */
export const sharedValidators: Build = (externalSchemas, options) => {
  if (options?.plugins?.length || options?.onCreate) {
    throw new TypeError(
      'sharedValidators keys on the shared schemas and customOptions only: ajv plugins and onCreate are not supported',
    );
  }
  const compile = factory(externalSchemas, options);
  const scope = JSON.stringify([externalSchemas, options?.customOptions]);
  return (definition) => {
    // The factory's types name a schema; Fastify passes the route's
    // definition, which the factory's own compiler reads `.schema` from.
    const route = definition as RouteSchemaDef;
    const key = `${scope}${route.httpPart}${JSON.stringify(route.schema)}`;
    let validate = compiled.get(key);
    if (!validate) {
      validate = compile(definition);
      compiled.set(key, validate);
    }
    return validate;
  };
};
