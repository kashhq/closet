import type { MultipartFile } from '@fastify/multipart';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { ownEntryDay } from '../calendar/queries';
import type { Photos } from '../files/photos';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { deleteSelfie, setEntrySelfie } from './queries';
import { attachSelfie, removeSelfie } from './writes';

vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteSelfie: vi.fn(),
  setEntrySelfie: vi.fn(),
}));
vi.mock('../calendar/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ownEntryDay: vi.fn(),
}));

/**
 * The selfie writes called directly, as the API will call them (#188):
 * selfies are private like the calendar, so a VIEW or MANAGE grantee of the
 * owner's wardrobe is a stranger here. Every query answers for
 * `actor.userId` alone and finds nothing of another's (as the owner-scoped
 * SQL does): the 404 of an unknown id, never a 403, and nothing stored or
 * unlinked (test/integration/authorization-outfits.routes.ts proves the
 * routes).
 */
const OWNER = 1;
const OTHER = 2;
const ENTRY = 40;
const SELFIE = 50;
const DAY = '2026-11-12';
const TODAY = '2026-11-13';
const FILE = '0b7f0c1e-0000-4000-8000-000000000001.webp';
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
const storeUploadParts = vi.fn();
const deleteVariants = vi.fn();
const deps = {
  db,
  photos: { storeUploadParts, deleteVariants } as unknown as Photos,
  logger: { info: vi.fn(), warn: vi.fn() } as unknown as Logger,
};
const parts = (async function* () {})() as AsyncIterable<MultipartFile>;
const upload = { entryId: ENTRY, parts, today: TODAY } as const;

beforeEach(() => {
  vi.clearAllMocks();
  // Only the owner's id finds the owner's rows.
  vi.mocked(ownEntryDay).mockImplementation((_db, _id, ownerId) =>
    Promise.resolve(ownerId === OWNER ? DAY : undefined),
  );
  vi.mocked(deleteSelfie).mockImplementation((_db, _id, ownerId) =>
    Promise.resolve(ownerId === OWNER ? FILE : undefined),
  );
  storeUploadParts.mockResolvedValue({ fileName: FILE });
  vi.mocked(setEntrySelfie).mockResolvedValue({
    selfieId: SELFIE,
    day: DAY,
    replaced: null,
    worn: { worn: true, changed: true, wears: 1, day: DAY },
  });
});

describe.each(others)('as %s of the owner’s wardrobe', (_, actor) => {
  it('attachSelfie is NotFound(calendarEntry) before the body is read', async () => {
    await expect(attachSelfie(deps, actor, upload)).rejects.toMatchObject({
      statusCode: 404,
      resource: 'calendarEntry',
    });
    expect(ownEntryDay).toHaveBeenCalledWith(db, ENTRY, OTHER);
    expect(storeUploadParts).not.toHaveBeenCalled();
  });

  it('removeSelfie is NotFound(selfie), nothing unlinked', async () => {
    const refused = await removeSelfie(deps, actor, SELFIE).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(NotFound);
    expect(refused).toMatchObject({ resource: 'selfie' });
    expect(deleteSelfie).toHaveBeenCalledWith(db, SELFIE, OTHER);
    expect(deleteVariants).not.toHaveBeenCalled();
  });
});

describe('as the owner', () => {
  it('attachSelfie stores the photo and answers the selfie and the entry’s day', async () => {
    await expect(attachSelfie(deps, owner, upload)).resolves.toEqual({
      selfieId: SELFIE,
      day: DAY,
      replaced: false,
      worn: { worn: true, changed: true, wears: 1, day: DAY },
    });
    expect(storeUploadParts).toHaveBeenCalledWith(parts, OWNER);
  });

  it('attachSelfie’s write finding the entry gone deletes the new bytes and is NotFound(calendarEntry)', async () => {
    vi.mocked(setEntrySelfie).mockResolvedValue('not-found');
    await expect(attachSelfie(deps, owner, upload)).rejects.toMatchObject({
      resource: 'calendarEntry',
    });
    expect(deleteVariants).toHaveBeenCalledOnce();
  });

  it('removeSelfie unlinks the removed photo', async () => {
    await removeSelfie(deps, owner, SELFIE);
    expect(deleteVariants).toHaveBeenCalledOnce();
  });
});
