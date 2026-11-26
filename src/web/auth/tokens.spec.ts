import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { createSessionTokens } from './tokens';

const SECRET = 'a-secret-for-the-tokens-spec-0123456789abcdef';
const tokens = createSessionTokens(SECRET);
const sign = (claims: Record<string, unknown>) =>
  jwt.sign({ userId: 1, pwf: 'abcdefgh', ...claims }, SECRET, {
    algorithm: 'HS256',
  });

describe('session token claims', () => {
  it('carries the restore epoch as sep, and none while never restored', () => {
    const account = {
      id: 1,
      email: 'a@example.com',
      password: 'hash',
      sessionVersion: 0,
    };
    const restored = tokens.issue({ ...account, sessionEpoch: 'epoch-1' });
    expect(tokens.verify(restored)?.sep).toBe('epoch-1');
    const never = tokens.issue({ ...account, sessionEpoch: null });
    expect(tokens.verify(never)).not.toHaveProperty('sep');
  });

  it('accepts a token without sep (issued before restore epochs)', () => {
    expect(tokens.verify(sign({}))).toMatchObject({ userId: 1 });
    expect(tokens.verify(sign({}))).not.toHaveProperty('sep');
  });

  it.each([
    ['a number', 5],
    ['an object', { a: 1 }],
    ['null', null],
  ])('rejects a sep that is %s', (_label, sep) => {
    expect(tokens.verify(sign({ sep }))).toBeUndefined();
  });

  it('carries the session version as sv, and reads a token without it as 0', () => {
    const issued = tokens.issue({
      id: 1,
      email: 'a@example.com',
      password: 'hash',
      sessionEpoch: null,
      sessionVersion: 3,
    });
    expect(tokens.verify(issued)?.sv).toBe(3);
    expect(tokens.verify(sign({}))?.sv).toBe(0);
  });

  it.each([
    ['a string', '1'],
    ['a fraction', 1.5],
    ['null', null],
  ])('rejects an sv that is %s', (_label, sv) => {
    expect(tokens.verify(sign({ sv }))).toBeUndefined();
  });
});
