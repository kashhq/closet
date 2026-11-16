import { describe, expect, it } from 'vitest';
import { describeError, HttpError } from './errors';
import type { Translated } from './i18n';
import { Forbidden, NotFound } from './refusals';

describe('refusals', () => {
  // A page renders describeError's answer, MCP its message, the API its code:
  // a NotFound must read on each exactly as the hand-written 404 it replaces.
  it('NotFound is the 404 an unknown id is, worded from the table', () => {
    const refusal = new NotFound('garment', { logDetail: 'garment 9' });
    expect(refusal).toBeInstanceOf(HttpError);
    expect(refusal).toMatchObject({ code: 'not_found', resource: 'garment' });
    expect(describeError(refusal)).toEqual({
      status: 404,
      message: 'Garment not found',
      code: 'not_found',
      logDetail: 'garment 9',
      unexpected: false,
    });
  });

  it('Forbidden is the 403 a bare HttpError(403) answered', () => {
    const refusal = new Forbidden();
    expect(refusal).toBeInstanceOf(HttpError);
    expect(refusal.code).toBe('forbidden');
    expect(describeError(refusal)).toMatchObject({
      status: 403,
      message: 'Forbidden',
      unexpected: false,
    });
  });
});

describe('HttpError code', () => {
  it('defaults from the status, a chosen code kept', () => {
    expect(new HttpError(409).code).toBe('conflict');
    expect(new HttpError(503).code).toBe('busy');
    expect(new HttpError(413).code).toBe('validation');
    expect(new HttpError(500).code).toBe('internal');
    expect(
      new HttpError(409, 'Changed meanwhile' as Translated, { code: 'stale' })
        .code,
    ).toBe('stale');
  });
});
