import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCutoutEvent } from '../../cutout/queries';
import type { Db } from '../../db/client';
import { Forbidden, NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { buyWishlistItem } from '../wishlist/purchase';
import {
  addGarmentCopies,
  changeGarmentStatus,
  deleteOwnGarment,
  editGarment,
  garmentToMend,
  logRepair,
  removeRepair,
  replaceGarmentPhoto,
  retryGarmentCutout,
  saveEditedGarmentCutout,
  setGarmentCondition,
  tagGarment,
  turnGarmentPhoto,
  updateGarment,
} from './garment-actions';
import { addCopies } from './lookalikes';
import {
  findGarment,
  type GarmentDetail,
  setCondition,
  updateGarmentFields,
  updateGarmentProperties,
} from './queries';
import { addRepair, deleteRepair } from './repairs';
import { setGarmentStatus } from './status';
import {
  removeGarment,
  replacePhoto,
  rotateGarmentPhoto,
  type WardrobeDeps,
} from './writes';

vi.mock('./queries', () => ({
  findGarment: vi.fn(),
  setCondition: vi.fn(),
  updateGarmentFields: vi.fn(),
  updateGarmentProperties: vi.fn(),
}));
vi.mock('./status', () => ({ setGarmentStatus: vi.fn() }));
vi.mock('./writes', () => ({
  cloneGarment: vi.fn(),
  createGarment: vi.fn(),
  createGarmentOnce: vi.fn(),
  createGarmentWithPendingPhoto: vi.fn(),
  removeGarment: vi.fn(),
  replacePhoto: vi.fn(),
  rotateGarmentPhoto: vi.fn(),
}));
vi.mock('./lookalikes', () => ({ addCopies: vi.fn() }));
vi.mock('./repairs', () => ({ addRepair: vi.fn(), deleteRepair: vi.fn() }));
vi.mock('../../cutout/queries', () => ({ recordCutoutEvent: vi.fn() }));
vi.mock('../auth/queries', () => ({ ownerTransaction: vi.fn() }));

/**
 * The garment write path called directly, as the API will call it (#188):
 * the refusals the authorization matrix proves through the routes and the
 * MCP tools (test/integration/authorization-wardrobe.routes.ts), decided
 * here, before anything is read or written. The share comes from the
 * actor's read ahead, so a refusal costs no statement: `noStatements` has
 * no `select`, and a call that sends one throws.
 */
const OWNER = 1;
const GARMENT = 10;
const noStatements = {} as Db;
const deps = {
  db: noStatements,
  photos: { saveEditedCutout: vi.fn() },
  logger: { info: vi.fn() },
  cutouts: { wake: vi.fn(), enabled: true },
} as unknown as WardrobeDeps;
const sharedAs = (permission: 'VIEW' | 'MANAGE' | null): Actor => ({
  userId: 2,
  surface: 'page',
  shareReadAhead: { ownerId: OWNER, permission },
});
const stranger = sharedAs(null);
const viewer = sharedAs('VIEW');
const manager = sharedAs('MANAGE');
const owner: Actor = { userId: OWNER, surface: 'page' };
const address = { id: GARMENT, ownerId: OWNER };
const garment = {
  id: GARMENT,
  status: 'closet',
  category: 'tops',
  type: null,
  photo: { fileName: 'tee.webp' },
} as GarmentDetail;

/** Each writer, called as a surface would; none may reach its query when refused. */
const writers: [string, (actor: Actor) => Promise<unknown>][] = [
  ['updateGarment', (a) => updateGarment(deps, a, address, {})],
  [
    'editGarment',
    (a) => editGarment(deps, a, address, () => ({ fields: { name: 'x' } })),
  ],
  [
    'setGarmentCondition',
    (a) =>
      setGarmentCondition(deps, a, address, {
        condition: 'good',
        conditionNote: null,
      }),
  ],
  ['tagGarment', (a) => tagGarment(deps, a, address, {})],
  ['addGarmentCopies', (a) => addGarmentCopies(deps, a, address, 1)],
  [
    'replaceGarmentPhoto',
    (a) => replaceGarmentPhoto(deps, a, address, (async function* () {})()),
  ],
  ['turnGarmentPhoto', (a) => turnGarmentPhoto(deps, a, address, 'left')],
  ['retryGarmentCutout', (a) => retryGarmentCutout(deps, a, address)],
  [
    'saveEditedGarmentCutout',
    (a) => saveEditedGarmentCutout(deps, a, address, vi.fn()),
  ],
];

/** The owner's alone: a MANAGE grantee is refused them too. */
const ownerWriters: [string, (actor: Actor) => Promise<unknown>][] = [
  [
    'changeGarmentStatus',
    (a) => changeGarmentStatus(deps, a, address, 'archive'),
  ],
  ['deleteOwnGarment', (a) => deleteOwnGarment(deps, a, address)],
  ['garmentToMend', (a) => garmentToMend(noStatements, a, address)],
  [
    'logRepair',
    (a) =>
      logRepair(deps, a, address, {
        kind: 'repair',
        day: '2026-11-01',
        note: 'Hem',
        cost: null,
      }),
  ],
  ['removeRepair', (a) => removeRepair(deps, a, address, 5)],
  [
    'buyWishlistItem, archiving what it replaces',
    (a) =>
      buyWishlistItem(deps, a, address, {
        acquiredOn: null,
        price: null,
        archiveReplaced: true,
      }),
  ],
];

const primitives = [
  findGarment,
  setCondition,
  updateGarmentFields,
  updateGarmentProperties,
  setGarmentStatus,
  removeGarment,
  replacePhoto,
  rotateGarmentPhoto,
  addCopies,
  addRepair,
  deleteRepair,
  recordCutoutEvent,
];

function expectNothingReached(): void {
  for (const primitive of primitives) expect(primitive).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('the garment write path refuses before it reads or writes', () => {
  it.each([...writers, ...ownerWriters])(
    "%s: a stranger's unknown garment",
    async (_name, call) => {
      const refused = call(stranger);
      await expect(refused).rejects.toBeInstanceOf(NotFound);
      await expect(refused).rejects.toMatchObject({
        statusCode: 404,
        message: 'Garment not found',
      });
      expectNothingReached();
    },
  );

  it.each([...writers, ...ownerWriters])(
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

  // MCP names the wardrobe it addresses (#188b-1).
  it('reads an unseen wardrobe as the wardrobe when the caller named it', async () => {
    await expect(
      addGarmentCopies(deps, stranger, { ...address, unseen: 'wardrobe' }, 1),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Wardrobe not found' });
  });
});

describe('the garment write path for whoever may', () => {
  it("writes a MANAGE grantee's edit into the owner's wardrobe", async () => {
    vi.mocked(updateGarmentFields).mockResolvedValue(true);
    const { viewOwner } = await updateGarment(deps, manager, address, {
      name: 'Tee',
    });
    expect(viewOwner).toBe(OWNER);
    expect(updateGarmentFields).toHaveBeenCalledWith(
      noStatements,
      GARMENT,
      OWNER,
      { name: 'Tee' },
    );
    expect(findGarment).not.toHaveBeenCalled();
  });

  it('is not found for a garment the update did not find', async () => {
    vi.mocked(updateGarmentFields).mockResolvedValue(false);
    await expect(
      updateGarment(deps, owner, address, { name: 'Tee' }),
    ).rejects.toMatchObject({ statusCode: 404, resource: 'garment' });
  });

  it('writes nothing for an edit that changes nothing', async () => {
    vi.mocked(findGarment).mockResolvedValue(garment);
    const edited = await editGarment(deps, manager, address, () => ({
      fields: {},
    }));
    expect(edited.garment).toBe(garment);
    expect(updateGarmentFields).not.toHaveBeenCalled();
  });

  it("answers archive's 409 for a garment whose status does not take it", async () => {
    vi.mocked(setGarmentStatus).mockResolvedValue({
      ok: false,
      reason: 'not-allowed',
      status: 'archived',
    });
    await expect(
      changeGarmentStatus(deps, owner, address, 'archive'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Only a garment in the closet can be archived',
      logDetail: `garment ${GARMENT} is archived`,
    });
  });

  it('is a 409 for a copy of a garment no longer in the closet', async () => {
    vi.mocked(addCopies).mockResolvedValue({
      ok: false,
      reason: 'not-in-closet',
    });
    await expect(
      addGarmentCopies(deps, manager, address, 1),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses the repair log on a wishlist item, not bought yet', async () => {
    vi.mocked(findGarment).mockResolvedValue({
      ...garment,
      status: 'wishlist',
    });
    await expect(
      garmentToMend(noStatements, owner, address),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("is the repair's 404 for an entry not on this garment", async () => {
    vi.mocked(findGarment).mockResolvedValue(garment);
    vi.mocked(deleteRepair).mockResolvedValue(false);
    await expect(removeRepair(deps, owner, address, 5)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Repair not found',
    });
  });

  it('opens the mask upload only after the garment is checked', async () => {
    const upload = vi.fn();
    await expect(
      saveEditedGarmentCutout(deps, viewer, address, upload),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(upload).not.toHaveBeenCalled();
  });
});
