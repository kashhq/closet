import { t } from '../i18n';
import { and, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import type { IsoDate } from '../../calendar-date';
import { initialCutoutState } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import { file, garment, inspiration, inspirationPiece } from '../../db/schema';
import type {
  GarmentColor,
  InspirationPieceRole,
  Pattern,
} from '../../wardrobe/properties';
import type { GarmentStatus } from '../../wardrobe/status';
import type { LookPiece } from '../../wardrobe/recreate';
import type { PrivatePhoto } from '../files/image-url';
import {
  readRecreateInputs,
  type RecreatePoolGarment,
  recreateInputsSql,
} from '../gallery/queries';
import type { OutfitRule } from '../../wardrobe/outfit-rules';
import { takePendingPhoto } from '../files/pending-photos';
import {
  insertPhotoRow,
  lockOwnersAndPhotoName,
  type NewPhotoRow,
} from '../files/queries';
import { HttpError } from '../errors';
import { NotFound } from '../refusals';
import { insertGarment } from '../wardrobe/queries';
import { onWishlist } from '../wardrobe/status';
import { wishlistFieldsOf } from './piece-wishlist';
import { BY_PERSON } from '../write-origin';

/**
 * Saved looks (#22; docs/plans/2026-11-13-inspiration-library.md): the
 * owner's own, like the style profile. Every function is scoped to the
 * owner, and nothing reaches them through a share: another user's look is
 * NotFound like an unknown id. The one writer of `inspiration` is here
 * (saveInspiration, saveInspirationWithPendingPhoto, setInspirationPhoto,
 * updateInspirationText, deleteInspiration), and of `inspiration_piece`
 * (addInspirationPiece, updateInspirationPiece, deleteInspirationPiece,
 * and the match view's recordPieceChoices and setPieceMatch, #22c);
 * the bytes are Photos', stored before and unlinked after by the callers
 * (writes.ts, the commit contract).
 */

/** The title's cap: the column's (varchar 255). */
export const INSPIRATION_TITLE_MAX = 255;
/** The note's cap, the route's: a few paragraphs of what caught the eye. */
export const INSPIRATION_NOTE_MAX = 2000;

/** A look as the list and its page draw it. */
export interface InspirationSummary {
  id: number;
  title: string | null;
  sourceUrl: string | null;
  /** Null for a link saved without a photo. */
  photo: PrivatePhoto | null;
}

/** A look as the list reads it: with how many pieces it is tagged with (MCP's tagging queue). */
export interface ListedInspiration extends InspirationSummary {
  pieceCount: number;
}

/** A piece of a look as the owner read it, at its place in the look. */
export interface StoredPiece extends LookPiece {
  position: number;
  /**
   * The garment chosen for it (matched_garment_id): the closet garment its
   * outfit was saved with, or the wishlist item "Find this" made for it.
   * Null when none is.
   */
  matched: MatchedGarment | null;
}

/** A piece's chosen garment as the match view draws it. */
export interface MatchedGarment {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
}

/** The most pieces a look holds: an outfit's worth, with room for accessories. */
export const INSPIRATION_MAX_PIECES = 12;

export interface InspirationDetail extends InspirationSummary {
  note: string | null;
  /** In their order (position). */
  pieces: StoredPiece[];
}

export interface InspirationText {
  title: string | null;
  note: string | null;
}

const SUMMARY_COLUMNS = {
  id: inspiration.id,
  title: inspiration.title,
  sourceUrl: inspiration.sourceUrl,
  fileName: file.fileName,
  version: file.version,
};

function photoOf(row: {
  fileName: string | null;
  version: number | null;
}): PrivatePhoto | null {
  return row.fileName === null
    ? null
    : { fileName: row.fileName, version: row.version ?? 1 };
}

/** A page of looks: those older than `before` (an id), at most `limit`. */
export interface InspirationPage {
  before?: number;
  limit: number;
}

/**
 * The owner's looks, newest first, a `page` at a time: the Inspiration
 * tab's one statement after the session's (inspiration_owner_id_id_index,
 * read backward), its sentinel's, list_inspiration's and GET /api/v1/looks'
 * (#528: a library has no upload cap, so no reader takes all of it). `next`
 * is the last id of the page when more follow, to come back as `before`.
 */
export async function listInspirations(
  db: Db,
  ownerId: number,
  { before, limit }: InspirationPage,
): Promise<{ looks: ListedInspiration[]; next: number | null }> {
  // One more than the page: whether another follows.
  const rows = await db
    .select({
      ...SUMMARY_COLUMNS,
      pieceCount: sql<number>`(select count(*)::int from ${inspirationPiece} where ${eq(inspirationPiece.inspirationId, inspiration.id)})`,
    })
    .from(inspiration)
    .leftJoin(file, eq(file.id, inspiration.photoId))
    .where(
      and(
        eq(inspiration.ownerId, ownerId),
        before === undefined ? undefined : lt(inspiration.id, before),
      ),
    )
    .orderBy(desc(inspiration.id))
    .limit(limit + 1);
  const looks = rows.slice(0, limit).map(({ fileName, version, ...row }) => ({
    ...row,
    photo: photoOf({ fileName, version }),
  }));
  return { looks, next: rows.length > limit ? looks[limit - 1].id : null };
}

type PieceJson = [
  position: number,
  role: InspirationPieceRole,
  type: string | null,
  colors: GarmentColor[],
  pattern: Pattern | null,
  matched: MatchedGarment | null,
];

interface LookJson {
  id: number;
  title: string | null;
  note: string | null;
  sourceUrl: string | null;
  fileName: string | null;
  version: number | null;
  pieces: PieceJson[];
}

/**
 * The owner's look `id` with its photo and its pieces, as a scalar
 * subquery (null when it is not theirs), so a page reads it in one
 * statement with whatever else it needs (the match view: the closet).
 */
function lookJsonSql(id: number, ownerId: number): SQL<LookJson | null> {
  return sql<LookJson | null>`(
    select json_build_object(
      'id', ${inspiration.id},
      'title', ${inspiration.title},
      'note', ${inspiration.note},
      'sourceUrl', ${inspiration.sourceUrl},
      'fileName', ${file.fileName},
      'version', ${file.version},
      'pieces', (
        select coalesce(json_agg(json_build_array(
          ${inspirationPiece.position}, ${inspirationPiece.role},
          ${inspirationPiece.type}, ${inspirationPiece.colors},
          ${inspirationPiece.pattern},
          case when ${garment.id} is not null then json_build_object(
            'id', ${garment.id}, 'name', ${garment.name},
            'category', ${garment.category}, 'status', ${garment.status}
          ) end
        ) order by ${inspirationPiece.position}), '[]')
        from ${inspirationPiece}
        left join ${garment} on ${and(
          eq(garment.id, inspirationPiece.matchedGarmentId),
          eq(garment.ownerId, inspiration.ownerId),
        )}
        where ${eq(inspirationPiece.inspirationId, inspiration.id)}
      )
    )
    from ${inspiration}
    left join ${file} on ${eq(file.id, inspiration.photoId)}
    where ${and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId))}
  )`;
}

function readLook(json: LookJson | null): InspirationDetail {
  if (!json) throw new NotFound('inspiration');
  const { fileName, version, pieces, ...look } = json;
  return {
    ...look,
    photo: photoOf({ fileName, version }),
    pieces: pieces.map(([position, role, type, colors, pattern, matched]) => ({
      position,
      role,
      type,
      colors,
      pattern,
      matched,
    })),
  };
}

/** The owner's look `id` with its pieces, one statement; NotFound when it is not theirs. */
export async function findInspiration(
  db: Db,
  id: number,
  ownerId: number,
): Promise<InspirationDetail> {
  const { look } = await selectScalars(db, { look: lookJsonSql(id, ownerId) });
  return readLook(look);
}

/** What the match view judges: the look, and the closet it is recreated from. */
export interface RecreateInputs {
  look: InspirationDetail;
  closet: RecreatePoolGarment[];
  avoid: [number, number][];
  rules: OutfitRule[];
}

/**
 * The owner's look `id` and what "Recreate this look" matches it against
 * (recreateInputsSql: the closet, the avoided pairs, the outfit rules), in
 * one statement; NotFound when the look is not theirs. The owner's own
 * closet only, whatever is shared with them, as ideas are.
 */
export async function recreateInputs(
  db: Db,
  id: number,
  ownerId: number,
  today: IsoDate,
): Promise<RecreateInputs> {
  const { look, ...inputs } = await selectScalars(db, {
    look: lookJsonSql(id, ownerId),
    ...recreateInputsSql(ownerId, today),
  });
  return { look: readLook(look), ...readRecreateInputs(inputs) };
}

/** What a new look is saved with besides its photo. */
export interface NewInspiration {
  title: string | null;
  sourceUrl: string | null;
}

/**
 * A new look of the owner's: `photo` (bytes already stored, or null for a
 * link alone) gets its `file` row, with no cutout (`unwanted`: a look is a
 * whole picture, and a cutout would remove the outfit with the background),
 * in one transaction with the look pointing at it; a link alone is one
 * statement. Answers the look's id. With saveInspirationWithPendingPhoto,
 * the one way a look is created (writes.ts).
 */
export function saveInspiration(
  db: Db,
  ownerId: number,
  photo: NewPhotoRow | null,
  fields: NewInspiration,
): Promise<number> {
  return photo
    ? db.transaction((tx) => insertInspiration(tx, ownerId, photo, fields))
    : insertInspiration(db, ownerId, null, fields);
}

/**
 * A new look with the pending photo `fileName` the owner just stored (a
 * pasted link's, importLink), in one transaction: the pending row taken
 * under the owner's and the name's lock (as a garment's save claims one, so a discard, an
 * eviction or reconciliation either went first or finds it gone), then the
 * `file` row and the look. `photo` is its row as Photos built it, after
 * checking its bytes outside the transaction (#141). Undefined, writing
 * nothing, when it is no longer the owner's to claim; its bytes are then
 * whoever took the pending row's to delete.
 */
export function saveInspirationWithPendingPhoto(
  db: Db,
  ownerId: number,
  photo: NewPhotoRow,
  fields: NewInspiration,
): Promise<number | undefined> {
  return db.transaction(async (tx) => {
    // The owner first (lockOwnersAndPhotoName says why), then the take:
    // a look's pending photo is always its owner's own.
    if (!(await lockOwnersAndPhotoName(tx, [ownerId], photo.fileName))) {
      return undefined;
    }
    const scope = { userId: ownerId, ownerId };
    if (!(await takePendingPhoto(tx, photo.fileName, scope))) return undefined;
    return insertInspiration(tx, ownerId, photo, fields);
  });
}

async function insertInspiration(
  q: Queryable,
  ownerId: number,
  photo: NewPhotoRow | null,
  fields: NewInspiration,
): Promise<number> {
  const photoId =
    photo &&
    (await insertPhotoRow(q, { ...photo, ...initialCutoutState('unwanted') }));
  const [created] = await q
    .insert(inspiration)
    .values({ ownerId, ...fields, photoId })
    .returning({ id: inspiration.id });
  return created.id;
}

/**
 * Makes `photo` (bytes already stored) the owner's look's photo, in one
 * transaction: its row inserted (`unwanted`, as saveInspiration), the look
 * pointed at it, the photo it replaces deleted. Answers the replaced
 * photo's name for the caller to unlink after commit (null for a look that
 * had none); NotFound, writing nothing, when the look is not the owner's.
 * The look's row is locked first, so two uploads take turns and the second
 * replaces the first.
 */
export function setInspirationPhoto(
  db: Queryable,
  id: number,
  ownerId: number,
  photo: NewPhotoRow,
): Promise<{ replaced: string | null }> {
  return db.transaction(async (tx) => {
    // Only the look is read here: a row that waited on the lock is
    // re-evaluated with its joins still on the old snapshot, so a joined
    // file name can be null beside a photo id that is set (#527). The
    // replaced name comes from the DELETE itself (files/AGENTS.md).
    const [look] = await tx
      .select({ photoId: inspiration.photoId })
      .from(inspiration)
      .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
      .for('update');
    if (!look) throw new NotFound('inspiration');
    const photoId = await insertPhotoRow(tx, {
      ...photo,
      ...initialCutoutState('unwanted'),
    });
    await tx.update(inspiration).set({ photoId }).where(eq(inspiration.id, id));
    if (look.photoId === null) return { replaced: null };
    const [replaced] = await tx
      .delete(file)
      .where(eq(file.id, look.photoId))
      .returning({ fileName: file.fileName });
    return { replaced: replaced.fileName };
  });
}

/**
 * The owner's look's title and note (the page's autosave, both; the API's
 * PATCH, either: a field left undefined is kept). NotFound when not theirs.
 */
export async function updateInspirationText(
  db: Db,
  id: number,
  ownerId: number,
  text: Partial<InspirationText>,
): Promise<void> {
  const updated = await db
    .update(inspiration)
    .set(text)
    .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
    .returning({ id: inspiration.id });
  if (updated.length === 0) throw new NotFound('inspiration');
}

/**
 * Deletes the owner's look and its photo's `file` row in one transaction;
 * answers the photo's name for the caller to unlink after commit (null for
 * a link alone). NotFound when the look is not the owner's. Its pieces go
 * with it (the foreign key's cascade).
 */
export function deleteInspiration(
  db: Db,
  id: number,
  ownerId: number,
): Promise<{ photo: string | null }> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(inspiration)
      .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
      .returning({ photoId: inspiration.photoId });
    if (!deleted) throw new NotFound('inspiration');
    if (deleted.photoId === null) return { photo: null };
    const [photo] = await tx
      .delete(file)
      .where(eq(file.id, deleted.photoId))
      .returning({ fileName: file.fileName });
    return { photo: photo.fileName };
  });
}

