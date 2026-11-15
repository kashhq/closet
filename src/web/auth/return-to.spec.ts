import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  bounceReturnTo,
  loginUrl,
  MAX_RETURN_TO_LENGTH,
  registerUrl,
  signInReturnTo,
} from './return-to';

describe('signInReturnTo', () => {
  it.each([
    '/calendar?week=2026-11-09',
    '/wardrobe?ownerId=12',
    '/wardrobe-share/invite/0b0e4c52-6f43-4bd1-9b0f-6f0a3f4f1d2e',
    '/auth/profile',
    '/auth/profile/sharing',
    '/%2F/evil.example',
  ])('lands on the page %s', (path) => {
    expect(signInReturnTo(path)).toBe(path);
  });

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash protocol-relative URL', '/\\evil.example'],
    ['a tab hiding a second slash', '/\t/evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['an empty value', ''],
    ['no value', undefined],
    ['a repeated parameter', ['/calendar', '/insights']],
    ['a number', 7],
    ['a value past the cap', `/calendar?q=${'a'.repeat(MAX_RETURN_TO_LENGTH)}`],
    ['the login page (a loop)', '/auth/login?returnTo=/calendar'],
    ['the registration page', '/auth/register'],
    ['sign-out', '/auth/logout'],
    ['a form validator', '/auth/validate/register'],
    ['an account form behind Profile', '/auth/change-password'],
    ['a settings fragment', '/auth/profile/sizes/hint?brand=Uniqlo'],
    ['the API', '/api/v1/me'],
    ['the MCP endpoint', '/mcp'],
    ['an export download', '/wardrobe/export.csv'],
    ['an invite accept (POST-only)', '/wardrobe-share/invite/abc/accept'],
    ['an invite decline (POST-only)', '/wardrobe-share/invite/abc/decline'],
    ['a credential in the query', '/calendar?token=closet_abcdef123456'],
  ])('is Today for %s', (_label, value) => {
    expect(signInReturnTo(value)).toBe('/');
  });
});

describe('loginUrl and registerUrl', () => {
  it('carry a page, encoded', () => {
    expect(loginUrl('/calendar?week=2026-11-09')).toBe(
      '/auth/login?returnTo=%2Fcalendar%3Fweek%3D2026-11-09',
    );
    expect(registerUrl('/wardrobe')).toBe(
      '/auth/register?returnTo=%2Fwardrobe',
    );
  });

  it('stay plain for Today and anything refused (the start_url bounce)', () => {
    expect(loginUrl('/')).toBe('/auth/login');
    expect(loginUrl(undefined)).toBe('/auth/login');
    expect(registerUrl('//evil.example')).toBe('/auth/register');
  });
});

describe('bounceReturnTo', () => {
  const SITE = 'https://closet.example';
  const request = (
    method: string,
    headers: IncomingHttpHeaders,
    url = '/calendar?week=2026-11-09',
  ) => ({ method, url, headers, protocol: 'http' as const, host: 'localhost' });

  it('is a GET navigation’s own URL', () => {
    expect(bounceReturnTo(request('GET', {}), true, SITE)).toBe(
      '/calendar?week=2026-11-09',
    );
  });

  it.each([
    ['the request’s own origin', 'http://localhost/wardrobe/12?x=1'],
    ['SITE_URL’s origin', 'https://closet.example/wardrobe/12?x=1'],
  ])('is a post’s same-origin Referer page, from %s', (_label, referer) => {
    expect(
      bounceReturnTo(request('POST', { referer }, '/x/accept'), true, SITE),
    ).toBe('/wardrobe/12?x=1');
  });

  it.each([
    ['a foreign Referer', { referer: 'https://evil.example/wardrobe' }],
    ['no Referer', {}],
    ['a Referer that is no URL', { referer: '/wardrobe' }],
  ])('is nothing for a post with %s', (_label, headers) => {
    expect(bounceReturnTo(request('POST', headers), true, SITE)).toBe(
      undefined,
    );
  });

  it('is an htmx fragment’s HX-Current-URL page, never the fragment', () => {
    expect(
      bounceReturnTo(
        request('GET', {
          'hx-request': 'true',
          'hx-current-url': 'http://localhost/insights?range=year',
          referer: 'http://localhost/other',
        }),
        false,
        SITE,
      ),
    ).toBe('/insights?range=year');
  });

  it('is nothing for a foreign HX-Current-URL', () => {
    expect(
      bounceReturnTo(
        request('GET', {
          'hx-request': 'true',
          'hx-current-url': 'https://evil.example/insights',
        }),
        false,
        SITE,
      ),
    ).toBe(undefined);
  });

  it('is nothing for an outbox replay', () => {
    expect(
      bounceReturnTo(
        request('POST', {
          'x-closet-queued': '1',
          referer: 'http://localhost/calendar',
        }),
        false,
        SITE,
      ),
    ).toBe(undefined);
  });
});
