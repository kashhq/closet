import { addDays } from '../../src/calendar-date';
import { type Route, BOTH, outfitName, tripName } from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): trips.
export const ROUTES: Route[] = [
  // Trips (#10) are the owner's own, like outfits: never shared, ?ownerId=
  // ignored, another user's trip, trip outfit or extra a 404 with nothing
  // written. The fixture's trip is on today, with the outfit on today,
  // the garment packed and an extra; a second trip holds an extra to copy.
  // Every case replays on its /api/v1 twin (#194a, `api`) but the
  // destination's, which waits for the API's place search (#195).
  {
    name: 'GET /trips',
    kind: 'read',
    ok: 200,
    secret: tripName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/trips${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/trips${q}` }),
    },
  },
  {
    name: 'GET /trips/:id',
    kind: 'read',
    ok: 200,
    secret: tripName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/trips/${f.tripId}${q}` }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'GET',
        url: `/api/v1/trips/${f.tripId}${q}`,
      }),
    },
  },
  {
    name: 'GET /trips/:id/edit',
    kind: 'read',
    ok: 200,
    secret: tripName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/trips/${f.tripId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /trips/:id/outfits/new',
    kind: 'read',
    ok: 200,
    secret: tripName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/trips/${f.tripId}/outfits/new${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The add page's next page of outfits (#660): the trip's 404 first;
    // below the shared outfit's id + 1, it starts with it.
    name: 'GET /trips/:id/outfits/new/more',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/trips/${f.tripId}/outfits/new/more${q ? `${q}&` : '?'}before=${f.outfitId + 1}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /outfits/ideas?for=trip:ID',
    kind: 'read',
    ok: 200,
    secret: tripName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/outfits/ideas?for=trip:${f.tripId}${q && `&${q.slice(1)}`}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /trips/:id',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}${q}`,
      payload: {
        name: `Renamed ${f.tripName}`,
        startsOn: f.today,
        endsOn: addDays(f.today, 1),
      },
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
        url: `/api/v1/trips/${f.tripId}${q}`,
        payload: {
          name: `Renamed ${f.tripName}`,
          startsOn: f.today,
          endsOn: addDays(f.today, 1),
        },
      }),
    },
  },
  {
    name: 'DELETE /trips/:id',
    kind: 'write',
    ok: 200,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/trips/${f.tripId}${q}`,
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
        url: `/api/v1/trips/${f.tripId}${q}`,
      }),
    },
  },
  {
    name: 'POST /trips/:id/outfits',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/outfits${q}`,
      payload: { outfitId: String(f.outfitId), day: '', occasion: 'evening' },
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
        url: `/api/v1/trips/${f.tripId}/outfits${q}`,
        payload: { outfitId: f.outfitId, occasion: 'evening' },
      }),
    },
  },
  {
    name: 'POST /trips/:id/outfits/:tripOutfitId/delete',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/outfits/${f.tripOutfitId}/delete${q}`,
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
        method: 'DELETE',
        url: `/api/v1/trips/${f.tripId}/outfits/${f.tripOutfitId}${q}`,
      }),
    },
  },
  {
    name: 'POST /trips/:id/outfits/:tripOutfitId/wear',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/outfits/${f.tripOutfitId}/wear${q}`,
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
        method: 'POST',
        url: `/api/v1/trips/${f.tripId}/outfits/${f.tripOutfitId}/wears${q}`,
      }),
    },
  },
  {
    name: 'POST /trips/:id/packed',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/packed${q}`,
      payload: { shown: String(f.garmentId) },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    // One garment's tick, set-state: the fixture's is packed.
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PUT',
        url: `/api/v1/trips/${f.tripId}/packing/${f.garmentId}${q}`,
        payload: { packed: false },
      }),
    },
  },
  {
    name: 'POST /trips/:id/items',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/items${q}`,
      payload: { label: 'Adapter' },
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
        url: `/api/v1/trips/${f.tripId}/items${q}`,
        payload: { label: 'Adapter' },
      }),
    },
  },
  {
    name: 'POST /trips/:id/items/packed',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/items/packed${q}`,
      payload: { packed: String(f.tripItemId), shown: String(f.tripItemId) },
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
        method: 'PATCH',
        url: `/api/v1/trips/${f.tripId}/items/${f.tripItemId}${q}`,
        payload: { packed: true },
      }),
    },
  },
  {
    name: 'POST /trips/:id/items/:itemId/delete',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/items/${f.tripItemId}/delete${q}`,
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
        url: `/api/v1/trips/${f.tripId}/items/${f.tripItemId}${q}`,
      }),
    },
  },
  {
    name: 'POST /trips/:id/items/copy',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/items/copy${q}`,
      payload: { from: String(f.otherTripId) },
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
        method: 'POST',
        url: `/api/v1/trips/${f.tripId}/items/copies${q}`,
        payload: { fromTripId: f.otherTripId },
      }),
    },
  },
  // The destination's weather (WEATHER_ENABLED only): where someone
  // travels is theirs, so a trip's forecast, its place search and setting
  // its destination are the owner's alone.
  {
    name: 'GET /trips/:id/weather',
    kind: 'read',
    ok: 200,
    secret: tripName,
    feature: 'weather',
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/trips/${f.tripId}/weather${q}`,
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
        method: 'GET',
        url: `/api/v1/trips/${f.tripId}/weather${q}`,
      }),
    },
  },
  {
    name: 'GET /trips/:id/places',
    kind: 'read',
    ok: 200,
    secret: tripName,
    feature: 'weather',
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/trips/${f.tripId}/places${q ? `${q}&` : '?'}q=Paris`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /trips/:id/destination',
    kind: 'write',
    ok: 303,
    secret: tripName,
    feature: 'weather',
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/trips/${f.tripId}/destination${q}`,
      payload: { name: 'Paris', latitude: '48.85', longitude: '2.35' },
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
        url: `/api/v1/trips/${f.tripId}/destination${q}`,
        payload: { name: 'Paris', latitude: 48.85, longitude: 2.35 },
      }),
    },
  },
  {
    name: 'POST /outfits/ideas/pick for a trip',
    kind: 'write',
    ok: 303,
    secret: tripName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/outfits/ideas/pick${q}`,
      payload: {
        garmentId: String(f.garmentId),
        for: `trip:${f.tripId}:${addDays(f.today, 1)}`,
      },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    // A trip's pick is the trip's own write, with the idea's garments.
    api: {
      ok: 201,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/trips/${f.tripId}/outfits${q}`,
        payload: {
          garmentIds: [f.garmentId],
          day: addDays(f.today, 1),
        },
      }),
    },
  },
];
