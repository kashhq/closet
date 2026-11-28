import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentRequest } from '../../src/db/schema';
import { describeMatrix } from './authorization-matrix';
import { ROUTES } from './authorization-account.routes';

describeMatrix('account', ROUTES, (m) => {
  // "Ask your agent" (#681 B1) is the asker's alone, like the account's
  // other records: anyone else, a grantee of either permission included, is
  // the unknown id's 404 on every API route, and nothing moves. The page
  // routes (#1286) join this group's ROUTES with these as their twins.
  it('/api/v1/agent-requests/:id is the asker’s alone', async () => {
    const id = m.shared.agentRequestId;
    const row = () =>
      m.t.db.select().from(agentRequest).where(eq(agentRequest.id, id));
    const before = await row();
    const routes = [
      { method: 'GET', url: `/api/v1/agent-requests/${id}` },
      { method: 'POST', url: `/api/v1/agent-requests/${id}/withdraw` },
      { method: 'POST', url: `/api/v1/agent-requests/${id}/seen` },
    ] as const;
    for (const actor of ['manager', 'viewer', 'stranger'] as const) {
      for (const route of routes) {
        const res = await m.t.api(m.actors[actor].token, route);
        expect(res.statusCode, `${actor} ${route.method} ${route.url}`).toBe(
          404,
        );
        expect(res.body).not.toContain(m.shared.agentRequestBody);
      }
      const list = await m.t.api(m.actors[actor].token, {
        method: 'GET',
        url: '/api/v1/agent-requests',
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(m.shared.agentRequestBody);
    }
    for (const route of routes) {
      expect((await m.t.api(undefined, route)).statusCode).toBe(401);
    }
    expect(await row()).toEqual(before);
    const own = await m.t.api(m.actors.owner.token, routes[0]);
    expect(own.json()).toMatchObject({ id, body: m.shared.agentRequestBody });
  });
});
