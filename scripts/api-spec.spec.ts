import { Validator } from '@seriousme/openapi-schema-validator';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  generateApiSpec,
  nameSchemas,
  serializeSpec,
  SPEC_PATH,
} from './api-spec';

/**
 * The OpenAPI drift test (#190; plan section 5): the committed
 * src/web/api/openapi.json, which GET /api/v1/openapi.json serves, is
 * exactly what the /api/v1 routes' schemas generate. A route or schema
 * change without `npm run api:spec` fails here, so a contract change is
 * always a reviewed diff (what a client generated from the spec needs).
 */

interface Operation {
  operationId?: string;
  tags?: string[];
  security?: unknown[];
  requestBody?: { required: boolean; content: Record<string, unknown> };
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
}

type Spec = {
  paths: Record<string, Record<string, Operation>>;
};

let generated: unknown;

beforeAll(async () => {
  generated = await generateApiSpec();
});

function operations(spec: Spec): [string, Operation][] {
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]): [string, Operation] => [
      `${method.toUpperCase()} ${path}`,
      operation,
    ]),
  );
}

describe('the OpenAPI spec', () => {
  it('is committed as the routes generate it (else: npm run api:spec, commit the diff)', () => {
    expect(readFileSync(SPEC_PATH, 'utf8')).toBe(serializeSpec(generated));
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    // The text as committed (the validator may resolve refs in an object).
    const result = await new Validator().validate(serializeSpec(generated));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect((generated as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('declares every operation: a unique operationId, tags, a 2xx and the problem for 4xx and 5xx', () => {
    const all = operations(generated as Spec);
    expect(all.length).toBeGreaterThan(0);
    const ids = all.map(([, operation]) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [name, operation] of all) {
      expect(operation.operationId, name).toMatch(/^[a-z][A-Za-z]+$/);
      expect(operation.tags?.length, name).toBeGreaterThan(0);
      const statuses = Object.keys(operation.responses);
      expect(
        statuses.some((status) => /^2\d\d$/.test(status)),
        name,
      ).toBe(true);
      for (const status of ['4XX', '5XX']) {
        expect(
          operation.responses[status]?.content,
          `${name} ${status}`,
        ).toEqual({
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        });
      }
    }
  });

  it('leaves out only the bodies that may be absent (#546), and says which are multipart', () => {
    const bodies = operations(generated as Spec).filter(
      ([, operation]) => operation.requestBody,
    );
    const optional = bodies
      .filter(([, operation]) => !operation.requestBody!.required)
      .map(([name]) => name);
    // Union([Object, Null]): Fastify validates an absent body as null.
    expect(optional.sort()).toEqual([
      'POST /api/v1/garments/{id}/clones',
      'POST /api/v1/garments/{id}/copies',
      'PUT /api/v1/garments/{id}/wears/{day}',
    ]);
    const multipart = bodies
      .filter(
        ([, operation]) =>
          'multipart/form-data' in operation.requestBody!.content,
      )
      .map(([name]) => name);
    expect(multipart.sort()).toEqual([
      'POST /api/v1/looks',
      'PUT /api/v1/calendar-entries/{id}/selfie',
      'PUT /api/v1/garments/{id}/photo',
      'PUT /api/v1/garments/{id}/photo/cutout',
      'PUT /api/v1/looks/{id}/photo',
    ]);
  });

  it('asks for the device token everywhere but the sign-in and the spec itself', () => {
    const open = operations(generated as Spec)
      .filter(([, operation]) => operation.security?.length === 0)
      .map(([name]) => name);
    expect(open.sort()).toEqual([
      'GET /api/v1/openapi.json',
      'POST /api/v1/auth/token',
    ]);
  });

  describe('as a client generator reads it (#714)', () => {
    function nodes(root: unknown): Record<string, unknown>[] {
      const found: Record<string, unknown>[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (typeof node === 'object' && node !== null) {
          found.push(node as Record<string, unknown>);
          Object.values(node).forEach(walk);
        }
      };
      walk(root);
      return found;
    }

    it('holds every titled schema once, as a component, and never inline', () => {
      const spec = generated as Spec & {
        components: { schemas: Record<string, { title?: string }> };
      };
      for (const [name, schema] of Object.entries(spec.components.schemas)) {
        expect(schema.title, name).toBe(name);
      }
      const inline = nodes(spec.paths).filter(
        (node) => typeof node.title === 'string' && !('$ref' in node),
      );
      expect(inline.map((node) => node.title)).toEqual([]);
    });

    it('fails the emit when one title names two shapes, but not for a reordered copy', () => {
      const twoShapes = (second: object) => ({
        paths: {
          '/a': { get: { x: { title: 'Pair', type: 'object', required: [] } } },
          '/b': { get: { x: second } },
        },
      });
      expect(() =>
        nameSchemas(twoShapes({ type: 'object', required: [], title: 'Pair' })),
      ).not.toThrow();
      expect(() =>
        nameSchemas(twoShapes({ title: 'Pair', type: 'string' })),
      ).toThrow(/"Pair" names two schemas/);
    });

    it('keeps default and example values verbatim, never hoisting them', () => {
      const data = { title: 'Look', type: 'object' };
      const spec = {
        paths: {
          '/a': {
            x: {
              type: 'object',
              default: data,
              examples: [data],
              enum: [data],
              properties: { default: { title: 'Named', type: 'string' } },
              $defs: { example: { title: 'Defined', type: 'string' } },
            },
          },
        },
      };
      nameSchemas(spec);
      const x = spec.paths['/a'].x as unknown as {
        default: unknown;
        examples: unknown[];
        enum: unknown[];
        properties: { default: unknown };
        $defs: { example: unknown };
      };
      expect(x.default).toEqual(data);
      expect(x.examples).toEqual([data]);
      expect(x.enum).toEqual([data]);
      expect(x.$defs.example).toEqual({ $ref: '#/components/schemas/Defined' });
      expect(x.properties.default).toEqual({
        $ref: '#/components/schemas/Named',
      });
      const { components } = spec as unknown as {
        components: { schemas: object };
      };
      expect(Object.keys(components.schemas)).toEqual(['Named', 'Defined']);
    });

    it('leaves no anyOf of single-value literals, strings or numbers', () => {
      const unions = nodes(generated).filter(
        (node) =>
          Array.isArray(node.anyOf) &&
          node.anyOf.every(
            (branch: { enum?: unknown[] }) => branch.enum?.length === 1,
          ),
      );
      expect(unions).toEqual([]);
    });

    it('collapses number literals as numbers', () => {
      const spec = {
        paths: {
          '/a': {
            x: {
              anyOf: [
                { type: 'integer', enum: [1] },
                { type: 'integer', enum: [2] },
              ],
            },
          },
        },
      };
      nameSchemas(spec);
      expect(spec.paths['/a'].x).toEqual({ type: 'integer', enum: [1, 2] });
    });

    it('points every $ref at a component that exists', () => {
      const spec = generated as { components: { schemas: object } };
      const missing = nodes(spec)
        .map((node) => node.$ref)
        .filter(
          (ref): ref is string =>
            typeof ref === 'string' &&
            !(
              ref.replace('#/components/schemas/', '') in
              spec.components.schemas
            ),
        );
      expect(missing).toEqual([]);
      const mapped = nodes(spec).flatMap((node) =>
        node.discriminator
          ? Object.values(
              (node.discriminator as { mapping: Record<string, string> })
                .mapping,
            )
          : [],
      );
      expect(mapped.length).toBeGreaterThan(0);
    });

    it("discriminates the changes feed's item by resource, mapping each to its component", () => {
      const spec = generated as {
        components: {
          schemas: Record<
            string,
            { properties: { changes: { items: Record<string, unknown> } } }
          >;
        };
      };
      const item = spec.components.schemas.ChangesPage.properties.changes.items;
      expect(item.anyOf).toBeUndefined();
      const branches = item.oneOf as { $ref: string }[];
      const discriminator = item.discriminator as {
        propertyName: string;
        mapping: Record<string, string>;
      };
      expect(discriminator.propertyName).toBe('resource');
      expect(Object.values(discriminator.mapping).sort()).toEqual(
        branches.map((branch) => branch.$ref).sort(),
      );
    });
  });
});
