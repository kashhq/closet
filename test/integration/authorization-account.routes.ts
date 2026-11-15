import {
  type Route,
  BOTH,
  garmentName,
  OWNER_SIZE_NOTE,
  sizeNote,
  calendarEntry,
  OWNER_DEVICE_NAME,
  OWNER_TOKEN_NAME,
  styleNote,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): the style profile, sizes, agent access and sharing.
export const ROUTES: Route[] = [
  {
    // The style profile (#34): everyone's own; the owner's notes never
    // reach anyone else.
    name: 'GET /auth/profile/style',
    kind: 'read',
    ok: 200,
    secret: styleNote,
    shows: true,
    vias: BOTH,
    request: (_f, q) => ({ method: 'GET', url: `/auth/profile/style${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    // The API's twin reads the same profile and rules; `?ownerId=` is a
    // 400 there (its querystring is closed, #577), ignored on the page.
    api: {
      ok: 200,
      request: (_f, q) => ({
        method: 'GET',
        url: `/api/v1/style-profile${q}`,
      }),
    },
  },
  // Its outfit rules (#21b): the owner's alone, like the profile. The page
  // names the owner's garment in a rule and in the form's picker; anyone
  // else sees their own, and a side or a rule of the owner's is a 404.
  {
    name: 'GET /auth/profile/style (the outfit rules)',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (_f, q) => ({ method: 'GET', url: `/auth/profile/style${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_f, q) => ({
        method: 'GET',
        url: `/api/v1/style-profile${q}`,
      }),
    },
  },
  {
    name: 'POST /auth/profile/style/rules',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/auth/profile/style/rules${q}`,
      payload: { kind: 'always', a: `garment:${f.garmentId}`, b: 'color:red' },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 201,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/outfit-rules${q}`,
        payload: {
          kind: 'always',
          a: { garmentId: f.garmentId },
          b: { color: 'red' },
        },
      }),
    },
  },
  {
    name: 'POST /auth/profile/style/rules/:id/delete',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/auth/profile/style/rules/${f.outfitRuleId}/delete${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 204,
      request: (f, q) => ({
        method: 'DELETE',
        url: `/api/v1/outfit-rules/${f.outfitRuleId}${q}`,
      }),
    },
  },
  // Sizes (#24): everyone's own, like the style profile; the owner's note
  // never reaches a grantee, on the editor, the hint or a shared page.
  {
    name: 'GET /auth/profile/sizes',
    kind: 'read',
    ok: 200,
    secret: sizeNote,
    shows: true,
    vias: BOTH,
    request: (_f, q) => ({ method: 'GET', url: `/auth/profile/sizes${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_f, q) => ({ method: 'GET', url: `/api/v1/sizes${q}` }),
    },
  },
  {
    name: 'GET /auth/profile/sizes/hint',
    kind: 'read',
    ok: 200,
    secret: sizeNote,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/auth/profile/sizes/hint?brand=${encodeURIComponent(f.brand)}${q.replace('?', '&')}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'GET',
        url: `/api/v1/sizes/brands?brand=${encodeURIComponent(f.brand)}${q.replace('?', '&')}`,
      }),
    },
  },
  {
    name: 'POST /auth/profile/sizes/brands/:id',
    kind: 'write',
    ok: 303,
    secret: sizeNote,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/auth/profile/sizes/brands/${f.brandSizeId}${q}`,
      payload: { brand: f.brand, size: 'L', note: OWNER_SIZE_NOTE },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PUT',
        url: `/api/v1/sizes/brands/${f.brandSizeId}${q}`,
        payload: { brand: f.brand, size: 'L', note: OWNER_SIZE_NOTE },
      }),
    },
  },
  {
    name: 'POST /auth/profile/sizes/brands/:id/delete',
    kind: 'write',
    ok: 303,
    secret: sizeNote,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/auth/profile/sizes/brands/${f.brandSizeId}/delete${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 204,
      request: (f, q) => ({
        method: 'DELETE',
        url: `/api/v1/sizes/brands/${f.brandSizeId}${q}`,
      }),
    },
  },
  {
    // A wishlist item's page shows the owner's size in its brand to the
    // owner alone: a grantee reads the item, never the note.
    name: 'GET /wardrobe/:id (a wishlist item’s size note)',
    kind: 'read',
    ok: 200,
    secret: sizeNote,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.wishlistId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'hidden'],
      viewer: ['notFound', 'hidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/wishlist (size notes)',
    kind: 'read',
    ok: 200,
    secret: sizeNote,
    shows: true,
    vias: BOTH,
    request: (_f, q) => ({ method: 'GET', url: `/wardrobe/wishlist${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // The garment form (a MANAGE grantee edits the owner's wishlist item):
    // no hint, not the owner's and not the grantee's own.
    name: 'GET /wardrobe/:id/edit (a wishlist item’s size note)',
    kind: 'read',
    ok: 200,
    secret: sizeNote,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.wishlistId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'hidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  // Agent access (#33): a user's own tokens only. Not object-level through
  // a share: tokens are the account's, like its password.
  {
    name: 'GET /auth/tokens',
    kind: 'read',
    ok: 200,
    secret: () => OWNER_TOKEN_NAME,
    shows: true,
    vias: ['own'],
    request: async (f) => {
      await f.ownerToken();
      return { method: 'GET', url: '/auth/tokens' };
    },
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'POST /auth/tokens/:id/revoke',
    kind: 'write',
    ok: 303,
    secret: () => OWNER_TOKEN_NAME,
    vias: ['own'],
    request: async (f) => ({
      method: 'POST',
      url: `/auth/tokens/${await f.ownerToken()}/revoke`,
    }),
    // Anyone else's revoke lands on their own page with "already revoked"
    // (#189: a stale tab's tap is no error page), alike for every id.
    expect: {
      owner: 'ok',
      manager: 'ignored',
      viewer: 'ignored',
      stranger: 'ignored',
    },
  },
  // The pages #728 split out of Profile: each the signed-in account's own,
  // never reachable through a share. Sharing lists the owner's live invite
  // links, whose token is a bearer secret.
  {
    name: 'GET /auth/profile/sharing',
    kind: 'read',
    ok: 200,
    secret: (f) => f.inviteToken,
    shows: true,
    vias: ['own'],
    request: () => ({ method: 'GET', url: '/auth/profile/sharing' }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'GET /auth/profile/week',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['own'],
    request: () => ({ method: 'GET', url: '/auth/profile/week' }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'GET /auth/profile/weather',
    kind: 'read',
    ok: 200,
    feature: 'weather',
    secret: garmentName,
    vias: ['own'],
    request: () => ({ method: 'GET', url: '/auth/profile/weather' }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'GET /auth/profile/notifications',
    kind: 'read',
    ok: 200,
    feature: 'pwa',
    secret: garmentName,
    vias: ['own'],
    request: () => ({ method: 'GET', url: '/auth/profile/notifications' }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'GET /wardrobe/insights/unworn',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['own'],
    request: () => ({ method: 'GET', url: '/wardrobe/insights/unworn' }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  // Profile › Devices (#189): a native client's sign-in, the account's like
  // its agent tokens.
  {
    name: 'GET /auth/devices',
    kind: 'read',
    ok: 200,
    secret: () => OWNER_DEVICE_NAME,
    shows: true,
    vias: ['own'],
    request: async (f) => {
      await f.ownerToken('device');
      return { method: 'GET', url: '/auth/devices' };
    },
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'POST /auth/devices/:id/revoke',
    kind: 'write',
    ok: 303,
    secret: () => OWNER_DEVICE_NAME,
    vias: ['own'],
    request: async (f) => ({
      method: 'POST',
      url: `/auth/devices/${await f.ownerToken('device')}/revoke`,
    }),
    expect: {
      owner: 'ok',
      manager: 'ignored',
      viewer: 'ignored',
      stranger: 'ignored',
    },
  },
  {
    // Revoking the owner's open invite link (Profile › Sharing): a share
    // row is its grantor's and grantee's, so a grantee of the same
    // wardrobe gets the 404 of an unknown id like anyone else.
    // share-lifecycle.spec.ts covers the grantee leaving.
    name: 'POST /wardrobe-share/:id/remove',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe-share/${f.inviteShareId}/remove${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The MCP endpoint takes a bearer token and nothing else: every
    // session, the owner's included, is a 401 (mcp.spec.ts drives the tools
    // with tokens, shares included).
    name: 'POST /mcp (a session cookie)',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_garment',
          arguments: {
            id: f.garmentId,
            ...(q ? { ownerId: Number(q.split('=')[1]) } : {}),
          },
        },
      },
    }),
    expect: {
      owner: 'unauthorized',
      manager: 'unauthorized',
      viewer: 'unauthorized',
      stranger: 'unauthorized',
    },
    anonymous: 'unauthorized',
  },
  {
    name: 'POST /calendar/:id/worn',
    kind: 'write',
    ok: 303,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar/${f.entryId}/worn${q}`,
      payload: { week: f.today },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PUT',
        url: `/api/v1/calendar-entries/${f.entryId}/worn${q}`,
        payload: { worn: true },
      }),
    },
  },
];
