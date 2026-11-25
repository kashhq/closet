import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wardrobeShare } from '../../src/db/schema';
import type { SharePermission } from '../../src/db/schema';
import {
  acceptInvite,
  createInvite,
  removeShare,
} from '../../src/web/sharing/queries';
import { deviceToken, expectProblem } from './api';
import { createTestApp, type TestApp, userIdOf } from './harness';

/**
 * A garment's and an outfit's public link on /api/v1 (#959): PUT and
 * DELETE .../share, the page's Share and Stop sharing through the same
 * writer (setPublicShare), and `publicShareUrl` on the resources and in
 * the changes feed. The matrix (authorization-*.spec.ts) replays every
 * role on these twins; what each costs is api-statements'.
 */

let t: TestApp;
let owner: string;
let manager: string;
let viewer: string;
let stranger: string;

/** The harness's SITE_URL: the link is absolute on it. */
const LINK = /^http:\/\/localhost:3000\/share\?shareableId=[0-9a-f-]{36}&type=/;

const call = (
  token: string | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => t.api(token, { method, url: `/api/v1${url}`, payload });

async function grantee(email: string, permission?: SharePermission) {
  await t.register(email);
  if (permission) {
    await t.db.insert(wardrobeShare).values({
      grantorId: t.owner.id,
      granteeId: await userIdOf(t, email),
      permission,
      acceptedAt: new Date(),
      createdAt: new Date(),
    });
  }
  return (await deviceToken(t, { email })).token;
}

async function newGarment(name: string): Promise<number> {
  const res = await call(owner, 'POST', '/garments', {
    category: 'shirt',
    name,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

async function newOutfit(name: string): Promise<number> {
  const res = await call(owner, 'POST', '/outfits', {
    name,
    slots: [{ category: 'shirt', garmentId: await newGarment(name) }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

async function share(token: string, path: string, q = ''): Promise<string> {
  const res = await call(token, 'PUT', `${path}/share${q}`);
  expect(res.statusCode, res.body).toBe(200);
  const { publicShareUrl } = res.json<{ publicShareUrl: string }>();
  expect(publicShareUrl).toMatch(LINK);
  return publicShareUrl;
}

async function stop(token: string, path: string, q = ''): Promise<void> {
  const res = await call(token, 'DELETE', `${path}/share${q}`);
  expect(res.statusCode, res.body).toBe(204);
  expect(res.body).toBe('');
}

async function read(token: string, path: string, q = '') {
  const res = await call(token, 'GET', `${path}${q}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ publicShareUrl?: string }>();
}

/** The public page the link opens, signed out. */
const opened = async (link: string) =>
  (
    await t.inject({
      method: 'GET',
      url: link.replace('http://localhost:3000', ''),
      anonymous: true,
    })
  ).statusCode;

beforeAll(async () => {
  t = await createTestApp();
  owner = (await deviceToken(t)).token;
  manager = await grantee('share-api-manager@example.com', 'MANAGE');
  viewer = await grantee('share-api-viewer@example.com', 'VIEW');
  stranger = await grantee('share-api-stranger@example.com');
});

afterAll(async () => {
  await t?.cleanup();
});

describe.each([
  { kind: 'garment', make: newGarment, base: '/garments' },
  { kind: 'outfit', make: newOutfit, base: '/outfits' },
] as const)("$kind's public link", ({ kind, make, base }) => {
  it('shares, answers the same link again, shows it on GET, stops twice as once, and a new share is a new link', async () => {
    const path = `${base}/${await make(`Shared ${kind}`)}`;
    expect(await read(owner, path)).not.toHaveProperty('publicShareUrl');

    const link = await share(owner, path);
    expect(link).toContain(`&type=${kind}`);
    expect(await share(owner, path)).toBe(link);
    expect((await read(owner, path)).publicShareUrl).toBe(link);
    expect(await opened(link)).toBe(200);

    await stop(owner, path);
    await stop(owner, path);
    expect(await read(owner, path)).not.toHaveProperty('publicShareUrl');
    expect(await opened(link)).toBe(404);

    const again = await share(owner, path);
    expect(again).not.toBe(link);
    expect(t.logs.ops(`${kind}.share.set`)).toContainEqual(
      expect.objectContaining({ surface: 'api', shared: false }),
    );
  });

  it('refuses a request without a token as the 401 of every API route', async () => {
    const path = `${base}/${await make(`Anonymous ${kind}`)}`;
    for (const method of ['PUT', 'DELETE'] as const) {
      const res = await call(undefined, method, `${path}/share`);
      expectProblem(res, 401, 'unauthorized');
    }
    expect(await read(owner, path)).not.toHaveProperty('publicShareUrl');
  });
});

describe("who may share: as the garment's and the outfit's pages", () => {
  const q = () => `?ownerId=${t.owner.id}`;

  it('a MANAGE grantee shares and stops a garment and is shown its link; a VIEW grantee is a 403 and is shown none; a stranger a 404', async () => {
    const path = `/garments/${await newGarment('Managed')}`;
    const link = await share(manager, path, q());
    expect((await read(manager, path, q())).publicShareUrl).toBe(link);
    expect((await read(owner, path)).publicShareUrl).toBe(link);

    expect(await read(viewer, path, q())).not.toHaveProperty('publicShareUrl');
    for (const method of ['PUT', 'DELETE'] as const) {
      const url = `${path}/share${q()}`;
      expectProblem(await call(viewer, method, url), 403, 'forbidden');
      expectProblem(await call(stranger, method, url), 404, 'not_found');
      expectProblem(
        await call(stranger, method, `${path}/share`),
        404,
        'not_found',
      );
    }
    // The owner stops a link the grantee made, as on the page.
    expect((await read(owner, path)).publicShareUrl).toBe(link);
    await stop(owner, path);
    expect(await opened(link)).toBe(404);
    await share(owner, path);
    await stop(manager, path, q());
    expect(await read(owner, path)).not.toHaveProperty('publicShareUrl');
  });

  it("an outfit is its owner's alone: every grantee is a stranger, a 404", async () => {
    const path = `/outfits/${await newOutfit('Private')}`;
    const link = await share(owner, path);
    for (const token of [manager, viewer, stranger]) {
      for (const method of ['GET', 'PUT', 'DELETE'] as const) {
        const url = method === 'GET' ? path : `${path}/share`;
        const problem = expectProblem(
          await call(token, method, url),
          404,
          'not_found',
        );
        expect(problem.detail).toBe('Outfit not found');
      }
    }
    expect((await read(owner, path)).publicShareUrl).toBe(link);
  });
});

interface Change {
  resource: string;
  id: number;
  data: { publicShareUrl?: string };
}

/** Every page of the feed after `cursor`: its changes and the cursor it ends on. */
async function sync(token: string, cursor?: string) {
  const all: Change[] = [];
  let at = cursor;
  for (let turn = 0; turn < 20; turn += 1) {
    const res = await call(
      token,
      'GET',
      `/changes${at ? `?cursor=${at}` : ''}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<{
      changes: Change[];
      cursor: string;
      more: boolean;
    }>();
    all.push(...page.changes);
    at = page.cursor;
    if (!page.more) return { changes: all, cursor: at };
  }
  throw new Error('The feed never finished');
}

const changeOf = (changes: Change[], resource: string, id: number) =>
  changes.find((c) => c.resource === resource && c.id === id);

/** An invite of `permission` from the owner, accepted by `granteeId`: what its link does. */
async function accepted(granteeId: number, permission: SharePermission) {
  const invite = await createInvite(t.db, t.owner.id, permission);
  const answer = await acceptInvite(t.db, invite.inviteToken, granteeId);
  if (!answer.accepted) throw new Error(`invite refused: ${answer.reason}`);
  return answer.shareId;
}

describe('the changes feed', () => {
  it('resends a garment and an outfit when shared and when stopped, with the link as each reader is shown it', async () => {
    const garmentId = await newGarment('Synced');
    const outfitId = await newOutfit('Synced outfit');
    const [own, managed, viewed] = await Promise.all(
      [owner, manager, viewer].map((token) => sync(token)),
    );

    const garmentLink = await share(owner, `/garments/${garmentId}`);
    const outfitLink = await share(owner, `/outfits/${outfitId}`);
    const shared = await sync(owner, own.cursor);
    expect(changeOf(shared.changes, 'garment', garmentId)?.data).toMatchObject({
      publicShareUrl: garmentLink,
    });
    expect(changeOf(shared.changes, 'outfit', outfitId)?.data).toMatchObject({
      publicShareUrl: outfitLink,
    });
    // A MANAGE grantee may stop it, so is shown it; a VIEW grantee, as on
    // the page, is resent the garment without it.
    const forManager = await sync(manager, managed.cursor);
    expect(
      changeOf(forManager.changes, 'garment', garmentId)?.data.publicShareUrl,
    ).toBe(garmentLink);
    const forViewer = await sync(viewer, viewed.cursor);
    const seen = changeOf(forViewer.changes, 'garment', garmentId);
    expect(seen).toBeDefined();
    expect(seen?.data).not.toHaveProperty('publicShareUrl');
    expect(changeOf(forViewer.changes, 'outfit', outfitId)).toBeUndefined();

    await stop(owner, `/garments/${garmentId}`);
    await stop(owner, `/outfits/${outfitId}`);
    const stopped = await sync(owner, shared.cursor);
    for (const [resource, id] of [
      ['garment', garmentId],
      ['outfit', outfitId],
    ] as const) {
      const change = changeOf(stopped.changes, resource, id);
      expect(change, `${resource} resent`).toBeDefined();
      expect(change?.data).not.toHaveProperty('publicShareUrl');
    }
  });

  // No garment row moves on a grant's change: the feed resends the wardrobe
  // because the cursor's grant for it differs.
  it('a VIEW share raised to MANAGE is resent the garments shared already, now with their links; then nothing', async () => {
    const email = 'share-api-raised@example.com';
    const token = await grantee(email, 'VIEW');
    const granteeId = await userIdOf(t, email);
    const garmentId = await newGarment('Shared before the raise');
    const link = await share(owner, `/garments/${garmentId}`);
    const viewed = await sync(token);
    expect(
      changeOf(viewed.changes, 'garment', garmentId)?.data,
    ).not.toHaveProperty('publicShareUrl');

    // A MANAGE invite accepted by a VIEW grantee folds into their share.
    await accepted(granteeId, 'MANAGE');
    const raised = await sync(token, viewed.cursor);
    expect(
      changeOf(raised.changes, 'garment', garmentId)?.data.publicShareUrl,
    ).toBe(link);
    expect((await sync(token, raised.cursor)).changes).toEqual([]);
  });

  it('a MANAGE share revoked and given again as VIEW between two syncs is resent its garments without their links', async () => {
    const email = 'share-api-lowered@example.com';
    await t.register(email);
    const granteeId = await userIdOf(t, email);
    const shareId = await accepted(granteeId, 'MANAGE');
    const token = (await deviceToken(t, { email })).token;
    const garmentId = await newGarment('Shared before the downgrade');
    const link = await share(owner, `/garments/${garmentId}`);
    const managed = await sync(token);
    expect(
      changeOf(managed.changes, 'garment', garmentId)?.data.publicShareUrl,
    ).toBe(link);

    await removeShare(t.db, { userId: t.owner.id, surface: 'page' }, shareId);
    await accepted(granteeId, 'VIEW');
    const lowered = await sync(token, managed.cursor);
    const resent = changeOf(lowered.changes, 'garment', garmentId);
    expect(resent, 'garment resent').toBeDefined();
    expect(resent?.data).not.toHaveProperty('publicShareUrl');
    expect((await sync(token, lowered.cursor)).changes).toEqual([]);
  });
});
