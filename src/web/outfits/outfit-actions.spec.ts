import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { allowPair } from '../gallery/queries';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { undoWeekPlan } from '../week-plan/plan';
import { removeBatchAutoEntries, weekPlanOf } from '../week-plan/queries';
import { newOutfitSlots } from './gone-garments';
import {
  editOutfit,
  proposeOutfitTo,
  reactToProposal,
  removeOutfit,
  requireOutfit,
  requireOutfitPage,
} from './outfit-actions';
import { outfitContext } from './page-context';
import {
  deleteOutfit,
  findOutfit,
  proposeOutfit,
  updateOutfit,
} from './queries';
import { reactToOutfit } from './reactions';

vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteOutfit: vi.fn(),
  findOutfit: vi.fn(),
  proposeOutfit: vi.fn(),
  updateOutfit: vi.fn(),
}));
vi.mock('./page-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  outfitContext: vi.fn(),
}));
vi.mock('./reactions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reactToOutfit: vi.fn(),
}));
vi.mock('./gone-garments', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  newOutfitSlots: vi.fn(),
}));
vi.mock('../auth/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // The owner lock's transaction, run on the same handle.
  ownerTransaction: (
    db: Db,
    _ownerId: number,
    _name: string,
    work: (tx: Db) => Promise<unknown>,
  ) => work(db),
}));
vi.mock('../week-plan/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  removeBatchAutoEntries: vi.fn(),
  weekPlanOf: vi.fn(),
}));

/**
 * The outfit path called directly, as the API will call it (#188), with
 * the week plan's Undo and the gallery's Allow again, the other owner-only
 * records this slice moved: outfits are private, so a share never widens
 * what an actor reaches. Every query answers for `actor.userId` alone, so
 * a VIEW or MANAGE grantee of the owner's wardrobe asks for their own
 * outfit `OUTFIT`, finds none (as the owner-scoped SQL would), and is the
 * 404 of an unknown id, never a 403 that would say the outfit exists
 * (test/integration/authorization-outfits.routes.ts proves the routes).
 */
const OWNER = 1;
const OTHER = 2;
const OUTFIT = 30;
const db = {} as Db;
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
const input = { slots: [] };
const proposal = { tokenId: 7, note: null };

