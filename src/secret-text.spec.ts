import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FILTERED, scrubSecrets } from './secret-text';

const random = () => randomBytes(32).toString('base64url');

describe('scrubSecrets', () => {
  // Each credential shape closet mints (#1291): a narrowed pattern fails here.
  it.each([
    ['an access token', `closet_${random()}`],
    ['an OAuth refresh token', `closet_rt_${random()}`],
    ['an OAuth code', `closet_code_${random()}`],
  ])('filters %s from free text, a form body included', (_name, secret) => {
    const scrubbed = scrubSecrets(
      `grant_type=refresh_token&refresh_token=${secret}&code=${secret} failed`,
    );
    expect(scrubbed).not.toContain(secret.slice(8));
    expect(scrubbed).toBe(
      `grant_type=refresh_token&refresh_token=closet_${FILTERED}&code=closet_${FILTERED} failed`,
    );
  });
});
