import { describe, expect, it } from 'vitest';

import { isRouteKey } from '../test/support/statement-budgets';

describe('isRouteKey', () => {
  it('drops a request no route matched', () => {
    expect(isRouteKey('GET:unmatched')).toBe(false);
    expect(isRouteKey('POST:unmatched')).toBe(false);
  });

  it('keeps a route and a templated route', () => {
    expect(isRouteKey('GET:/')).toBe(true);
    expect(isRouteKey('GET:/trips/:id')).toBe(true);
  });
});
