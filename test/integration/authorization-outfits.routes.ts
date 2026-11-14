import { addDays } from '../../src/calendar-date';
import { multipart } from './harness';
import {
  type Fixture,
  type Route,
  BOTH,
  garmentName,
  outfitName,
  calendarEntry,
  inspirationPhotoName,
  inspirationTitle,
  selfieName,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): outfits, Styling, the calendar and its weekly auto-plan, laundry, insights, selfies, saved looks and images.
export const ROUTES: Route[] = [
  // Outfits and calendar are not shared and ignore ?ownerId; the ownerId
  // via proves a grantee cannot reach them by naming the owner.
  {
    name: 'GET /outfits',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/outfits${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/outfits${q}` }),
    },
  },
  {
    // Styling (#42) from a capsule: the addressed wardrobe's capsule. A
    // grantee styles the owner's through `?ownerId=` (browsing only); by
    // itself the capsule is not in their wardrobe.
    name: 'GET /styling?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling${q ? `${q}&` : '?'}capsule=${f.capsuleId}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    // A strip's next page within a capsule: someone else's capsule matches
    // none of the requester's garments (an empty page, nothing revealed).
    name: 'GET /styling/garments?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling/garments${q ? `${q}&` : '?'}role=none&before=2147483647&capsule=${f.capsuleId}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // "Style this": Styling over a shared wardrobe browses it (a view is
    // enough); Save never takes its garments (POST /styling below). By
    // itself the garment is not in a grantee's wardrobe.
    name: 'GET /styling?with=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling${q ? `${q}&` : '?'}with=${f.garmentId}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    // Shuffle over the rows as posted back, the owner's garment locked in
    // one: a grantee's own wardrobe holds no such garment (the row comes
    // back empty); through `?ownerId=` they browse the owner's.
    name: 'GET /styling/shuffle',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling/shuffle${q ? `${q}&` : '?'}role=top&garmentId=${f.garmentId}&lock=1`,
    }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // "Add row": the rows again, the owner's garment in one.
    name: 'GET /styling/row',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling/row${q ? `${q}&` : '?'}role=top&garmentId=${f.garmentId}&lock=&add=bottom`,
    }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // The fit line (#468b, WEATHER_ENABLED only): the rows' outfit against
    // the requester's own weather. A grantee's own rows hold no such
    // garment; over a share it answers nothing (the owner's weather is
    // theirs); a stranger naming the owner is refused.
    name: 'GET /styling/fit',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    feature: 'weather',
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling/fit${q ? `${q}&` : '?'}role=top&garmentId=${f.garmentId}&lock=`,
    }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // Save: the requester's own garments only, whatever the share.
    name: 'POST /styling',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/styling${q}`,
      payload: {
        garmentId: String(f.garmentId),
        scheduleDate: addDays(f.today, 2),
      },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    // A new outfit's Save is a pick; the garment is the fixture outfit's,
    // which it reuses (200) and plans.
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/outfit-picks${q}`,
        payload: {
          garmentIds: [f.garmentId],
          plan: { day: addDays(f.today, 2) },
        },
      }),
    },
  },
  {
    // "Clashes" on an Ideas card: the requester's own garments only.
    name: 'POST /outfits/ideas/avoid',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/outfits/ideas/avoid${q}`,
      payload: {
        garmentId: [String(f.garmentId), String(f.inspirationTeeId)],
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
        url: `/api/v1/garments/${f.garmentId}/clashes/${f.inspirationTeeId}${q}`,
      }),
    },
  },
  {
    // A new outfit's body names its garments (#704): the owner's alone. A
    // set the fixture's outfit is not, which would answer the saved one.
    name: 'POST /outfits',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/outfits${q}`,
      payload: {
        name: 'Made from ids',
        category: ['shirt'],
        garmentId: [String(f.inspirationTeeId)],
      },
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
        url: `/api/v1/outfits${q}`,
        payload: {
          name: 'Made from ids',
          slots: [{ category: 'shirt', garmentId: f.inspirationTeeId }],
        },
      }),
    },
  },
  {
    // The Ideas strip's next page for a capsule (#704): the requester's own
    // capsule; a grantee's `?ownerId=` is not an address here.
    name: 'GET /outfits/ideas/more?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/outfits/ideas/more${q ? `${q}&` : '?'}capsule=${f.capsuleId}`,
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
        url: `/api/v1/ideas${q ? `${q}&` : '?'}capsuleId=${f.capsuleId}`,
      }),
    },
  },
  {
    // "Wear this" (#704): saves, plans and wears an outfit of the garments
    // named in the body.
    name: 'POST /today/wear',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/today/wear${q}`,
      payload: { garmentId: [String(f.garmentId)], occasion: 'evening' },
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
        url: `/api/v1/outfit-wears${q}`,
        payload: {
          garmentIds: [f.garmentId],
          day: f.today,
          occasion: 'evening',
        },
      }),
    },
  },
  {
    name: 'GET /outfits/:id',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/outfits/${f.outfitId}${q}` }),
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
        url: `/api/v1/outfits/${f.outfitId}${q}`,
      }),
    },
  },
  {
    // Only a redirect into Styling (`?outfit=`, below), which checks the
    // outfit: anyone else is sent there too and learns nothing.
    name: 'GET /outfits/:id/edit',
    kind: 'read',
    ok: 302,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/outfits/${f.outfitId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'ignored',
      viewer: 'ignored',
      stranger: 'ignored',
    },
  },
  {
    // An outfit opened in Styling (#42; /outfits/:id/edit redirects here).
    name: 'GET /styling?outfit=',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling${q ? `${q}&` : '?'}outfit=${f.outfitId}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /styling (an outfit)',
    kind: 'write',
    ok: 303,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/styling${q}`,
      payload: {
        outfit: String(f.outfitId),
        garmentId: String(f.garmentId),
        name: 'Styled again',
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
        method: 'PATCH',
        url: `/api/v1/outfits/${f.outfitId}${q}`,
        payload: {
          name: 'Styled again',
          slots: [{ category: 'shirt', garmentId: f.garmentId }],
        },
      }),
    },
  },
  {
    name: 'POST /outfits/:id',
    kind: 'write',
    ok: 302,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/outfits/${f.outfitId}${q}`,
      payload: { name: 'Renamed' },
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
        url: `/api/v1/outfits/${f.outfitId}${q}`,
        payload: { name: 'Renamed' },
      }),
    },
  },
  ...(
    [
      ['love', (f: Fixture) => f.museOutfitId, {}, { event: 'love' }],
      [
        'dismiss',
        (f: Fixture) => f.museOutfitId,
        { reason: 'style', note: '' },
        { event: 'decline', reason: 'style' },
      ],
      ['undo', (f: Fixture) => f.museDeclinedId, {}, { event: 'reconsider' }],
    ] as const
  ).map(
    ([move, id, payload, reaction]): Route => ({
      name: `POST /outfits/:id/${move}`,
      kind: 'write',
      ok: 303,
      secret: outfitName,
      vias: BOTH,
      request: (f, q) => ({
        method: 'POST',
        url: `/outfits/${id(f)}/${move}${q}`,
        payload,
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
          url: `/api/v1/outfits/${id(f)}/reactions${q}`,
          payload: reaction,
        }),
      },
    }),
  ),
  // The public link (#669): outfits are the owner's alone. No API twin yet (#959).
  ...(['share', 'share/stop'] as const).map(
    (verb): Route => ({
      name: `POST /outfits/:id/${verb}`,
      kind: 'write',
      ok: 200,
      secret: outfitName,
      vias: BOTH,
      request: (f, q) => ({
        method: 'POST',
        url: `/outfits/${f.outfitId}/${verb}${q}`,
      }),
      expect: {
        owner: 'ok',
        manager: 'notFound',
        viewer: 'notFound',
        stranger: 'notFound',
      },
    }),
  ),
  {
    name: 'DELETE /outfits/:id',
    kind: 'write',
    ok: 200,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/outfits/${f.outfitId}${q}`,
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
        url: `/api/v1/outfits/${f.outfitId}${q}`,
      }),
    },
  },
  {
    name: 'GET /calendar',
    kind: 'read',
    ok: 200,
    secret: calendarEntry,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/calendar${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_, q) => ({
        method: 'GET',
        url: `/api/v1/calendar-entries${q}`,
      }),
    },
  },
  {
    // The month of collages (R6): the entry is planned today, in this month,
    // and its cell names its outfit.
    name: 'GET /calendar/month',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/calendar/month${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    // The plan page lists the requester's own outfits to plan (#13).
    name: 'GET /calendar/plan',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({
      method: 'GET',
      url: `/calendar/plan${q ? `${q}&` : '?'}for=day:2030-10-09&occasion=evening`,
    }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'POST /calendar',
    kind: 'write',
    ok: 302,
    secret: outfitName,
    vias: BOTH,
    // Not the entry's day: the fixture already planned the outfit then, and
    // scheduling is idempotent, so the same day would change no row.
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar${q}`,
      payload: {
        date: '2030-10-09',
        outfitId: String(f.outfitId),
        occasion: 'evening',
      },
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
        url: `/api/v1/calendar-entries${q}`,
        payload: {
          day: '2030-10-09',
          outfitId: f.outfitId,
          occasion: 'evening',
        },
      }),
    },
  },
  {
    // Change (#69): the entry takes another outfit. Only its owner reaches
    // the entry; the spare outfit is the owner's too.
    name: 'POST /calendar (replace)',
    kind: 'write',
    ok: 302,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar${q}`,
      payload: {
        date: f.today,
        outfitId: String(f.spareOutfitId),
        occasion: 'all-day',
        replace: String(f.entryId),
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
        url: `/api/v1/calendar-entries/${f.entryId}/outfit${q}`,
        payload: { outfitId: f.spareOutfitId },
      }),
    },
  },
  {
    name: 'POST /calendar/:id/delete',
    kind: 'write',
    ok: 303,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar/${f.entryId}/delete${q}`,
      payload: { week: f.today },
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
        url: `/api/v1/calendar-entries/${f.entryId}${q}`,
      }),
    },
  },
  {
    // The weekly auto-plan's Undo: the batch is its owner's alone.
    name: 'POST /calendar/plan-week/:id/undo',
    kind: 'write',
    ok: 303,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar/plan-week/${f.weekPlanId}/undo${q}`,
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
        url: `/api/v1/week-plans/${f.weekPlanId}${q}`,
      }),
    },
  },
  {
    // The requester's own hamper whatever `?ownerId=` says. Not `shows`:
    // the fixture's garment is not worn (the owner's page lists nothing).
    name: 'GET /laundry',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/laundry${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    // Insights (#17) read the wear log: the requester's own whatever
    // `?ownerId=` says. The owner's never-worn garment is in their
    // unworn list; nobody else's page names it.
    name: 'GET /wardrobe/insights',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/insights${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/insights${q}` }),
    },
  },
  {
    // The year in review (#26) reads the wear log like insights: the
    // requester's own whatever `?ownerId=` says. (The fixture's garment is
    // never worn, so no year is recapped; recap.spec.ts proves a grantee
    // with `?ownerId=` sees their own figures, never the owner's.)
    name: 'GET /wardrobe/recap',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/recap${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/insights/recap${q}` }),
    },
  },
  {
    name: 'POST /laundry',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/laundry${q}`,
      payload: { ids: [String(f.garmentId)] },
    }),
    expect: {
      owner: 'ok',
      manager: 'ignored',
      viewer: 'ignored',
      stranger: 'ignored',
    },
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/garments/washes${q}`,
        payload: { garmentIds: [f.garmentId], day: f.today },
      }),
    },
  },
  // Outfit selfies (#19) are the owner's like the calendar: every refusal
  // is a 404 and stores nothing (the upload is refused before its body is
  // read). A new one replaces the fixture's.
  {
    name: 'POST /calendar/:id/selfie',
    kind: 'write',
    ok: 303,
    secret: selfieName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: f.photo,
            filename: 'selfie.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return {
        method: 'POST',
        url: `/calendar/${f.entryId}/selfie${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: async (f, q) => ({
        method: 'PUT',
        url: `/api/v1/calendar-entries/${f.entryId}/selfie${q}`,
        ...(await multipart(
          {},
          {
            photo: {
              data: f.photo,
              filename: 'selfie.jpg',
              contentType: 'image/jpeg',
            },
          },
        )),
      }),
    },
  },
  {
    name: 'POST /selfies/:id/delete',
    kind: 'write',
    ok: 303,
    secret: selfieName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/selfies/${f.selfieId}/delete${q}`,
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
        url: `/api/v1/selfies/${f.selfieId}${q}`,
      }),
    },
  },
  // The images: the owner's session only, never by name alone.
  ...(['', 'thumb/'] as const).map(
    (variant): Route => ({
      name: `GET /selfies/${variant}:fileName`,
      kind: 'read',
      ok: 200,
      secret: selfieName,
      vias: ['own'],
      request: (f) => ({
        method: 'GET',
        url: `/selfies/${variant}${f.selfieFileName}?v=1`,
      }),
      expect: {
        owner: 'ok',
        manager: 'notFound',
        viewer: 'notFound',
        stranger: 'notFound',
      },
      // The device token's twin: the page's route reads the cookie.
      api: {
        ok: 200,
        request: (f) => ({
          method: 'GET',
          url: `/api/v1/selfie-photos/${f.selfieFileName}?v=1${variant ? '&variant=thumb' : ''}`,
        }),
      },
    }),
  ),
  // Saved looks (#22) are the owner's like the style profile: the list is
  // anyone's own, every refusal of a look a 404 that stores nothing (an
  // upload is refused before its body is read), and `?ownerId=` is ignored.
  {
    name: 'GET /inspiration',
    kind: 'read',
    ok: 200,
    secret: inspirationTitle,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/inspiration${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/looks${q}` }),
    },
  },
  {
    name: 'GET /inspiration/:id',
    kind: 'read',
    ok: 200,
    secret: inspirationTitle,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/inspiration/${f.inspirationId}${q}`,
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
        url: `/api/v1/looks/${f.inspirationId}${q}`,
      }),
    },
  },
  {
    name: 'POST /inspiration/:id',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/inspiration/${f.inspirationId}${q}`,
      payload: { title: 'Renamed', note: 'A note' },
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
        method: 'PATCH',
        url: `/api/v1/looks/${f.inspirationId}${q}`,
        payload: { title: 'Renamed', note: 'A note' },
      }),
    },
  },
  {
    name: 'POST /inspiration/:id/photo',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: f.photo,
            filename: 'look.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return {
        method: 'POST',
        url: `/inspiration/${f.inspirationId}/photo${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    api: {
      ok: 200,
      request: async (f, q) => ({
        method: 'PUT',
        url: `/api/v1/looks/${f.inspirationId}/photo${q}`,
        ...(await multipart(
          {},
          {
            photo: {
              data: f.photo,
              filename: 'look.jpg',
              contentType: 'image/jpeg',
            },
          },
        )),
      }),
    },
  },
  {
    name: 'POST /inspiration/:id/delete',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/inspiration/${f.inspirationId}/delete${q}`,
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
        url: `/api/v1/looks/${f.inspirationId}${q}`,
      }),
    },
  },
  // A look's pieces (#22b) and its match view: the owner's alone.
  {
    name: 'POST /inspiration/:id/pieces',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/inspiration/${f.inspirationId}/pieces${q}`,
      payload: { kind: 'bottom/jeans', color: 'blue', accent: '', pattern: '' },
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
        url: `/api/v1/looks/${f.inspirationId}/pieces${q}`,
        payload: { role: 'bottom', type: 'jeans', colors: ['blue'] },
      }),
    },
  },
  {
    name: 'POST /inspiration/:id/pieces/:position',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/inspiration/${f.inspirationId}/pieces/0${q}`,
      payload: { kind: 'top/shirt', color: 'blue', accent: '', pattern: '' },
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
        url: `/api/v1/looks/${f.inspirationId}/pieces/0${q}`,
        payload: { role: 'top', type: 'shirt', colors: ['blue'] },
      }),
    },
  },
  {
    name: 'POST /inspiration/:id/pieces/:position/delete',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/inspiration/${f.inspirationId}/pieces/0/delete${q}`,
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
        url: `/api/v1/looks/${f.inspirationId}/pieces/0${q}`,
      }),
    },
  },
  {
    name: 'GET /inspiration/:id/recreate',
    kind: 'read',
    ok: 200,
    secret: inspirationTitle,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/inspiration/${f.inspirationId}/recreate${q}`,
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
        url: `/api/v1/looks/${f.inspirationId}/recreation${q}`,
      }),
    },
  },
  // The match view's writes (#22c): the outfit and the wishlist item are
  // the owner's, made from the owner's look alone.
  {
    name: 'POST /inspiration/:id/recreate/outfit',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/inspiration/${f.inspirationId}/recreate/outfit${q}`,
      payload: { position: ['0'], garment: [String(f.inspirationTeeId)] },
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
        url: `/api/v1/looks/${f.inspirationId}/outfits${q}`,
        payload: { choices: [{ position: 0, garmentId: f.inspirationTeeId }] },
      }),
    },
  },
  {
    name: 'POST /inspiration/:id/pieces/:position/find',
    kind: 'write',
    ok: 303,
    secret: inspirationTitle,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/inspiration/${f.inspirationId}/pieces/0/find${q}`,
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
        method: 'PUT',
        url: `/api/v1/looks/${f.inspirationId}/pieces/0/wishlist-item${q}`,
      }),
    },
  },
  // A look's photo: the owner's session only, never by name alone.
  ...(['', 'thumb/'] as const).map(
    (variant): Route => ({
      name: `GET /inspiration/photo/${variant}:fileName`,
      kind: 'read',
      ok: 200,
      secret: inspirationPhotoName,
      vias: ['own'],
      request: (f) => ({
        method: 'GET',
        url: `/inspiration/photo/${variant}${f.inspirationFileName}?v=1`,
      }),
      expect: {
        owner: 'ok',
        manager: 'notFound',
        viewer: 'notFound',
        stranger: 'notFound',
      },
      // The device token's twin: the page's route reads the cookie.
      api: {
        ok: 200,
        request: (f) => ({
          method: 'GET',
          url: `/api/v1/look-photos/${f.inspirationFileName}?v=1${variant ? '&variant=thumb' : ''}`,
        }),
      },
    }),
  ),
  ...(['', 'thumb/', 'nobg/'] as const).map(
    (variant): Route => ({
      name: `GET /file/${variant}:fileName of a saved look`,
      kind: 'read',
      ok: 200,
      secret: inspirationPhotoName,
      vias: ['own'],
      request: (f) => ({
        method: 'GET',
        url: `/file/${variant}${f.inspirationFileName}?v=1`,
      }),
      expect: {
        owner: 'notFound',
        manager: 'notFound',
        viewer: 'notFound',
        stranger: 'notFound',
      },
      anonymous: 'notFound',
    }),
  ),
  // The public image routes serve garment photos by unguessable name to
  // anyone; a selfie's name or share id is a 404 to everyone, its owner
  // included (their pages use /selfies/).
  ...(['', 'thumb/', 'nobg/'] as const).map(
    (variant): Route => ({
      name: `GET /file/${variant}:fileName of a selfie`,
      kind: 'read',
      ok: 200,
      secret: selfieName,
      vias: ['own'],
      request: (f) => ({
        method: 'GET',
        url: `/file/${variant}${f.selfieFileName}?v=1`,
      }),
      expect: {
        owner: 'notFound',
        manager: 'notFound',
        viewer: 'notFound',
        stranger: 'notFound',
      },
      anonymous: 'notFound',
    }),
  ),
  {
    name: 'GET /file/watermark/:shareableId of a selfie',
    kind: 'read',
    ok: 200,
    secret: selfieName,
    vias: ['own'],
    request: (f) => ({
      method: 'GET',
      url: `/file/watermark/${f.selfieShareableId}`,
    }),
    expect: {
      owner: 'notFound',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    anonymous: 'notFound',
  },
];
