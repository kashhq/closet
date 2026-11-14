import { CloneType, type Static, Type } from '@sinclair/typebox';
import type { LookPiece as Piece } from '../../wardrobe/recreate';
import {
  GARMENT_COLORS,
  INSPIRATION_PIECE_MAX_COLORS,
  INSPIRATION_PIECE_ROLES,
  PATTERNS,
} from '../../wardrobe/properties';
import { GARMENT_STATUSES } from '../../wardrobe/status';
import {
  ListCursor,
  ListLimit,
  ListOf,
  literals,
  Nullable,
  withoutNulls,
} from '../api/resource';
import { HttpError } from '../errors';
import { apiInspirationPhotoUrl, type PrivatePhoto } from '../files/image-url';
import { IdeaGarment, toIdeaGarment } from '../gallery/idea-resource';
import { RowId } from '../schemas';
import { REFUSALS } from '../wardrobe/link-import/import';
import { LINK_INPUT_MAX } from '../wardrobe/link-import/link-text';
import { typesOfRole } from './piece-input';
import {
  INSPIRATION_MAX_PIECES,
  INSPIRATION_NOTE_MAX,
  INSPIRATION_TITLE_MAX,
  type InspirationDetail,
  type ListedInspiration,
  MAX_PIECE_POSITION,
  type StoredPiece,
  wishlisted,
} from './queries';
import type { LookRecreation } from './recreation';
import type { UnreadReason } from './writes';

/**
 * Saved looks on /api/v1 (#193d; src/web/inspiration/AGENTS.md), mapped
 * from what the Inspiration tab, a look's page and the match view read.
 * The token's user's own, like the style profile: a share never reaches one.
 */

/** A page of GET /looks unless asked: more than the tab shows above the fold. */
export const LOOK_PAGE_SIZE = 50;

export const LookParams = Type.Object({ id: RowId });

/** A piece's place in its look: inspiration_piece.position, never reused. */
const PiecePosition = Type.Integer({
  minimum: 0,
  maximum: MAX_PIECE_POSITION,
  description:
    "The piece's place in its look, from the look's own counter: never renumbered, never given to another piece",
});

export const PieceParams = Type.Object({ id: RowId, position: PiecePosition });

export const LookListQuery = Type.Object({
  cursor: Type.Optional(ListCursor),
  limit: ListLimit(LOOK_PAGE_SIZE),
});

const LookPhoto = Type.Object(
  {
    version: Type.Integer(),
    originalUrl: Type.String(),
    thumbUrl: Type.String({ description: '400 px' }),
  },
  {
    title: 'LookPhoto',
    description:
      "A look's photo: private, served only to its owner's device token (GET /api/v1/look-photos/{fileName}), relative to the server and immutable (another photo is another URL). Never build or edit one",
  },
);

export function toLookPhoto(photo: PrivatePhoto): Static<typeof LookPhoto> {
  return {
    version: photo.version ?? 1,
    originalUrl: apiInspirationPhotoUrl(photo, 'original'),
    thumbUrl: apiInspirationPhotoUrl(photo, 'thumb'),
  };
}

const Role = literals(INSPIRATION_PIECE_ROLES);
const Color = literals(GARMENT_COLORS);
const PatternSchema = literals(PATTERNS);

/** What a look is, whichever answer carries it. */
const lookFields = {
  id: Type.Integer(),
  title: Type.Optional(Type.String()),
  sourceUrl: Type.Optional(
    Type.String({ description: 'Where it was seen: an http(s) link' }),
  ),
  photo: Type.Optional(LookPhoto),
};

const LookPieceMatch = Type.Object(
  {
    garmentId: Type.Integer(),
    name: Type.Optional(Type.String()),
    category: Type.String(),
    status: literals(GARMENT_STATUSES),
  },
  {
    title: 'LookPieceMatch',
    description:
      'The garment chosen for the piece: the closet garment its outfit was saved with, or the wishlist item "Find this" made (`status` wishlist). Editing the piece clears it',
  },
);

const pieceFields = {
  position: PiecePosition,
  role: Role,
  type: Type.Optional(
    Type.String({ description: "One of the role's garment types" }),
  ),
  colors: Type.Array(Color, {
    description: 'The main colour first, then an accent',
  }),
  pattern: Type.Optional(PatternSchema),
  matched: Type.Optional(LookPieceMatch),
};

export const LookPieceResource = Type.Object(pieceFields, {
  title: 'LookPiece',
  description: 'A piece the owner read in the look',
});

function toLookPiece(piece: StoredPiece): Static<typeof LookPieceResource> {
  return withoutNulls({
    position: piece.position,
    role: piece.role,
    type: piece.type,
    colors: [...piece.colors],
    pattern: piece.pattern,
    matched:
      piece.matched &&
      withoutNulls({
        garmentId: piece.matched.id,
        name: piece.matched.name,
        category: piece.matched.category,
        status: piece.matched.status,
      }),
  });
}

