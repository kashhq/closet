import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import type { Db } from '../../db/client';
import { wearOutfitOn } from '../calendar/queries';
import { garmentsGoneError } from '../outfits/gone-garments';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { tripModel, tripPageModel } from './model';
import { setPacked } from './packed';
import {
  addTripItems,
  addTripOutfit,
  copyTripItems,
  deleteTrip,
  findTrip,
  findTripOutfit,
  pickForTrip,
  removeTripItem,
  removeTripOutfit,
  setItemsPacked,
  setTripDestination,
  updateTrip,
} from './queries';
import {
  addTripItem,
  copyTripExtras,
  editTrip,
  locateTrip,
  packTrip,
  packTripItems,
  pickIdeaForTrip,
  planTripOutfit,
  removeTrip,
  removeTripExtra,
  requireTrip,
  requireTripModel,
  requireTripPage,
  takeOffTrip,
  tickTripGarment,
  tickTripItem,
  wearTripOutfit,
} from './trip-actions';
import { BY_PERSON } from '../write-origin';

vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addTripItems: vi.fn(),
  addTripOutfit: vi.fn(),
  copyTripItems: vi.fn(),
  deleteTrip: vi.fn(),
  findTrip: vi.fn(),
  findTripOutfit: vi.fn(),
  pickForTrip: vi.fn(),
  removeTripItem: vi.fn(),
  removeTripOutfit: vi.fn(),
  setItemsPacked: vi.fn(),
  setTripDestination: vi.fn(),
  updateTrip: vi.fn(),
}));
vi.mock('./model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tripModel: vi.fn(),
  tripPageModel: vi.fn(),
}));
vi.mock('./packed', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPacked: vi.fn(),
}));
vi.mock('../calendar/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  wearOutfitOn: vi.fn(),
}));
vi.mock('../outfits/gone-garments', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  garmentsGoneError: vi.fn(),
}));

/**
 * The trip path called directly, as the API will call it (#188): trips are
 * private, so a VIEW or MANAGE grantee of the owner's wardrobe is a
 * stranger to the owner's trips. Every query answers for `actor.userId`
 * alone and finds nothing of another's (as the owner-scoped SQL would):
 * the 404 of an unknown id, never a 403
 * (test/integration/authorization-trips.spec.ts proves the routes).
 */
const OWNER = 1;
const OTHER = 2;
const TRIP = 50;
const db = {} as Db;
const { logger, logs } = captureLogs();
const deps = { db, logger };
const sharedAs = (permission: 'VIEW' | 'MANAGE' | null): Actor => ({
  userId: OTHER,
  surface: 'page',
  shareReadAhead: { ownerId: OWNER, permission },
});
const owner: Actor = { userId: OWNER, surface: 'page' };
const others: [string, Actor][] = [
  ['a stranger', sharedAs(null)],
  ['a VIEW grantee', sharedAs('VIEW')],
  ['a MANAGE grantee', sharedAs('MANAGE')],
];
const TODAY = '2026-11-13';
const fields = {
  name: 'Austin',
  destination: null,
  startsOn: TODAY,
  endsOn: TODAY,
  notes: null,
};
const ticks = { tripId: TRIP, packed: [1], unpacked: [] };
const place = {
  name: 'Austin',
  location: { latitude: 30.3, longitude: -97.7, timeZone: 'America/Chicago' },
};

