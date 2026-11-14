import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { Forbidden, NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import {
  createOwnCapsule,
  deleteOwnCapsule,
  renameCapsule,
  requireCapsule,
  setCapsuleMembers,
  setGarmentCapsules,
} from './capsule-actions';
import {
  changeMembership,
  createCapsule,
  deleteCapsule,
  findCapsule,
  updateCapsule,
} from './queries';

vi.mock('./queries', () => ({
  changeMembership: vi.fn(),
  createCapsule: vi.fn(),
  deleteCapsule: vi.fn(),
  findCapsule: vi.fn(),
  updateCapsule: vi.fn(),
}));

/**
 * The capsule access path called directly, as the API will call it (#188):
 * the refusals the authorization matrix proves through the routes and the
 * MCP tools (test/integration/authorization-capsules.routes.ts), decided
 * before anything is read or written. The share comes from the actor's
 * read ahead, so a refusal costs no statement: `noStatements` has no
 * `select`, and a call that sends one throws.
 */
const OWNER = 1;
const CAPSULE = 20;
const GARMENT = 10;
const noStatements = {} as Db;
const sharedAs = (permission: 'VIEW' | 'MANAGE' | null): Actor => ({
  userId: 2,
  surface: 'page',
  shareReadAhead: { ownerId: OWNER, permission },
});
const stranger = sharedAs(null);
const viewer = sharedAs('VIEW');
const manager = sharedAs('MANAGE');
const owner: Actor = { userId: OWNER, surface: 'page' };
const address = { id: CAPSULE, ownerId: OWNER };
const fields = { name: 'Office', notes: null };
const members = { add: [GARMENT], remove: [] };

/** A MANAGE share or ownership: membership, from either side. */
const managerWriters: [string, (actor: Actor) => Promise<unknown>][] = [
  [
    'setCapsuleMembers',
    (a) => setCapsuleMembers(noStatements, a, address, members),
  ],
  [
    'setGarmentCapsules',
    (a) =>
      setGarmentCapsules(
        noStatements,
        a,
        { id: GARMENT, ownerId: OWNER },
        { add: [CAPSULE], remove: [] },
      ),
  ],
];

/** The owner's alone: a MANAGE grantee is refused them too. */
const ownerWriters: [string, (actor: Actor) => Promise<unknown>][] = [
  ['createOwnCapsule', (a) => createOwnCapsule(noStatements, a, OWNER, fields)],
  ['renameCapsule', (a) => renameCapsule(noStatements, a, address, fields)],
  ['deleteOwnCapsule', (a) => deleteOwnCapsule(noStatements, a, address)],
  [
    'requireCapsule for the edit form',
    (a) => requireCapsule(noStatements, a, address, 'own'),
  ],
];

const primitives = [
  changeMembership,
  createCapsule,
  deleteCapsule,
  findCapsule,
  updateCapsule,
];

function expectNothingReached(): void {
  for (const primitive of primitives) expect(primitive).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('the capsule access path refuses before it reads or writes', () => {
  it.each([
    ...managerWriters,
    ...ownerWriters,
    [
      'requireCapsule',
      (a: Actor) => requireCapsule(noStatements, a, address, 'view'),
    ] as const,
  ])("%s: a stranger's wardrobe is not found", async (_name, call) => {
    const refused = call(stranger);
    await expect(refused).rejects.toBeInstanceOf(NotFound);
    await expect(refused).rejects.toMatchObject({ statusCode: 404 });
    expectNothingReached();
  });

  it.each([...managerWriters, ...ownerWriters])(
    '%s: forbidden to a VIEW grantee',
    async (_name, call) => {
      const refused = call(viewer);
      await expect(refused).rejects.toBeInstanceOf(Forbidden);
      await expect(refused).rejects.toMatchObject({ statusCode: 403 });
      expectNothingReached();
    },
  );

  it.each(ownerWriters)(
    '%s: forbidden to a MANAGE grantee',
    async (_name, call) => {
      await expect(call(manager)).rejects.toBeInstanceOf(Forbidden);
      expectNothingReached();
    },
  );

  it('reads an unseen wardrobe as what the address names', async () => {
    await expect(
      requireCapsule(noStatements, stranger, address, 'view'),
    ).rejects.toMatchObject({ message: 'Capsule not found' });
    await expect(
      setGarmentCapsules(
        noStatements,
        stranger,
        { id: GARMENT, ownerId: OWNER },
        { add: [CAPSULE], remove: [] },
      ),
    ).rejects.toMatchObject({ message: 'Garment not found' });
    // MCP names the wardrobe (#188b-1).
    await expect(
      setCapsuleMembers(
        noStatements,
        stranger,
        { ...address, unseen: 'wardrobe' },
        members,
      ),
    ).rejects.toMatchObject({ message: 'Wardrobe not found' });
  });
});

describe('the capsule access path for whoever may', () => {
  it("opens the grantor's capsule for a VIEW grantee", async () => {
    const capsule = { id: CAPSULE, name: 'Office', notes: null };
    vi.mocked(findCapsule).mockResolvedValue(capsule);
    const opened = await requireCapsule(noStatements, viewer, address, 'view');
    expect(opened).toMatchObject({ capsule, viewOwner: OWNER });
    expect(findCapsule).toHaveBeenCalledWith(noStatements, CAPSULE, OWNER);
  });

  it("changes a MANAGE grantee's membership in the owner's wardrobe", async () => {
    vi.mocked(changeMembership).mockResolvedValue({
      added: 1,
      removed: 0,
      capsules: new Set([CAPSULE]),
      garments: new Set([GARMENT]),
    });
    const changed = await setCapsuleMembers(
      noStatements,
      manager,
      address,
      members,
    );
    expect(changed).toMatchObject({ added: 1, removed: 0, viewOwner: OWNER });
    expect(changeMembership).toHaveBeenCalledWith(noStatements, OWNER, {
      add: { capsuleIds: [CAPSULE], garmentIds: [GARMENT] },
      remove: { capsuleIds: [CAPSULE], garmentIds: [] },
    });
  });

  it('is the 404 after a write that found neither the capsule nor the garment', async () => {
    vi.mocked(changeMembership).mockResolvedValue({
      added: 0,
      removed: 0,
      capsules: new Set(),
      garments: new Set(),
    });
    await expect(
      setCapsuleMembers(noStatements, owner, address, members),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'capsule' });
    await expect(
      setGarmentCapsules(
        noStatements,
        owner,
        { id: GARMENT, ownerId: '' },
        { add: [CAPSULE], remove: [] },
      ),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'garment' });
  });

  it('answers a taken name for the form, and a vanished capsule as not found', async () => {
    vi.mocked(createCapsule).mockResolvedValue('name-taken');
    await expect(
      createOwnCapsule(noStatements, owner, undefined, fields),
    ).resolves.toBe('name-taken');
    vi.mocked(updateCapsule).mockResolvedValue('name-taken');
    await expect(
      renameCapsule(noStatements, owner, address, fields),
    ).resolves.toBe('name-taken');
    vi.mocked(updateCapsule).mockResolvedValue('not-found');
    await expect(
      renameCapsule(noStatements, owner, address, fields),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'capsule' });
    vi.mocked(deleteCapsule).mockResolvedValue(false);
    await expect(
      deleteOwnCapsule(noStatements, owner, address),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'capsule' });
  });

  it("creates the capsule in the actor's own wardrobe", async () => {
    vi.mocked(createCapsule).mockResolvedValue(CAPSULE);
    await expect(
      createOwnCapsule(noStatements, owner, '', fields),
    ).resolves.toMatchObject({ id: CAPSULE, viewOwner: undefined });
    expect(createCapsule).toHaveBeenCalledWith(noStatements, OWNER, fields);
  });
});
