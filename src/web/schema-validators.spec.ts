import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { sharedValidators } from './schema-validators';

const definition = (schema: object) =>
  ({ schema, httpPart: 'body', method: 'POST', url: '/x' }) as never;

describe('sharedValidators', () => {
  it('compiles a schema once for the same scope and options', () => {
    const schema = Type.Object({ n: Type.Integer() });
    const a = sharedValidators({}, { customOptions: {} })(definition(schema));
    const b = sharedValidators({}, { customOptions: {} })(definition(schema));
    expect(b).toBe(a);
  });

  it('keeps validators of different customOptions apart', () => {
    const schema = Type.Object({ n: Type.Integer() });
    const coercing = sharedValidators(
      {},
      { customOptions: { coerceTypes: true } },
    )(definition(schema));
    const strict = sharedValidators(
      {},
      { customOptions: { coerceTypes: false } },
    )(definition(schema));
    expect(strict).not.toBe(coercing);
  });

  it('refuses ajv plugins and onCreate, which the key cannot hold', () => {
    expect(() =>
      sharedValidators({}, { customOptions: {}, plugins: [(ajv) => ajv] }),
    ).toThrow(/plugins and onCreate/);
    expect(() =>
      sharedValidators({}, { customOptions: {}, onCreate: () => undefined }),
    ).toThrow(/plugins and onCreate/);
  });

  it('lets an empty plugins list through, as Fastify passes it', () => {
    expect(() =>
      sharedValidators({}, { customOptions: {}, plugins: [] }),
    ).not.toThrow();
  });
});