/** Each path, called as `actor`, with its query answering the miss another user's id gets. */
const paths: [string, (actor: Actor) => Promise<unknown>][] = [
  [
    'requireTrip',
    (actor) => {
      vi.mocked(findTrip).mockResolvedValue(undefined);
      return requireTrip(db, actor, TRIP);
    },
  ],
  [
    'requireTripPage',
    (actor) => {
      vi.mocked(tripPageModel).mockResolvedValue(undefined);
      return requireTripPage(db, actor, TRIP, TODAY);
    },
  ],
  [
    'requireTripModel',
    (actor) => {
      vi.mocked(tripModel).mockResolvedValue(undefined);
      return requireTripModel(db, actor, TRIP, TODAY);
    },
  ],
  [
    'editTrip',
    (actor) => {
      vi.mocked(updateTrip).mockResolvedValue('not-found');
      return editTrip(deps, actor, TRIP, fields, TODAY);
    },
  ],
  [
    'removeTrip',
    (actor) => {
      vi.mocked(deleteTrip).mockResolvedValue(false);
      return removeTrip(deps, actor, TRIP);
    },
  ],
  [
    'locateTrip',
    (actor) => {
      vi.mocked(setTripDestination).mockResolvedValue(false);
      return locateTrip(deps, actor, TRIP, place);
    },
  ],
  [
    'planTripOutfit',
    (actor) => {
      vi.mocked(addTripOutfit).mockResolvedValue('no-trip');
      return planTripOutfit(
        deps,
        actor,
        { tripId: TRIP, outfitId: 30 },
        BY_PERSON,
      );
    },
  ],
  [
    'pickIdeaForTrip',
    (actor) => {
      vi.mocked(pickForTrip).mockResolvedValue('no-trip');
      return pickIdeaForTrip(deps, actor, {
        tripId: TRIP,
        garmentIds: [10],
        origin: 'idea',
        madeBy: BY_PERSON,
      });
    },
  ],
  [
    'takeOffTrip',
    (actor) => {
      vi.mocked(removeTripOutfit).mockResolvedValue('not-found');
      return takeOffTrip(deps, actor, { tripId: TRIP, tripOutfitId: 7 });
    },
  ],
  [
    'wearTripOutfit',
    (actor) => {
      vi.mocked(findTripOutfit).mockResolvedValue(undefined);
      return wearTripOutfit(
        deps,
        actor,
        { tripId: TRIP, tripOutfitId: 7 },
        { at: new Date(), today: TODAY },
      );
    },
  ],
  [
    'packTrip',
    (actor) => {
      vi.mocked(setPacked).mockResolvedValue('not-found');
      return packTrip(deps, actor, ticks);
    },
  ],
  [
    'packTripItems',
    (actor) => {
      vi.mocked(setItemsPacked).mockResolvedValue('not-found');
      return packTripItems(deps, actor, ticks);
    },
  ],
  [
    'tickTripGarment',
    (actor) => {
      vi.mocked(setPacked).mockResolvedValue('not-found');
      return tickTripGarment(deps, actor, {
        tripId: TRIP,
        garmentId: 1,
        packed: true,
      });
    },
  ],
  [
    'tickTripItem',
    (actor) => {
      vi.mocked(setItemsPacked).mockResolvedValue('not-found');
      return tickTripItem(deps, actor, {
        tripId: TRIP,
        itemId: 3,
        packed: true,
      });
    },
  ],
  [
    'addTripItem',
    (actor) => {
      vi.mocked(addTripItems).mockResolvedValue('not-found');
      return addTripItem(deps, actor, TRIP, 'Charger');
    },
  ],
  [
    'removeTripExtra',
    (actor) => {
      vi.mocked(removeTripItem).mockResolvedValue(false);
      return removeTripExtra(deps, actor, { tripId: TRIP, itemId: 3 });
    },
  ],
  [
    'copyTripExtras',
    (actor) => {
      vi.mocked(copyTripItems).mockResolvedValue('not-found');
      return copyTripExtras(deps, actor, { fromTripId: 51, toTripId: TRIP });
    },
  ],
];

beforeEach(() => {
  vi.resetAllMocks();
  logs.clear();
});

describe("another user's trip is not found, whatever they share", () => {
  for (const [who, actor] of others) {
    it.each(paths)(`%s: ${who}`, async (_name, call) => {
      const refused = call(actor);
      await expect(refused).rejects.toBeInstanceOf(NotFound);
      await expect(refused).rejects.toMatchObject({
        statusCode: 404,
        message: 'Trip not found',
      });
      // A refusal is the error handler's line, never an operation's.
      expect(logs.records).toEqual([]);
    });
  }

  it("asks every query for the actor's own trips, never the share's owner's", async () => {
    const [, manager] = others[2];
    for (const [, call] of paths) await call(manager).catch(() => undefined);
    expect(findTrip).toHaveBeenCalledWith(db, TRIP, OTHER);
    expect(tripPageModel).toHaveBeenCalledWith(db, OTHER, TRIP, TODAY);
    expect(tripModel).toHaveBeenCalledWith(db, OTHER, TRIP, TODAY);
    expect(updateTrip).toHaveBeenCalledWith(db, TRIP, OTHER, fields, TODAY);
    expect(deleteTrip).toHaveBeenCalledWith(db, TRIP, OTHER);
    expect(setTripDestination).toHaveBeenCalledWith(db, TRIP, OTHER, place);
    expect(addTripOutfit).toHaveBeenCalledWith(db, {
      tripId: TRIP,
      outfitId: 30,
      ownerId: OTHER,
      madeBy: BY_PERSON,
    });
    expect(pickForTrip).toHaveBeenCalledWith(db, OTHER, {
      tripId: TRIP,
      garmentIds: [10],
      origin: 'idea',
      madeBy: BY_PERSON,
    });
    expect(removeTripOutfit).toHaveBeenCalledWith(db, {
      tripId: TRIP,
      tripOutfitId: 7,
      ownerId: OTHER,
    });
    expect(findTripOutfit).toHaveBeenCalledWith(db, {
      tripId: TRIP,
      tripOutfitId: 7,
      ownerId: OTHER,
    });
    expect(setPacked).toHaveBeenCalledWith(db, { ...ticks, ownerId: OTHER });
    expect(setItemsPacked).toHaveBeenCalledWith(db, {
      ...ticks,
      ownerId: OTHER,
    });
    expect(addTripItems).toHaveBeenCalledWith(db, TRIP, OTHER, ['Charger']);
    expect(removeTripItem).toHaveBeenCalledWith(db, {
      tripId: TRIP,
      itemId: 3,
      ownerId: OTHER,
    });
    expect(copyTripItems).toHaveBeenCalledWith(db, {
      fromTripId: 51,
      toTripId: TRIP,
      ownerId: OTHER,
    });
  });
});