const LookListItem = Type.Object(
  {
    ...lookFields,
    pieceCount: Type.Integer({
      minimum: 0,
      description: 'How many pieces it is tagged with: none is untagged',
    }),
  },
  { title: 'LookListItem' },
);

export const LookList = ListOf(LookListItem, {
  title: 'LookList',
  description: 'A page of your saved looks, newest first',
});

export function toLookListItem(
  look: ListedInspiration,
): Static<typeof LookListItem> {
  return withoutNulls({
    id: look.id,
    title: look.title,
    sourceUrl: look.sourceUrl,
    photo: look.photo && toLookPhoto(look.photo),
    pieceCount: look.pieceCount,
  });
}

export const Look = Type.Object(
  {
    ...lookFields,
    note: Type.Optional(Type.String()),
    pieces: Type.Array(LookPieceResource, { description: 'In their order' }),
  },
  {
    title: 'Look',
    description:
      'A saved look: a photo, a link or both, with a title, a note and the pieces read in it',
  },
);

export function toLook(look: InspirationDetail): Static<typeof Look> {
  return withoutNulls({
    id: look.id,
    title: look.title,
    sourceUrl: look.sourceUrl,
    photo: look.photo && toLookPhoto(look.photo),
    note: look.note,
    pieces: look.pieces.map(toLookPiece),
  });
}

const PieceMatch = Type.Object(
  {
    garment: IdeaGarment,
    available: Type.Boolean({
      description: 'In the closet, at home and with a clean copy today',
    }),
    agrees: Type.Object(
      {
        type: Type.Boolean(),
        color: Type.Optional(
          CloneType(literals(['exact', 'close'] as const), {
            description:
              '`exact`: the main colour; `close`: a close shade of it, or the accent',
          }),
        ),
        pattern: Type.Boolean(),
      },
      { title: 'PieceAgreement', description: 'How it agrees with the piece' },
    ),
  },
  { title: 'PieceMatch' },
);

const RecreatedPiece = Type.Object(
  {
    ...pieceFields,
    matches: Type.Array(PieceMatch, {
      description:
        'The chosen garment first (the one saved for the piece while it still matches), then up to two alternates; empty when missing or on the wishlist',
    }),
    missing: Type.Boolean({
      description:
        'No closet garment is close enough: "Find this" puts it on the wishlist',
    }),
    repicked: Type.Boolean({
      description:
        'The closest garment clashed with the rest, so another is chosen',
    }),
  },
  { title: 'RecreatedPiece' },
);

export const LookRecreationResource = Type.Object(
  {
    ...lookFields,
    note: Type.Optional(Type.String()),
    pieces: Type.Array(RecreatedPiece, { description: 'In their order' }),
    unfixedPositions: Type.Array(Type.Integer(), {
      description:
        'Pieces whose chosen garments clash and that no re-pick within reach mended',
    }),
  },
  {
    title: 'LookRecreation',
    description:
      '"Recreate this look": each piece with your closet garments closest to it, chosen to go together and never one garment for two pieces. Your own closet, whatever is shared with you',
  },
);

export function toLookRecreation({
  look,
  recreation,
}: LookRecreation): Static<typeof LookRecreationResource> {
  const { pieces, ...rest } = toLook(look);
  return {
    ...rest,
    pieces: pieces.map((piece, index) => {
      const { matches, repicked } = recreation.pieces[index];
      return {
        ...piece,
        matches: matches.map(({ garment, agrees }) => ({
          garment: toIdeaGarment(garment),
          available: garment.available,
          agrees: withoutNulls(agrees),
        })),
        missing: !wishlisted(look.pieces[index]) && matches.length === 0,
        repicked,
      };
    }),
    unfixedPositions: recreation.unfixed.map(
      (index) => look.pieces[index].position,
    ),
  };
}

const ClientId = Type.Optional(
  Type.String({
    format: 'uuid',
    description:
      'Your id for this create, for retrying it offline: accepted and logged, never stored (a saved look has no client id column), so a retry saves another look',
  }),
);

export const LookUpload = Type.Object(
  {
    photo: Type.String({
      format: 'binary',
      description:
        'The look: JPEG, PNG, WebP, HEIC or AVIF, kept whole (no background removal)',
    }),
    url: Type.Optional(
      Type.String({
        maxLength: LINK_INPUT_MAX,
        description: 'Where it was seen: an absolute http(s) link',
      }),
    ),
    title: Type.Optional(Type.String({ maxLength: INSPIRATION_TITLE_MAX })),
    clientId: ClientId,
  },
  {
    title: 'LookUpload',
    description:
      'The text parts are read wherever they come; any other is ignored',
  },
);

export const LookCreated = Type.Object(
  { id: Type.Integer(), photo: LookPhoto },
  { title: 'LookCreated' },
);

export const LookLinkImport = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: LINK_INPUT_MAX,
      description:
        'A lookbook page, a post or an image link (http or https; text around a link is read as the link)',
    }),
    clientId: ClientId,
  },
  { title: 'LookLinkImport' },
);

