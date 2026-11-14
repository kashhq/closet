import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { asResource, Nullable, project } from './resource';

/*
 * The one rule both surfaces answer a resource record by (#711): its
 * schema decides the keys at every level; the API drops a null the schema
 * does not declare, MCP keeps it.
 */

const Warning = Type.Union([
  Type.Object({ kind: Type.Literal('short'), short: Type.Integer() }),
  Type.Object({ kind: Type.Literal('away'), reason: Type.String() }),
]);

const Item = Type.Object({
  id: Type.Integer(),
  label: Type.Optional(Type.String()),
  cleared: Nullable(Type.String()),
});

const Thing = Type.Object(
  {
    id: Type.Integer(),
    note: Type.Optional(Type.String()),
    items: Type.Array(Item),
    tags: Type.Array(Type.Union([Type.String(), Type.Null()])),
    warnings: Type.Array(Warning),
    nested: Type.Optional(Type.Object({ at: Type.Optional(Type.String()) })),
  },
  { title: 'Thing' },
);

const record = {
  id: 1,
  note: null,
  items: [
    { id: 2, label: null, cleared: null, column: 'internal' },
    { id: 3, label: 'b', cleared: 'x' },
  ],
  tags: ['a', null],
  warnings: [
    { kind: 'away' as const, reason: 'lent', column: 'internal' },
    { kind: 'short' as const, short: 2 },
  ],
  nested: { at: null },
  column: 'internal',
};

describe('asResource', () => {
  it("drops undeclared nulls and the schema's unknown keys at every level, and keeps a declared null", () => {
    expect(asResource(Thing, record)).toStrictEqual({
      id: 1,
      items: [
        { id: 2, cleared: null },
        { id: 3, label: 'b', cleared: 'x' },
      ],
      tags: ['a', null],
      warnings: [
        { kind: 'away', reason: 'lent' },
        { kind: 'short', short: 2 },
      ],
      nested: {},
    });
  });

  it('leaves out an undefined field', () => {
    expect(
      asResource(Thing, { ...record, nested: undefined }),
    ).not.toHaveProperty('nested');
  });

  it('refuses a value that is not JSON’s rather than answering {}', () => {
    const at = new Date() as unknown as string;
    expect(() => asResource(Thing, { ...record, nested: { at } })).toThrow(
      'Thing.nested.at',
    );
  });
});

describe('project', () => {
  it('keeps nulls, shapes kept fields by the schema, and appends own-only fields', () => {
    expect(
      project(
        record,
        Thing,
        {
          id: 'keep',
          note: 'keep',
          items: 'keep',
          tags: 'omit',
          warnings: 'omit',
          nested: 'own',
          column: 'omit',
        },
        { nested: 'mine', today: '2026-11-14' },
      ),
    ).toStrictEqual({
      id: 1,
      note: null,
      items: [
        { id: 2, label: null, cleared: null },
        { id: 3, label: 'b', cleared: 'x' },
      ],
      nested: 'mine',
      today: '2026-11-14',
    });
  });
});