describe('the trip path for its owner', () => {
  const outside = { notATripDay: { startsOn: TODAY, endsOn: '2026-11-15' } };

  it("refuses a day outside the trip (400) on both ways in, naming the trip's dates", async () => {
    const refusal = {
      statusCode: 400,
      message: `The date must be a day of the trip, ${TODAY} to 2026-11-15`,
      logDetail: `day 2026-11-20 is outside ${TODAY} to 2026-11-15`,
    };
    vi.mocked(addTripOutfit).mockResolvedValue(outside);
    await expect(
      planTripOutfit(
        deps,
        owner,
        {
          tripId: TRIP,
          outfitId: 30,
          day: '2026-11-20',
        },
        BY_PERSON,
      ),
    ).rejects.toMatchObject(refusal);
    vi.mocked(pickForTrip).mockResolvedValue(outside);
    await expect(
      pickIdeaForTrip(deps, owner, {
        tripId: TRIP,
        garmentIds: [10],
        day: '2026-11-20',
        origin: 'idea',
        madeBy: BY_PERSON,
      }),
    ).rejects.toMatchObject(refusal);
  });

  it('refuses an outfit not theirs as the outfit, and names garments it cannot hold', async () => {
    vi.mocked(addTripOutfit).mockResolvedValue('no-outfit');
    await expect(
      planTripOutfit(deps, owner, { tripId: TRIP, outfitId: 30 }, BY_PERSON),
    ).rejects.toEqual(new NotFound('outfit'));
    const gone = new NotFound('garment');
    vi.mocked(pickForTrip).mockResolvedValue('not-found');
    vi.mocked(garmentsGoneError).mockResolvedValue(gone);
    await expect(
      pickIdeaForTrip(deps, owner, {
        tripId: TRIP,
        garmentIds: [10, 11],
        origin: 'idea',
        madeBy: BY_PERSON,
      }),
    ).rejects.toBe(gone);
    expect(garmentsGoneError).toHaveBeenCalledWith(
      db,
      OWNER,
      [10, 11],
      'closet',
    );
  });

  it('refuses "Wore it" (409) unless the outfit is for today of a trip that is on', async () => {
    const wear = (today: string) =>
      wearTripOutfit(
        deps,
        owner,
        { tripId: TRIP, tripOutfitId: 7 },
        { at: new Date(), today },
      );
    vi.mocked(findTripOutfit).mockResolvedValue({
      outfitId: 30,
      day: '2026-11-14',
      occasion: null,
      trip: { startsOn: TODAY, endsOn: '2026-11-15' },
    });
    await expect(wear(TODAY)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This outfit is for another day of the trip',
      logDetail: `outfit 30 for 2026-11-14 of ${TODAY} to 2026-11-15, today ${TODAY}`,
    });
    await expect(wear('2026-11-16')).rejects.toMatchObject({
      statusCode: 409,
      message: 'The trip is not on today',
    });
    expect(wearOutfitOn).not.toHaveBeenCalled();
    expect(logs.records).toEqual([]);
  });

  // #712: the action logs, once, whichever surface called it; ids are fields.
  it('logs "Wore it" as one trip.outfit.worn line naming its surface', async () => {
    vi.mocked(findTripOutfit).mockResolvedValue({
      outfitId: 30,
      day: null,
      occasion: 'evening',
      trip: { startsOn: TODAY, endsOn: '2026-11-15' },
    });
    vi.mocked(wearOutfitOn).mockResolvedValue({
      entryId: 90,
      scheduled: 'scheduled',
      worn: { worn: true, changed: true, wears: 3, day: TODAY },
    });
    await wearTripOutfit(
      deps,
      { userId: OWNER, surface: 'api' },
      { tripId: TRIP, tripOutfitId: 7 },
      { at: new Date(), today: TODAY },
    );
    expect(logs.records).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'trip.outfit.worn',
        op: 'trip.outfit.worn',
        userId: OWNER,
        surface: 'api',
        tripId: TRIP,
        tripOutfitId: 7,
        outfitId: 30,
        day: TODAY,
        occasion: 'evening',
        entryId: 90,
        entryPlanned: true,
        changed: true,
        wears: 3,
      }),
    ]);
  });
});