/** Why a link was saved without its photo: a site's refusal (a 502 of REFUSALS), or a page with none. */
const UNREAD_REASONS = [
  ...(Object.keys(REFUSALS) as (keyof typeof REFUSALS)[]).filter(
    (reason) => REFUSALS[reason].status === 502,
  ),
  'no-photo',
] as const satisfies readonly UnreadReason[];

export const LookImported = Type.Object(
  {
    id: Type.Integer(),
    unread: Type.Optional(
      CloneType(literals(UNREAD_REASONS), {
        description:
          'Saved with its link but no photo, and why: `blocked-by-site` (most social sites refuse automated fetches), a timeout, `no-photo` (a page with none readable). Add one with PUT /looks/{id}/photo (a screenshot)',
      }),
    ),
  },
  { title: 'LookImported' },
);

export const LookTextInput = Type.Object(
  {
    title: Nullable(Type.String({ maxLength: INSPIRATION_TITLE_MAX }), {
      description: 'Null or blank clears it',
    }),
    note: Nullable(Type.String({ maxLength: INSPIRATION_NOTE_MAX }), {
      description: 'Null or blank clears it',
    }),
  },
  {
    title: 'LookTextInput',
    description: 'Either or both; a field left out is kept',
  },
);

export const PhotoReplaced = Type.Object(
  {
    photo: LookPhoto,
    replaced: Type.Boolean({
      description: "It replaced the look's photo, which is gone",
    }),
  },
  { title: 'LookPhotoReplaced' },
);

export const LookPieceInput = Type.Object(
  {
    role: Role,
    type: Nullable(
      Type.String({
        maxLength: 40,
        description:
          "One of the role's garment types (a type of another role is a 400 naming the role's); absent or null for any",
      }),
    ),
    colors: Type.Optional(
      Type.Array(Color, {
        maxItems: INSPIRATION_PIECE_MAX_COLORS,
        description:
          'The main colour first, then an accent; absent or [] for unread',
      }),
    ),
    pattern: Nullable(PatternSchema),
  },
  { title: 'LookPieceInput' },
);
type LookPieceInput = Static<typeof LookPieceInput>;

/**
 * The piece as the look stores it (`pointer` the body's path to it, for
 * the 400): a type of another role is refused naming the role's types, as
 * MCP's set_inspiration_pieces refuses it; a colour twice is once.
 */
export function readLookPiece(input: LookPieceInput, pointer: string): Piece {
  const type = input.type ?? null;
  if (type !== null && !typesOfRole(input.role).includes(type)) {
    const message = `"${type}" is not a type of ${input.role} (${typesOfRole(input.role).join(', ')})`;
    throw new HttpError(400, message, {
      validation: [{ path: `${pointer}/type`, message }],
    });
  }
  return {
    role: input.role,
    type,
    colors: [...new Set(input.colors ?? [])],
    pattern: input.pattern ?? null,
  };
}

/** A stored piece's fields as the API answers a piece write: no `matched` (a write clears it). */
export function toWrittenPiece(
  position: number,
  piece: Piece,
): Static<typeof LookPieceResource> {
  return withoutNulls({
    position,
    role: piece.role,
    type: piece.type,
    colors: [...piece.colors],
    pattern: piece.pattern,
  });
}

export const LookPiecesInput = Type.Object(
  {
    pieces: Type.Array(LookPieceInput, {
      maxItems: INSPIRATION_MAX_PIECES,
      description: `The whole list, at most ${INSPIRATION_MAX_PIECES}; [] clears it`,
    }),
  },
  { title: 'LookPiecesInput' },
);

export const PiecesSetResource = Type.Object(
  {
    kept: Type.Integer({
      minimum: 0,
      description:
        'Stored pieces equal in every part to one asked for: kept with their position and what was chosen for them',
    }),
    removed: Type.Integer({ minimum: 0 }),
    added: Type.Integer({
      minimum: 0,
      description: "Added after the look's last position, in the order sent",
    }),
  },
  { title: 'LookPiecesSet' },
);

export const RecreationChoices = Type.Object(
  {
    choices: Type.Array(
      Type.Object(
        {
          position: PiecePosition,
          garmentId: Nullable(RowId, {
            description:
              "A closet garment of the piece's kind; absent or null: None",
          }),
        },
        { title: 'PieceChoice' },
      ),
      {
        minItems: 1,
        maxItems: INSPIRATION_MAX_PIECES,
        description:
          'One per piece at most, as GET /looks/{id}/recreation offered them',
      },
    ),
  },
  { title: 'RecreationChoices' },
);

export const PieceFound = Type.Object(
  {
    garmentId: Type.Integer({ description: 'The wishlist item' }),
    created: Type.Boolean({
      description: 'False: the piece was on your wishlist already (a retry)',
    }),
  },
  { title: 'LookPieceFound' },
);
