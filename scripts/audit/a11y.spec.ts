import { describe, expect, it } from 'vitest';
import { browserVisits } from './a11y';
import type { AuditRequest, Fixture } from './fixture';
import type { Step } from './walk';

describe('browserVisits', () => {
  const page =
    (over: Partial<AuditRequest> = {}): Step['page'] =>
    () => ({ method: 'GET', url: '/p', ...over });
  const step = (name: string, request?: Step['page']) =>
    ({ issue: 1, name, target: `GET /${name}`, page: request }) as Step;

  it('visits a plain GET page step only', () => {
    const visits = browserVisits({} as Fixture, [
      step('plain', page()),
      step('fragment', page({ htmx: true })),
      step('write', page({ method: 'POST' })),
      step('none'),
    ]);
    expect(visits.map((v) => v.id)).toEqual(['1 plain']);
  });
});
