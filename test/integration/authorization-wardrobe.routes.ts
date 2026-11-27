import type { InjectOptions } from 'fastify';
import { multipart } from './harness';
import {
  type Fixture,
  type Route,
  BOTH,
  garmentName,
  needName,
  wishlistName,
  archivedName,
  orderItemName,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): the wardrobe, garments, link import, the wishlist, wears, the order mail.

/** An agent decision (#333): the owner's alone, whatever the share. */
const OWNER_DECIDES: Route['expect'] = {
  owner: 'ok',
  manager: ['notFound', 'forbidden'],
  viewer: ['notFound', 'forbidden'],
  stranger: 'notFound',
};

export const ROUTES: Route[] = [
  // Wardrobe-level routes: the only id they take is ?ownerId.
  {
    name: 'GET /wardrobe',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/garments${q}` }),
    },
  },
  {
    // The grid's next page (its "load more" sentinel).
    name: 'GET /wardrobe/tiles',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({
      method: 'GET',
      url: `/wardrobe/tiles${q ? `${q}&` : '?'}before=2147483647`,
    }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    name: 'GET /wardrobe/new',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/new${q}` }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'POST',
      url: `/wardrobe${q}`,
      payload: { name: 'Planted', category: 'shirt' },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
    api: {
      ok: 201,
      request: (_, q) => ({
        method: 'POST',
        url: `/api/v1/garments${q}`,
        payload: { name: 'Planted', category: 'shirt' },
      }),
    },
  },
  // Adding from a link (link-import/routes.tsx) is a write to the addressed
  // wardrobe. The two posts fetch a photo from the local shop and store it
  // (bytes only, no row), which is the change a success makes.
  {
    name: 'GET /wardrobe/new/from-link',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/new/from-link${q}` }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/new/from-link',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/new/from-link${q}`,
      payload: { url: f.shopPhotoUrl },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
    // The API saves the import at once (MCP's add_garment_from_link): an
    // image link names no category, so the request gives one.
    api: {
      ok: 201,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/link-imports${q}`,
        payload: { url: f.shopPhotoUrl, category: 'tops' },
      }),
    },
  },
  {
    name: 'POST /wardrobe/new/from-link/photo',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/new/from-link/photo${q}`,
      payload: { url: f.shopPhotoUrl },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    // The add sheet's camera and library (#97): the wardrobe is checked
    // before the body is read, so a refusal stores nothing (the snapshot
    // includes DATA_PATH); a success stores the pending photo.
    name: 'POST /wardrobe/new/photo',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: ['ownerId'],
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: f.photo,
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return { method: 'POST', url: `/wardrobe/new/photo${q}`, ...body };
    },
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    // A library pick of several (#200): a batch of drafts for the
    // addressed wardrobe, refused before the body is read like one photo.
    name: 'POST /wardrobe/new/photo (a batch)',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: ['ownerId'],
    request: async (f, q) => {
      const photo = {
        data: f.photo,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      };
      const body = await multipart({}, { photo: [photo, photo] });
      return { method: 'POST', url: `/wardrobe/new/photo${q}`, ...body };
    },
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    // A draft's Discard (#200): only the requester's own draft can go, so
    // the matrix's name (nobody's) discards nothing and ends the queue.
    // Listed as a read for that: nothing may change for anyone, a success
    // included. The discard itself is draft-batch.spec.ts's.
    name: 'POST /wardrobe/new/drafts/discard',
    kind: 'read',
    ok: 303,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'POST',
      url: `/wardrobe/new/drafts/discard${q}`,
      payload: { photo: '00000000-0000-4000-8000-000000000000.webp' },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  ...(['csv', 'json'] as const).map(
    (format): Route => ({
      // The export (#200): the owner's alone. With ?ownerId= a grantee is
      // refused, MANAGE included; without it they export their own.
      name: `GET /wardrobe/export.${format}`,
      kind: 'read',
      ok: 200,
      secret: garmentName,
      shows: true,
      vias: BOTH,
      request: (_, q) => ({
        method: 'GET',
        url: `/wardrobe/export.${format}${q}`,
      }),
      expect: {
        owner: 'ok',
        manager: ['hidden', 'forbidden'],
        viewer: ['hidden', 'forbidden'],
        stranger: ['hidden', 'notFound'],
      },
    }),
  ),
  {
    // Not `shows`: the card is the wardrobe's newest untagged garment, and
    // other cases add garments to the owner's wardrobe, so which one it is
    // depends on order. Refusals must still leak no name. Without ?ownerId
    // a grantee tags their own wardrobe.
    name: 'GET /wardrobe/tag',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/tag${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'forbidden'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // Only ?ownerId: without it a grantee addresses their own wardrobe,
    // where the owner's ids are ignored like unknown ones (a 303 that
    // changes nothing; garment-bulk.spec.ts covers it).
    name: 'POST /wardrobe/bulk',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: ['ownerId'],
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/bulk${q}`,
      payload: { ids: [f.garmentId], property: 'warmth', warmth: '4' },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PATCH',
        url: `/api/v1/garments${q}`,
        payload: { ids: [f.garmentId], property: 'warmth', value: 4 },
      }),
    },
  },
  // Select mode's other verbs (#677), as POST /wardrobe/bulk: only
  // ?ownerId. Archive is the owner's alone (the status), MANAGE included;
  // Mark washed and Add to capsule are MANAGE's too (#680: `launder`).
  ...(['archive', 'washed'] as const).map(
    (verb): Route => ({
      name: `POST /wardrobe/bulk/${verb}`,
      kind: 'write',
      ok: 303,
      secret: garmentName,
      vias: ['ownerId'],
      request: (f, q) => ({
        method: 'POST',
        url: `/wardrobe/bulk/${verb}${q}`,
        payload: { ids: [f.garmentId] },
      }),
      expect: {
        owner: 'ok',
        manager: verb === 'washed' ? 'ok' : 'forbidden',
        viewer: 'forbidden',
        stranger: 'notFound',
      },
    }),
  ),
  {
    // The inspiration tee: a closet garment outside the fixture's capsule,
    // so a success adds a row (the fixture's garment is already a member).
    name: 'POST /wardrobe/bulk/capsule',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: ['ownerId'],
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/bulk/capsule${q}`,
      payload: { ids: [f.inspirationTeeId], capsuleId: f.capsuleId },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PATCH',
        url: `/api/v1/capsules/${f.capsuleId}/members${q}`,
        payload: { add: [f.inspirationTeeId] },
      }),
    },
  },

  // Garment routes. Without ?ownerId a grantee addresses their own wardrobe,
  // which does not hold the owner's garment.
  {
    name: 'GET /wardrobe/:id',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/wardrobe/${f.garmentId}${q}` }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'GET',
        url: `/api/v1/garments/${f.garmentId}${q}`,
      }),
    },
  },
  {
    name: 'GET /wardrobe/:id/edit',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.garmentId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // A VIEW grantee may clone (audit L3): the copy lands in the grantee's
    // own wardrobe and the owner's data is only read. The garment page shows
    // the button to everyone who can see the garment (tested below).
    name: 'GET /wardrobe/:id/clone',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.garmentId}/clone${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/clone',
    kind: 'clone',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/clone${q}`,
      payload: { name: 'Cloned', category: 'shirt' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
    api: {
      ok: 201,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/${f.garmentId}/clones${q}`,
        payload: { name: 'Cloned', category: 'shirt' },
      }),
    },
  },
  {
    name: 'POST /wardrobe/:id',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}${q}`,
      payload: { name: 'Edited', category: 'pants' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PATCH',
        url: `/api/v1/garments/${f.garmentId}${q}`,
        payload: { name: 'Edited', category: 'pants' },
      }),
    },
  },
  {
    name: 'POST /wardrobe/:id/tag',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/tag${q}`,
      payload: { warmth: '3' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PATCH',
        url: `/api/v1/garments/${f.garmentId}/tags${q}`,
        payload: { warmth: 3 },
      }),
    },
  },
  {
    // The garment is looked up before the body is read, so a refused upload
    // stores nothing; the snapshot includes DATA_PATH, which proves it.
    name: 'POST /wardrobe/:id/photo',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: f.photo,
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return {
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/photo${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: async (f, q) => {
        const body = await multipart(
          {},
          {
            photo: {
              data: f.photo,
              filename: 'photo.jpg',
              contentType: 'image/jpeg',
            },
          },
        );
        return {
          method: 'PUT',
          url: `/api/v1/garments/${f.garmentId}/photo${q}`,
          ...body,
        };
      },
    },
  },
  {
    // A turned copy replaces the photo (#199); the snapshot includes
    // DATA_PATH, so a refusal stored no copy.
    name: 'POST /wardrobe/:id/photo/rotate',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/photo/rotate${q}`,
      payload: { direction: 'right' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/${f.garmentId}/photo/rotations${q}`,
        payload: { direction: 'right' },
      }),
    },
  },
  {
    name: 'POST /wardrobe/:id/nobg',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          nobgPhoto: {
            data: f.cutout,
            filename: 'cutout.png',
            contentType: 'image/png',
          },
        },
      );
      return {
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/nobg${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: async (f, q) => {
        const body = await multipart(
          {},
          {
            cutout: {
              data: f.cutout,
              filename: 'cutout.png',
              contentType: 'image/png',
            },
          },
        );
        return {
          method: 'PUT',
          url: `/api/v1/garments/${f.garmentId}/photo/cutout${q}`,
          ...body,
        };
      },
    },
  },
  {
    // The garment page's photo, polled while its cutout is pending.
    name: 'GET /wardrobe/:id/cutout',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.garmentId}/cutout${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    // "Try again" on the fixture's failed cutout: requeues it.
    name: 'POST /wardrobe/:id/cutout/retry',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/cutout/retry${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/${f.garmentId}/photo/cutout/retries${q}`,
      }),
    },
  },
  // The wishlist (#18): shared like capsules. Without ?ownerId a grantee
  // sees their own (empty) wishlist.
  {
    name: 'GET /wardrobe/wishlist',
    kind: 'read',
    ok: 200,
    secret: wishlistName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/wishlist${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/wishlist${q}` }),
    },
  },
  // The agent inbox (#333): read like the wishlist (a VIEW grantee sees
  // The agent's needs and notes), decided by the owner alone: with ?ownerId= a
  // grantee's decision is a 403, without it the pick is not in their
  // wardrobe (decide's 404).
  {
    name: 'GET /wardrobe/wishlist/more',
    kind: 'read',
    ok: 200,
    secret: needName,
    vias: BOTH,
    request: (_, q) => ({
      method: 'GET',
      url: `/wardrobe/wishlist/more?page=2${q && `&${q.slice(1)}`}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    name: 'GET /wardrobe/wishlist/needs/:id',
    kind: 'read',
    ok: 200,
    secret: needName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/wishlist/needs/${f.needId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'GET',
        url: `/api/v1/wishlist/needs/${f.needId}${q}`,
      }),
    },
  },
  ...(
    [
      ['choose', (f: Fixture) => f.needPickId, {}],
      ['dismiss', (f: Fixture) => f.needPickId, { reason: 'style' }],
      ['undo', (f: Fixture) => f.setAsidePickId, {}],
    ] as const
  ).map(
    ([decision, id, payload]): Route => ({
      name: `POST /wardrobe/:id/${decision}`,
      kind: 'write',
      ok: 303,
      secret: needName,
      vias: BOTH,
      request: (f, q) => ({
        method: 'POST',
        url: `/wardrobe/${id(f)}/${decision}${q}`,
        payload,
      }),
      expect: OWNER_DECIDES,
      api: {
        ok: 200,
        request: (f, q) => ({
          method: 'POST',
          url: `/api/v1/garments/${id(f)}/decisions${q}`,
          payload: { event: decision, ...payload },
        }),
      },
    }),
  ),
  {
    // Returned it: an htmx post from the ⋯ menu, like Archive.
    name: 'POST /wardrobe/:id/returned',
    kind: 'write',
    ok: 200,
    secret: needName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.boughtPickId}/returned${q}`,
    }),
    expect: OWNER_DECIDES,
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/${f.boughtPickId}/returns${q}`,
      }),
    },
  },
  ...(
    [
      ['dismiss', (f: Fixture) => f.needId, { reason: 'not_now' }],
      ['undo', (f: Fixture) => f.asideNeedId, {}],
    ] as const
  ).map(
    ([decision, id, payload]): Route => ({
      name: `POST /wardrobe/wishlist/needs/:id/${decision}`,
      kind: 'write',
      ok: 303,
      secret: needName,
      vias: BOTH,
      request: (f, q) => ({
        method: 'POST',
        url: `/wardrobe/wishlist/needs/${id(f)}/${decision}${q}`,
        payload,
      }),
      expect: OWNER_DECIDES,
      api: {
        ok: 200,
        request: (f, q) => ({
          method: 'POST',
          url: `/api/v1/wishlist/needs/${id(f)}/decisions${q}`,
          payload: { event: decision, ...payload },
        }),
      },
    }),
  ),
  {
    name: 'GET /wardrobe/:id/bought',
    kind: 'read',
    ok: 200,
    secret: wishlistName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.wishlistId}/bought${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // "Bought it" is a garment write (the owner and MANAGE); archiving the
    // garment it replaces is the owner's (wishlist.spec.ts: a grantee asking
    // for it is a 403).
    name: 'POST /wardrobe/:id/bought',
    kind: 'write',
    ok: 303,
    secret: wishlistName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.wishlistId}/bought${q}`,
      payload: { acquiredOn: f.today, price: '10' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/${f.wishlistId}/purchases${q}`,
        payload: { acquiredOn: f.today, price: '10' },
      }),
    },
  },
  {
    name: 'POST /wardrobe/:id/restore',
    kind: 'write',
    ok: 200,
    secret: archivedName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.archivedId}/restore${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PUT',
        url: `/api/v1/garments/${f.archivedId}/status${q}`,
        payload: { status: 'closet' },
      }),
    },
  },
  {
    // Archive and delete are owner-only, even for a MANAGE grantee.
    name: 'POST /wardrobe/:id/archive',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/archive${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PUT',
        url: `/api/v1/garments/${f.garmentId}/status${q}`,
        payload: { status: 'archived' },
      }),
    },
  },
  {
    name: 'DELETE /wardrobe/:id',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/wardrobe/${f.garmentId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 204,
      request: (f, q) => ({
        method: 'DELETE',
        url: `/api/v1/garments/${f.garmentId}${q}`,
      }),
    },
  },

  // Wears, washes and away (#7) about a garment a grantee may see: Wore
  // today and Washed are `launder`'s (#680: a MANAGE partner does the
  // laundry), away the owner's own record, so without the capability
  // `?ownerId=` is a 403, and the grantee's own wardrobe a 404 either way.
  // Plain posts (no htmx): the 303 back to the garment. Their /api/v1 twins
  // (#193a) name the day; the wear's undo is authorization-wardrobe.spec.ts'.
  ...(['wear', 'washed', 'away'] as const).map(
    (action): Route => ({
      name: `POST /wardrobe/:id/${action}`,
      kind: 'write',
      ok: 303,
      secret: garmentName,
      vias: BOTH,
      request: (f, q) => ({
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/${action}${q}`,
        payload: {
          wear: { worn: '1' },
          washed: {},
          away: { away: 'lent', awayNote: 'Planted note' },
        }[action],
      }),
      expect: {
        owner: 'ok',
        manager: ['notFound', action === 'away' ? 'forbidden' : 'ok'],
        viewer: ['notFound', 'forbidden'],
        stranger: 'notFound',
      },
      api: {
        ok: 200,
        request: (f, q) => {
          const twins: Record<typeof action, InjectOptions> = {
            wear: {
              method: 'PUT',
              url: `/api/v1/garments/${f.garmentId}/wears/${f.today}${q}`,
            },
            washed: {
              method: 'POST',
              url: `/api/v1/garments/${f.garmentId}/washes${q}`,
              payload: { day: f.today },
            },
            away: {
              method: 'PUT',
              url: `/api/v1/garments/${f.garmentId}/away${q}`,
              payload: { away: 'lent', note: 'Planted note' },
            },
          };
          return twins[action];
        },
      },
    }),
  ),
  // The repair log (#23) is the owner's own record, like wears: a grantee
  // who sees the garment gets a 403 with ?ownerId=, a 404 without it.
  {
    name: 'POST /wardrobe/:id/repairs',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/repairs${q}`,
      payload: { day: f.today, kind: 'alteration', note: 'Planted hem' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 201,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/${f.garmentId}/repairs${q}`,
        payload: { day: f.today, kind: 'alteration', note: 'Planted hem' },
      }),
    },
  },
  {
    name: 'POST /wardrobe/:id/repairs/:repairId/delete',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/repairs/${f.repairId}/delete${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 204,
      request: (f, q) => ({
        method: 'DELETE',
        url: `/api/v1/garments/${f.garmentId}/repairs/${f.repairId}${q}`,
      }),
    },
  },
  // The public link (#669): the owner and a MANAGE grantee, as the ⋯
  // menu's Share always was; its API twin PUT or DELETE .../share (#959).
  ...(['share', 'share/stop'] as const).map(
    (verb): Route => ({
      name: `POST /wardrobe/:id/${verb}`,
      kind: 'write',
      ok: 200,
      secret: garmentName,
      vias: BOTH,
      request: (f, q) => ({
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/${verb}${q}`,
      }),
      expect: {
        owner: 'ok',
        manager: ['notFound', 'ok'],
        viewer: ['notFound', 'forbidden'],
        stranger: 'notFound',
      },
      api: {
        ok: verb === 'share' ? 200 : 204,
        request: (f, q) => ({
          method: verb === 'share' ? 'PUT' : 'DELETE',
          url: `/api/v1/garments/${f.garmentId}/share${q}`,
        }),
      },
    }),
  ),
  {
    // Condition is a garment property: the owner and a MANAGE grantee.
    name: 'POST /wardrobe/:id/condition',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/condition${q}`,
      payload: { condition: 'needs_repair', conditionNote: 'Planted' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PUT',
        url: `/api/v1/garments/${f.garmentId}/condition${q}`,
        payload: { condition: 'needs_repair', conditionNote: 'Planted' },
      }),
    },
  },
  // The duplicate check (#20) is part of adding to the wardrobe, like
  // GET /wardrobe/new; "Add a copy" changes the quantity, a garment
  // property, like condition.
  {
    name: 'GET /wardrobe/lookalikes',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'GET',
      url: `/wardrobe/lookalikes${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/copies',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/copies${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/${f.garmentId}/copies${q}`,
        payload: { copies: 1 },
      }),
    },
  },
  // The order mail's review list (#25) is ORDER_MAIL_OWNER's alone: anyone
  // else gets the 404 of a route that is not there, whatever the share.
  {
    // "Add to closet" opens the prefilled garment form: nothing is saved.
    name: 'POST /wardrobe/orders/:id/add',
    kind: 'read',
    ok: 200,
    secret: orderItemName,
    shows: true,
    feature: 'orderMail',
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/orders/${f.orderItemId}/add${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/orders/:id/dismiss',
    kind: 'write',
    ok: 303,
    secret: orderItemName,
    feature: 'orderMail',
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/orders/${f.orderItemId}/dismiss${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
];