/** Each path, called as `actor`, with its query answering the miss another user's id gets. */
const paths: [string, (actor: Actor) => Promise<unknown>][] = [
  [
    'requireOutfitPage',
    (actor) => {
      vi.mocked(outfitContext).mockResolvedValue(undefined);
      return requireOutfitPage(db, actor, OUTFIT, '2026-11-13');
    },
  ],
  [
    'requireOutfit',
    (actor) => {
      vi.mocked(findOutfit).mockResolvedValue(undefined);
      return requireOutfit(db, actor, OUTFIT);
    },
  ],
  [
    'editOutfit',
    (actor) => {
      vi.mocked(updateOutfit).mockResolvedValue('not-found');
      return editOutfit(db, actor, OUTFIT, input);
    },
  ],
  [
    'removeOutfit',
    (actor) => {
      vi.mocked(deleteOutfit).mockResolvedValue(undefined);
      return removeOutfit(db, actor, OUTFIT);
    },
  ],
  [
    'reactToProposal',
    (actor) => {
      vi.mocked(reactToOutfit).mockResolvedValue({
        ok: false,
        reason: 'not-found',
      });
      return reactToProposal(db, actor, OUTFIT, { event: 'love' });
    },
  ],
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("another user's outfit is not found, whatever they share", () => {
  for (const [who, actor] of others) {
    it.each(paths)(`%s: ${who}`, async (_name, call) => {
      const refused = call(actor);
      await expect(refused).rejects.toBeInstanceOf(NotFound);
      await expect(refused).rejects.toMatchObject({
        statusCode: 404,
        message: 'Outfit not found',
      });
    });
  }

  it("asks every query for the actor's own outfits, never the share's owner's", async () => {
    const [, manager] = others[2];
    for (const [, call] of paths) await call(manager).catch(() => undefined);
    expect(outfitContext).toHaveBeenCalledWith(db, OUTFIT, OTHER, '2026-11-13');
    expect(findOutfit).toHaveBeenCalledWith(db, OUTFIT, OTHER);
    expect(updateOutfit).toHaveBeenCalledWith(db, OUTFIT, OTHER, input);
    expect(deleteOutfit).toHaveBeenCalledWith(db, OUTFIT, OTHER);
    expect(reactToOutfit).toHaveBeenCalledWith(db, OTHER, OUTFIT, {
      event: 'love',
    });
  });
});

describe('the outfit path for its owner', () => {
  it("refuses deleting one of Muse's proposals not loved (409)", async () => {
    vi.mocked(deleteOutfit).mockResolvedValue('a-proposal');
    await expect(removeOutfit(db, owner, OUTFIT)).rejects.toMatchObject({
      statusCode: 409,
      logDetail: `outfit ${OUTFIT} is a proposal not loved`,
    });
  });

  it('refuses a reaction the outfit no longer takes (409)', async () => {
    vi.mocked(reactToOutfit).mockResolvedValue({ ok: false, reason: 'owners' });
    await expect(
      reactToProposal(db, owner, OUTFIT, { event: 'reconsider' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      logDetail: `reaction reconsider on outfit ${OUTFIT}: owners`,
    });
    vi.mocked(reactToOutfit).mockResolvedValue({
      ok: false,
      reason: 'not-allowed',
      reaction: 'declined',
    });
    await expect(
      reactToProposal(db, owner, OUTFIT, { event: 'love' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("answers suggest_outfit's proposal, and refuses the owner's own or a declined set (409)", async () => {
    vi.mocked(newOutfitSlots).mockResolvedValue([
      { category: 'tops', garmentId: 10 },
    ]);
    const asked = { garmentIds: [10], name: null };
    vi.mocked(proposeOutfit).mockResolvedValue({
      ok: true,
      id: OUTFIT,
      slots: 1,
    });
    await expect(proposeOutfitTo(db, owner, asked, proposal)).resolves.toEqual({
      ok: true,
      id: OUTFIT,
      slots: 1,
    });
    expect(newOutfitSlots).toHaveBeenCalledWith(db, OWNER, [10], 'wardrobe');
    vi.mocked(proposeOutfit).mockResolvedValue({
      ok: false,
      reason: 'owners',
      id: OUTFIT,
    });
    await expect(
      proposeOutfitTo(db, owner, asked, proposal),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: `These garments are an outfit of the owner's own already (outfit ${OUTFIT})`,
    });
    vi.mocked(proposeOutfit).mockResolvedValue({
      ok: false,
      reason: 'declined',
      id: OUTFIT,
      dismissedReason: null,
    });
    await expect(
      proposeOutfitTo(db, owner, asked, proposal),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the other owner-only records refuse alike', () => {
  it.each(others)(
    "a week plan's Undo: another's batch is not found to %s",
    async (_who, actor) => {
      vi.mocked(removeBatchAutoEntries).mockResolvedValue([]);
      vi.mocked(weekPlanOf).mockResolvedValue(false);
      await expect(undoWeekPlan(db, actor, 5)).rejects.toMatchObject({
        statusCode: 404,
        message: 'Plan not found',
      });
      expect(weekPlanOf).toHaveBeenCalledWith(db, OTHER, 5);
    },
  );

  it.each(others)(
    'Allow again: a pair the actor never avoided is not found to %s',
    async (_who, actor) => {
      const returning = vi.fn().mockResolvedValue([]);
      const nothingDeleted = {
        delete: () => ({ where: () => ({ returning }) }),
      } as unknown as Db;
      await expect(allowPair(nothingDeleted, actor, 12, 11)).rejects.toEqual(
        new NotFound('avoidedPair'),
      );
      expect(returning).toHaveBeenCalledOnce();
    },
  );
});
