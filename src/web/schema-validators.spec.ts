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

  it('refuses a customOptions value JSON cannot hold, naming its path', () => {
    const refused = (customOptions: object) => () =>
      sharedValidators({}, { customOptions });
    expect(refused({ formats: { id: (value: string) => !!value } })).toThrow(
      /customOptions\.formats\.id/,
    );
    expect(refused({ formats: { id: /^\d+$/ } })).toThrow(
      /customOptions\.formats\.id/,
    );
    expect(refused({ keywords: [() => undefined] })).toThrow(
      /customOptions\.keywords\[0\]/,
    );
    expect(refused({ logger: console })).toThrow(/customOptions\.logger/);
    expect(refused({ code: { source: new Set() } })).toThrow(
      /customOptions\.code\.source/,
    );
    expect(refused({ id: Symbol('x') })).toThrow(/customOptions\.id/);
    expect(refused({ count: Number.NaN })).toThrow(/customOptions\.count/);
  });

  it('lets an empty plugins list through, as Fastify passes it', () => {
    expect(() =>
      sharedValidators({}, { customOptions: {}, plugins: [] }),
    ).not.toThrow();
  });
});
