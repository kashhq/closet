import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { findCapsule } from '../capsules/queries';
import { Forbidden, NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { requireGarment, searchGarments } from './garment-access';
import {
  findGarment,
  type GarmentDetail,
  garmentSummaries,
  gridCount,
} from './queries';

vi.mock('./queries', () => ({
  findGarment: vi.fn(),
  garmentSummaries: vi.fn(),
  gridCount: vi.fn(),
}));
vi.mock('../capsules/queries', () => ({ findCapsule: vi.fn() }));

/**
 * The garment access path called directly, as the API will call it (#188):
 * the refusals the authorization matrix proves through the routes
 * (test/integration/authorization-wardrobe.routes.ts), decided here. The
 * share comes from the actor's read ahead, so a refusal costs no statement:
 * `noStatements` has no `select`, and a call that sends one throws.
 */
const OWNER = 1;
const GARMENT = 10;
const noStatements = {} as Db;
const viewer: Actor = {
  userId: 2,
  surface: 'page',
  shareReadAhead: { ownerId: OWNER, permission: 'VIEW' },
};
const stranger: Actor = {
  userId: 3,
  surface: 'page',
  shareReadAhead: { ownerId: OWNER, permission: null },
};
const garment = { id: GARMENT, photo: null } as GarmentDetail;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('requireGarment', () => {
  const address = { id: GARMENT, ownerId: OWNER };

  it("is a stranger's unknown garment, whatever the id", async () => {
    const refused = requireGarment(noStatements, stranger, address, 'view');
    await expect(refused).rejects.toBeInstanceOf(NotFound);
    await expect(refused).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
      message: 'Garment not found',
    });
    expect(findGarment).not.toHaveBeenCalled();
  });

  // MCP's actor has no read ahead: the share is one statement of its own.
  it('reads the share itself without a read ahead, and refuses without one', async () => {
    const where = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi.fn(() => ({ from: () => ({ where }) })),
    } as unknown as Db;
    await expect(
      requireGarment(db, { userId: 3, surface: 'page' }, address, 'view'),
    ).rejects.toMatchObject({ resource: 'garment' });
    expect(where).toHaveBeenCalledOnce();
  });

  it("gives a VIEW grantee the owner's garment to read", async () => {
    vi.mocked(findGarment).mockResolvedValue(garment);
    const read = await requireGarment(noStatements, viewer, address, 'view');
    expect(read.garment).toBe(garment);
    expect(read.access).toMatchObject({
      ownerId: OWNER,
      isOwner: false,
      canManage: false,
    });
    expect(read.viewOwner).toBe(OWNER);
    // Read as a VIEW grantee reads it: no price, no notes (#680).
    expect(findGarment).toHaveBeenCalledWith(
      noStatements,
      GARMENT,
      expect.objectContaining({ ownerId: OWNER, role: 'VIEW' }),
    );
  });

  it('forbids a VIEW grantee a change, before the garment is read', async () => {
    const refused = requireGarment(noStatements, viewer, address, 'manage');
    await expect(refused).rejects.toBeInstanceOf(Forbidden);
    await expect(refused).rejects.toMatchObject({ statusCode: 403 });
    expect(findGarment).not.toHaveBeenCalled();
  });

  it('is not found for a garment outside the wardrobe addressed', async () => {
    vi.mocked(findGarment).mockResolvedValue(undefined);
    await expect(
      requireGarment(noStatements, viewer, address, 'view'),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'garment' });
  });
});

describe('searchGarments', () => {
  const search = (filters: { needsWash?: boolean; capsule?: number }) => ({
    ownerId: OWNER,
    filters: {
      scope: 'closet' as const,
      needsWash: false,
      attention: false,
      ...filters,
    },
    limit: 24,
  });

  // The caller named the wardrobe, so the refusal names it too.
  it("is a stranger's unknown wardrobe", async () => {
    await expect(
      searchGarments(noStatements, stranger, search({})),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Wardrobe not found',
    });
  });

  it("forbids a VIEW grantee needs-wash, which reads the owner's wears", async () => {
    await expect(
      searchGarments(noStatements, viewer, search({ needsWash: true })),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'needsWash needs your own wardrobe or a MANAGE share',
    });
    expect(garmentSummaries).not.toHaveBeenCalled();
  });

  it("refuses a capsule that is not the shared wardrobe's", async () => {
    vi.mocked(findCapsule).mockResolvedValue(undefined);
    await expect(
      searchGarments(noStatements, viewer, search({ capsule: 5 })),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'capsule' });
    expect(findCapsule).toHaveBeenCalledWith(noStatements, 5, OWNER);
  });

  it("pages a VIEW grantee through the owner's closet", async () => {
    vi.mocked(garmentSummaries).mockResolvedValue({ garments: [] });
    vi.mocked(gridCount).mockResolvedValue(0);
    expect(await searchGarments(noStatements, viewer, search({}))).toEqual({
      total: 0,
      garments: [],
      next: null,
    });
    expect(garmentSummaries).toHaveBeenCalledWith(
      noStatements,
      expect.objectContaining({ ownerId: OWNER, role: 'VIEW' }),
      expect.any(Object),
      { before: undefined, limit: 24 },
    );
  });
});
