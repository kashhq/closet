import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import type { Db } from '../../db/client';
import { Forbidden, NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import {
  createOptionGroup,
  decide,
  markSuggestedProduct,
  suggestionRoom,
} from './decisions';
import { type NeedDetail, readNeed } from './inbox';
import {
  checkSuggestionRoom,
  createNeed,
  makeDecision,
  markSuggestedPick,
  type OwnerDecision,
  requireNeed,
} from './suggestion-actions';

vi.mock('./decisions', () => ({
  createOptionGroup: vi.fn(),
  decide: vi.fn(),
  markSuggestedProduct: vi.fn(),
  suggestionRoom: vi.fn(),
}));
vi.mock('./inbox', () => ({ readNeed: vi.fn() }));

/**
 * The suggestion access path called directly, as the API will call it
 * (#188): the refusals the authorization matrix proves through the inbox
 * routes (test/integration/authorization-wardrobe.routes.ts), decided
 * before anything is read or written. The share comes from the actor's
 * read ahead, so a refusal costs no statement.
 */
const OWNER = 1;
const NEED = 30;
const PICK = 10;
const noStatements = {} as Db;
const deps = { db: noStatements, logger: captureLogs().logger };
const sharedAs = (permission: 'VIEW' | 'MANAGE' | null): Actor => ({
  userId: 2,
  surface: 'page',
  shareReadAhead: { ownerId: OWNER, permission },
});
const stranger = sharedAs(null);
const viewer = sharedAs('VIEW');
const manager = sharedAs('MANAGE');
const owner: Actor = { userId: OWNER, surface: 'page' };

/** Every decision a page makes, with the resource an unseen one reads as. */
const decisions: [OwnerDecision, string][] = [
  [{ kind: 'choose', garmentId: PICK }, 'Garment not found'],
  [
    { kind: 'dismiss-pick', garmentId: PICK, reason: 'style', note: null },
    'Garment not found',
  ],
  [{ kind: 'undo-pick', garmentId: PICK }, 'Garment not found'],
  [
    { kind: 'dismiss-group', groupId: NEED, reason: 'not_now', note: null },
    'Need not found',
  ],
  [{ kind: 'undo-group', groupId: NEED }, 'Need not found'],
  [{ kind: 'returned', garmentId: PICK }, 'Garment not found'],
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('a decision is the owner’s alone', () => {
  it.each(decisions)(
    '%o: a stranger’s is not found',
    async (decision, message) => {
      const refused = makeDecision(deps, stranger, OWNER, decision);
      await expect(refused).rejects.toBeInstanceOf(NotFound);
      await expect(refused).rejects.toMatchObject({ statusCode: 404, message });
      expect(decide).not.toHaveBeenCalled();
    },
  );

  it.each(decisions)('%o: forbidden to a VIEW grantee', async (decision) => {
    await expect(
      makeDecision(deps, viewer, OWNER, decision),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(decisions)('%o: forbidden to a MANAGE grantee', async (decision) => {
    await expect(
      makeDecision(deps, manager, OWNER, decision),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(decide).not.toHaveBeenCalled();
  });

  it("decides in the owner's own wardrobe and answers what moved", async () => {
    vi.mocked(decide).mockResolvedValue({
      ok: true,
      groupId: NEED,
      dismissed: [11],
      restored: [],
    });
    const decided = await makeDecision(deps, owner, '', {
      kind: 'choose',
      garmentId: PICK,
    });
    expect(decided).toMatchObject({ groupId: NEED, dismissed: [11] });
    expect(decide).toHaveBeenCalledWith(noStatements, OWNER, {
      kind: 'choose',
      garmentId: PICK,
    });
  });

  it("is the 404 of what it names when decide finds it not the owner's", async () => {
    vi.mocked(decide).mockResolvedValue({ ok: false, reason: 'not-found' });
    await expect(
      makeDecision(deps, owner, undefined, {
        kind: 'undo-group',
        groupId: NEED,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      resource: 'need',
      logDetail: `undo-group on need ${NEED}: not-found`,
    });
  });

  it('is a 409 for a stale page or a double tap', async () => {
    vi.mocked(decide).mockResolvedValue({ ok: false, reason: 'not-allowed' });
    await expect(
      makeDecision(deps, owner, undefined, {
        kind: 'returned',
        garmentId: PICK,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      logDetail: `returned on garment ${PICK}: not-allowed`,
    });
  });
});

describe('a need is read by whoever reads the wishlist', () => {
  it("is not found in a stranger's wardrobe, before it is read", async () => {
    await expect(
      requireNeed(noStatements, stranger, { id: NEED, ownerId: OWNER }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Need not found' });
    expect(readNeed).not.toHaveBeenCalled();
  });

  it('is read for a VIEW grantee without the owner’s judging', async () => {
    const detail = { need: { id: NEED } } as unknown as NeedDetail;
    vi.mocked(readNeed).mockResolvedValue({ ...detail, searchMs: 0 });
    const read = await requireNeed(noStatements, viewer, {
      id: NEED,
      ownerId: OWNER,
    });
    expect(read.viewOwner).toBe(OWNER);
    expect(readNeed).toHaveBeenCalledWith(noStatements, {
      ownerId: OWNER,
      groupId: NEED,
      viewerId: viewer.userId,
      isOwner: false,
    });
  });

  it('is not found when it is not one of the wardrobe’s', async () => {
    vi.mocked(readNeed).mockResolvedValue(undefined);
    await expect(
      requireNeed(noStatements, owner, { id: NEED, ownerId: undefined }),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'need' });
  });
});

describe("Muse's writes are the caller's own wardrobe", () => {
  const same = {
    id: 12,
    sourceUrl: 'https://shop.example/tee',
    dismissed: true,
    dismissedReason: 'style' as const,
  };

  it("reads the room of the actor's own need, and refuses another's as unknown", async () => {
    vi.mocked(suggestionRoom).mockResolvedValue({
      group: 'missing',
      same: undefined,
    });
    await expect(
      checkSuggestionRoom(noStatements, stranger, NEED, same.sourceUrl),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Need not found' });
    expect(suggestionRoom).toHaveBeenCalledWith(
      noStatements,
      stranger.userId,
      NEED,
      same.sourceUrl,
    );
  });

  it.each([
    [{ group: 'closed', same: undefined }, /decided/],
    [{ group: 'full', same: undefined }, /open options already/],
    [{ group: 'room', same }, /never propose it again/],
  ] as const)('refuses %o before the fetch', async (room, message) => {
    vi.mocked(suggestionRoom).mockResolvedValue(room);
    await expect(
      checkSuggestionRoom(noStatements, owner, NEED, same.sourceUrl),
    ).rejects.toMatchObject({ statusCode: 409, message });
  });

  it('rolls a pick back with the refusal markSuggestedProduct answers', async () => {
    const provenance = { tokenId: 3, groupId: NEED, note: null, rank: null };
    vi.mocked(markSuggestedProduct).mockResolvedValue('full');
    await expect(
      markSuggestedPick(noStatements, owner, PICK, provenance, same.sourceUrl),
    ).rejects.toMatchObject({ statusCode: 409 });
    vi.mocked(markSuggestedProduct).mockResolvedValue('marked');
    await expect(
      markSuggestedPick(noStatements, owner, PICK, provenance, same.sourceUrl),
    ).resolves.toBeUndefined();
    expect(markSuggestedProduct).toHaveBeenCalledWith(
      noStatements,
      OWNER,
      PICK,
      provenance,
      same.sourceUrl,
    );
  });

  it('answers the new need, or a 409 naming the one of that name', async () => {
    const need = { name: 'Blazer', budget: null, note: null, tokenId: 3 };
    vi.mocked(createOptionGroup).mockResolvedValue({ ok: true, id: NEED });
    await expect(createNeed(deps, owner, need)).resolves.toBe(NEED);
    vi.mocked(createOptionGroup).mockResolvedValue({
      ok: false,
      reason: 'dismissed',
      id: NEED,
      dismissedReason: 'not_now',
    });
    await expect(createNeed(deps, owner, need)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(`id ${NEED}, not_now`) as string,
    });
  });
});