/**
 * Whether `fileName` is the photo of one of the owner's looks: the one
 * question GET /inspiration/photo/* asks before streaming it (anyone
 * else's is a 404, like a missing photo).
 */
export async function isOwnInspirationPhoto(
  db: Db,
  fileName: string,
  ownerId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: inspiration.id })
    .from(inspiration)
    .innerJoin(file, eq(file.id, inspiration.photoId))
    .where(and(eq(file.fileName, fileName), eq(inspiration.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

/** The piece's match is a wishlist item ("Find this" made it): nothing left to choose. */
export function wishlisted(piece: StoredPiece): MatchedGarment | undefined {
  return piece.matched?.status === 'wishlist' ? piece.matched : undefined;
}

/**
 * The owner's look `id`, locked for a change to its pieces: the one lock
 * every piece write and the match view's save take, so they take turns.
 * NotFound when not theirs.
 */
async function lockOwnLook(q: Queryable, id: number, ownerId: number) {
  const [look] = await q
    .select({ id: inspiration.id })
    .from(inspiration)
    .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
    .for('update');
  if (!look) throw new NotFound('inspiration');
}

/** The piece position column's largest value (smallint). */
export const MAX_PIECE_POSITION = 32_767;

/**
 * A new piece at the end of the owner's look `id`; answers its position.
 * The look's row is locked first, so two adds take turns for the next
 * position. NotFound when the look is not the owner's; a 400 past
 * INSPIRATION_MAX_PIECES (the page offers no add there).
 */
export function addInspirationPiece(
  db: Db,
  id: number,
  ownerId: number,
  piece: LookPiece,
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockOwnLook(tx, id, ownerId);
    const count = await tx.$count(
      inspirationPiece,
      eq(inspirationPiece.inspirationId, id),
    );
    if (count >= INSPIRATION_MAX_PIECES) {
      throw new HttpError(400, undefined, {
        logDetail: `inspiration ${id} already has ${count} pieces`,
      });
    }
    const position = await takePiecePositions(tx, id, 1);
    await tx
      .insert(inspirationPiece)
      .values({ inspirationId: id, position, ...pieceColumns(piece) });
    return position;
  });
}

/**
 * Reserves `count` new positions on the look `id` (its row locked by the
 * caller) and answers the first. The look's counter only grows, so a
 * removed piece's position is never given to another: the match view posts
 * positions, and a stale one must not land on a new piece. A 400 when the
 * counter would pass the column's smallint.
 */
async function takePiecePositions(
  tx: Queryable,
  id: number,
  count: number,
): Promise<number> {
  // greatest(): a piece an older build added (it has no counter) can sit at
  // or past the counter, and the position key would then refuse every add.
  const [{ next }] = await tx
    .update(inspiration)
    .set({
      nextPiecePosition: sql`greatest(
        ${inspiration.nextPiecePosition},
        coalesce((select max(${inspirationPiece.position}) + 1 from ${inspirationPiece}
          where ${inspirationPiece.inspirationId} = ${id}), 0)
      ) + ${count}`,
    })
    .where(eq(inspiration.id, id))
    .returning({ next: inspiration.nextPiecePosition });
  const first = next - count;
  if (next - 1 > MAX_PIECE_POSITION) {
    throw new HttpError(400, undefined, {
      logDetail: `inspiration ${id} has used every piece position`,
    });
  }
  return first;
}

function pieceColumns(piece: LookPiece) {
  return {
    role: piece.role,
    type: piece.type,
    colors: [...piece.colors],
    pattern: piece.pattern,
  };
}

/** The owner's look `id`'s piece at `position`: the condition every piece write is scoped by. */
function ownPiece(id: number, position: number, ownerId: number): SQL {
  return and(
    eq(inspirationPiece.inspirationId, id),
    eq(inspirationPiece.position, position),
    sql`exists (select 1 from ${inspiration} where ${and(
      eq(inspiration.id, inspirationPiece.inspirationId),
      eq(inspiration.ownerId, ownerId),
    )})`,
  )!;
}

/**
 * What the owner reads in a piece now (the piece's autosave). The garment
 * chosen for it is cleared: it was chosen for what the piece was.
 * NotFound when it is not a piece of one of their looks. Takes the
 * look's lock (lockOwnLook) like the match view's save, so the save never
 * records a garment against a role this changes under it.
 */
export function updateInspirationPiece(
  db: Queryable,
  id: number,
  position: number,
  ownerId: number,
  piece: LookPiece,
): Promise<void> {
  return db.transaction(async (tx) => {
    await lockOwnLook(tx, id, ownerId);
    const updated = await tx
      .update(inspirationPiece)
      .set({ ...pieceColumns(piece), matchedGarmentId: null })
      .where(ownPiece(id, position, ownerId))
      .returning({ position: inspirationPiece.position });
    if (updated.length === 0) throw new NotFound('inspirationPiece');
  });
}

/** Removes a piece of the owner's look; the rest keep their positions. NotFound when not theirs. */
export async function deleteInspirationPiece(
  db: Db,
  id: number,
  position: number,
  ownerId: number,
): Promise<void> {
  const deleted = await db
    .delete(inspirationPiece)
    .where(ownPiece(id, position, ownerId))
    .returning({ position: inspirationPiece.position });
  if (deleted.length === 0) throw new NotFound('inspirationPiece');
}

/** What set_inspiration_pieces did to a look's pieces. */
export interface PiecesSet {
  kept: number;
  removed: number;
  added: number;
}

/**
 * The owner's look `id` holds exactly `pieces` (MCP's
 * set_inspiration_pieces, #22d: Muse tagging a look). A stored piece equal
 * to one asked for (role, type, colours in order, pattern; each matched
 * once) stays as it is, its position and its chosen garment with it; the
 * other stored pieces are removed, and the rest asked for added after the
 * look's next positions (takePiecePositions), in the order given, so no
 * position is reused for another piece (the match view posts positions). Under the
 * look's lock (lockOwnLook), like every piece write. NotFound when the
 * look is not theirs; a 400 past INSPIRATION_MAX_PIECES.
 */
export function setInspirationPieces(
  db: Db,
  id: number,
  ownerId: number,
  pieces: readonly LookPiece[],
): Promise<PiecesSet> {
  if (pieces.length > INSPIRATION_MAX_PIECES) {
    throw new HttpError(
      400,
      t('refusal.inspiration.tooManyPieces', { max: INSPIRATION_MAX_PIECES }),
    );
  }
  return db.transaction(async (tx) => {
    await lockOwnLook(tx, id, ownerId);
    const stored = await tx
      .select({
        position: inspirationPiece.position,
        role: inspirationPiece.role,
        type: inspirationPiece.type,
        colors: inspirationPiece.colors,
        pattern: inspirationPiece.pattern,
      })
      .from(inspirationPiece)
      .where(eq(inspirationPiece.inspirationId, id));
    const unmatched = [...stored];
    const added = pieces.filter((piece) => {
      const at = unmatched.findIndex((row) => samePiece(row, piece));
      if (at === -1) return true;
      unmatched.splice(at, 1);
      return false;
    });
    if (unmatched.length > 0) {
      await tx.delete(inspirationPiece).where(
        and(
          eq(inspirationPiece.inspirationId, id),
          inArray(
            inspirationPiece.position,
            unmatched.map((row) => row.position),
          ),
        ),
      );
    }
    if (added.length > 0) {
      const next = await takePiecePositions(tx, id, added.length);
      await tx.insert(inspirationPiece).values(
        added.map((piece, index) => ({
          inspirationId: id,
          position: next + index,
          ...pieceColumns(piece),
        })),
      );
    }
    return {
      kept: stored.length - unmatched.length,
      removed: unmatched.length,
      added: added.length,
    };
  });
}

function samePiece(a: LookPiece, b: LookPiece): boolean {
  return (
    a.role === b.role &&
    a.type === b.type &&
    a.pattern === b.pattern &&
    a.colors.length === b.colors.length &&
    a.colors.every((color, index) => color === b.colors[index])
  );
}

/** A look locked for its match view's save (lockLookForSave). */
export interface LookToSave {
  title: string | null;
  /** Each piece's role, by its position. */
  roles: Map<number, InspirationPieceRole>;
}

/**
 * The owner's look `id`, its row locked, with its pieces' roles: what the
 * match view's save checks its choices against. NotFound when the look is
 * not theirs. The lock is the one every piece write takes (lockOwnLook),
 * and the roles are read after it.
 */
export async function lockLookForSave(
  q: Queryable,
  id: number,
  ownerId: number,
): Promise<LookToSave> {
  const [look] = await q
    .select({ title: inspiration.title })
    .from(inspiration)
    .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
    .for('update');
  if (!look) throw new NotFound('inspiration');
  // A second statement, after the lock: a piece edit that held the lock
  // committed before this snapshot, so these are the roles as they are now
  // (one joined statement would read the pieces as they were at its start).
  const pieces = await q
    .select({
      position: inspirationPiece.position,
      role: inspirationPiece.role,
    })
    .from(inspirationPiece)
    .where(eq(inspirationPiece.inspirationId, id));
  return {
    title: look.title,
    roles: new Map(pieces.map(({ position, role }) => [position, role])),
  };
}

/** The garment the owner chose for the piece at `position` (null: none), and the category a match of it has. */
export interface PieceChoice {
  position: number;
  garmentId: number | null;
  category: string;
}

/**
 * Records the owner's choices on their look `id` (locked by
 * lockLookForSave) in one statement: each piece's matched_garment_id, a
 * garment stored only when it is the owner's and of the piece's category
 * (pieceCategory), checked in the update itself. Answers how many pieces
 * it wrote: fewer than `choices` when a piece is gone or a garment is not
 * one a match of it could be, for the caller to refuse the save whole.
 */
export async function recordPieceChoices(
  q: Queryable,
  id: number,
  ownerId: number,
  choices: readonly PieceChoice[],
): Promise<number> {
  if (choices.length === 0) return 0;
  const values = sql.join(
    choices.map(
      (c) =>
        sql`(${c.position}::int, ${c.garmentId}::int, ${c.category}::text)`,
    ),
    sql`, `,
  );
  const { rows } = await q.execute<{ position: number }>(sql`
    update ${inspirationPiece} set matched_garment_id = choice.garment_id
    from (values ${values}) as choice (position, garment_id, category)
    where ${inspirationPiece.inspirationId} = ${id}::int
      and ${inspirationPiece.position} = choice.position
      and (choice.garment_id is null or exists (
        select 1 from ${garment}
        where ${garment.id} = choice.garment_id
          and ${garment.ownerId} = ${ownerId}::int
          and ${garment.category} = choice.category
      ))
    returning ${inspirationPiece.position}`);
  return rows.length;
}

/** A piece "Find this" turns into a wishlist item, with the look it is from. */
interface PieceToFind extends LookPiece {
  matchedGarmentId: number | null;
  look: Pick<InspirationSummary, 'title' | 'sourceUrl'>;
}

/**
 * The piece at `position` of the owner's look `id`, its row locked
 * (FOR UPDATE), so two "Find this" of one piece take turns and the second
 * reads the first's wishlist item; NotFound when it is not a piece of one
 * of their looks.
 */
async function lockPieceToFind(
  q: Queryable,
  id: number,
  position: number,
  ownerId: number,
): Promise<PieceToFind> {
  const [row] = await q
    .select({
      role: inspirationPiece.role,
      type: inspirationPiece.type,
      colors: inspirationPiece.colors,
      pattern: inspirationPiece.pattern,
      matchedGarmentId: inspirationPiece.matchedGarmentId,
      title: inspiration.title,
      sourceUrl: inspiration.sourceUrl,
    })
    .from(inspirationPiece)
    .innerJoin(inspiration, eq(inspiration.id, inspirationPiece.inspirationId))
    .where(
      and(
        eq(inspirationPiece.inspirationId, id),
        eq(inspirationPiece.position, position),
        eq(inspiration.ownerId, ownerId),
      ),
    )
    .for('update', { of: inspirationPiece });
  if (!row) throw new NotFound('inspirationPiece');
  const { title, sourceUrl, ...piece } = row;
  return { ...piece, look: { title, sourceUrl } };
}

/**
 * Whether `garmentId` is on the owner's wishlist. Its own statement after
 * lockPieceToFind's lock, so it sees a wishlist item the piece's previous
 * holder committed while this one waited (a statement's snapshot is taken
 * when it starts).
 */
async function isOwnWishlistItem(
  q: Queryable,
  garmentId: number,
  ownerId: number,
): Promise<boolean> {
  const [row] = await q
    .select({ id: garment.id })
    .from(garment)
    .where(
      and(
        eq(garment.id, garmentId),
        eq(garment.ownerId, ownerId),
        onWishlist(),
      ),
    );
  return row !== undefined;
}

/** Points the (locked, lockPieceToFind) piece at the garment chosen for it. */
async function setPieceMatch(
  q: Queryable,
  id: number,
  position: number,
  garmentId: number,
): Promise<void> {
  await q
    .update(inspirationPiece)
    .set({ matchedGarmentId: garmentId })
    .where(
      and(
        eq(inspirationPiece.inspirationId, id),
        eq(inspirationPiece.position, position),
      ),
    );
}

/** What "Find this" answers: the piece's wishlist item, and whether this tap made it. */
export interface FoundPiece {
  garmentId: number;
  created: boolean;
}

/**
 * "Find this": a wishlist item of the owner's for the piece at `position`
 * of their look `id`, recorded as the piece's match, in one transaction.
 * The piece's row is locked first, so a double tap makes one item: the
 * second finds the piece's match on the wishlist and answers it
 * (`created: false`). The item is an ordinary wishlist garment
 * (insertGarment, status `wishlist`), so it lands in the inbox and "Goes
 * with my closet" judges it; a piece whose match is a closet garment (one
 * archived since, say) gets one too. NotFound when the piece is not one of
 * the owner's.
 */
export function addPieceToWishlist(
  db: Db,
  ownerId: number,
  id: number,
  position: number,
): Promise<FoundPiece> {
  return db.transaction(async (tx) => {
    const piece = await lockPieceToFind(tx, id, position, ownerId);
    const matched = piece.matchedGarmentId;
    if (matched !== null && (await isOwnWishlistItem(tx, matched, ownerId))) {
      return { garmentId: matched, created: false };
    }
    const garmentId = await insertGarment(
      tx,
      ownerId,
      wishlistFieldsOf(piece, piece.look),
      null,
      'wishlist',
      // Find this is the person's tap: no MCP tool reaches it.
      BY_PERSON,
    );
    await setPieceMatch(tx, id, position, garmentId);
    return { garmentId, created: true };
  });
}
