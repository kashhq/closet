import { CloneType, type Static, Type } from '@sinclair/typebox';
import { AWAY_REASONS } from '../../wardrobe/availability';
import { LOOK_REACTIONS } from '../../wardrobe/look-reaction';
import { OCCASIONS } from '../../wardrobe/occasions';
import { OUTFIT_ORIGINS } from '../../wardrobe/outfit-origin';
import { categoryRole, GARMENT_ROLES } from '../../wardrobe/properties';
import { GARMENT_STATUSES } from '../../wardrobe/status';
import { OUTFIT_DISMISS_REASONS } from '../../wardrobe/suggestions';
import { asResource, literals, Nullable, withoutNulls } from '../api/resource';
import type { ScheduleOutcome } from '../calendar/queries';
import { HttpError } from '../errors';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { IsoDateSchema, RowId } from '../schemas';
import { PublicShareUrl, publicShareUrl } from '../share/urls';
import type { OutfitContext } from './page-context';
import {
  OUTFIT_NAME_MAX,
  OUTFIT_NOTES_MAX,
  OUTFIT_SLOTS_MAX,
  type OutfitGarment,
  type OutfitPageDetail,
  type OutfitProposal,
  type SlotInput,
  type SyncedOutfitRow,
  type ToolOutfit,
} from './queries';
import { piecesToBuy } from './references';
import { DECLINE_NOTE_MAX, SlotCategory } from './schemas';
import { AgentResource, agentNameOf, toAgentResource } from '../write-origin';

/**
 * The API's outfit resources and inputs (#193a; docs/plans/2026-11-12-json-
 * api.md section 2), mapped from what the pages and MCP read: a list's
 * outfit (listOutfitsPage, list_outfits' read a page at a time) and one in
 * full (requireOutfitPage, the outfit page's one statement). camelCase,
 * null fields left out. An outfit's garments are as its collage shows them;
 * a client reads the rest from GET /garments/{id}. The records keep their
 * nulls (`outfitListRecord`, `outfitGarmentRecord`): the API sends them
 * through asResource, MCP's tools project them.
 */

/** Also a calendar entry's and a trip outfit's garments (calendar/entry-resource.ts, trips/trip-resource.ts). */
export const OutfitGarmentResource = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    category: Type.String(),
    role: literals(GARMENT_ROLES),
    /** `wishlist`: a piece to buy (toBuy). */
    status: literals(GARMENT_STATUSES),
    /** Signed, relative, immutable: from the cutout when it shows. */
    thumbUrl: Type.Optional(Type.String()),
    /** On GET /outfits/{id} and calendar entries: where the piece is when not in the closet. */
    away: Type.Optional(literals(AWAY_REASONS)),
  },
  {
    title: 'OutfitGarment',
    description:
      'A garment the outfit holds, as its collage shows it, in the order it was built (an empty row is left out): GET /garments/{id} has the rest',
  },
);

const OutfitProposalResource = Type.Object(
  {
    reaction: literals(LOOK_REACTIONS),
    note: Type.Optional(Type.String()),
    ownerNote: Type.Optional(Type.String()),
    dismissedReason: Type.Optional(literals(OUTFIT_DISMISS_REASONS)),
    /** The agent's name, on GET /outfits/{id} only, while its token exists. */
    agent: Type.Optional(Type.String()),
  },
  {
    title: 'OutfitProposal',
    description:
      'Your agent proposed this outfit: its note, and your reaction (`loved` and complete: yours, like any other)',
  },
);

// Who made an outfit (#659). Required in every answer; a client's copy
// synced before it may lack it, and then it is `person`: the migration
// re-sent only the outfits it moved off `person`.
const OutfitOriginField = CloneType(literals(OUTFIT_ORIGINS), {
  description:
    'Who made it: `person` and `agent` (your agent) are outfits kept on purpose, the Saved list; `idea` (an idea picked for a day, a trip or an entry) and `planner` (Plan my week) are one-offs, shown apart until a save or an edit keeps them. A copy synced before this field existed lacks it: read that as `person`',
});

const outfitFields = {
  id: Type.Integer(),
  name: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  origin: OutfitOriginField,
  garments: Type.Array(OutfitGarmentResource),
  toBuy: Type.Array(Type.Integer(), {
    description:
      'Its garments not bought yet (wishlist items): an outfit with any cannot be planned, packed or worn until they are',
  }),
  proposal: Type.Optional(OutfitProposalResource),
  agent: Type.Optional(AgentResource),
};

export const OutfitListItem = Type.Object(outfitFields, {
  title: 'OutfitListItem',
  description:
    'One of your outfits as a list shows it: GET /outfits/{id} adds its days',
});
type OutfitListItem = Static<typeof OutfitListItem>;

const PlannedDay = Type.Object(
  {
    entryId: Type.Integer(),
    day: IsoDateSchema,
    occasion: literals(OCCASIONS),
  },
  { title: 'OutfitPlannedDay' },
);

const WornDay = Type.Object(
  { entryId: Type.Integer(), day: IsoDateSchema },
  { title: 'OutfitWornDay' },
);

export const Outfit = Type.Object(
  {
    ...outfitFields,
    /** Its calendar entries not worn yet, from today on, soonest first. */
    planned: Type.Array(PlannedDay),
    /** The days it was worn (marked, or with a selfie), newest first. */
    worn: Type.Array(WornDay),
    publicShareUrl: Type.Optional(PublicShareUrl),
  },
  {
    title: 'Outfit',
    description:
      'One of your outfits in full, as its page shows it: its garments (with where each is when away), and its days planned and worn',
  },
);
type Outfit = Static<typeof Outfit>;

/** A garment an outfit holds, nulls kept: the API's OutfitGarment, what MCP's outfit answers project. */
export function outfitGarmentRecord(garment: OutfitGarment) {
  return {
    id: garment.id,
    name: garment.name,
    category: garment.category,
    role: categoryRole(garment.category),
    status: garment.status,
    thumbUrl: garment.photo && imageUrl(garment.photo, 'thumb'),
    away: garment.away ?? null,
  };
}
export type OutfitGarmentRecord = ReturnType<typeof outfitGarmentRecord>;

/** What a list's outfit and one in full share, nulls kept. */
function outfitFieldsRecord(outfit: ToolOutfit | OutfitPageDetail) {
  return {
    id: outfit.id,
    name: outfit.name,
    notes: outfit.notes,
    origin: outfit.origin,
    garments: outfit.garments.map(outfitGarmentRecord),
    toBuy: piecesToBuy(outfit.garments).map(({ id }) => id),
    proposal: outfit.proposal && proposalRecord(outfit.proposal),
    agent: toAgentResource(outfit.agent),
  };
}

/** A proposal's fields, its agent worded (only the outfit page reads it). */
function proposalRecord(
  proposal: OutfitProposal | Omit<OutfitProposal, 'agent'>,
) {
  return {
    ...proposal,
    agent: 'agent' in proposal ? agentNameOf(proposal.agent) : undefined,
  };
}

/**
 * A list's outfit, nulls kept: the API's OutfitListItem, and what MCP's
 * list_outfits and get_outfit project (src/web/mcp/tools/outfits.ts).
 */
export function outfitListRecord(outfit: ToolOutfit) {
  return outfitFieldsRecord(outfit);
}
export type OutfitListRecord = ReturnType<typeof outfitListRecord>;

export function toOutfitListItem(outfit: ToolOutfit): OutfitListItem {
  return asResource(OutfitListItem, outfitListRecord(outfit));
}

/**
 * An outfit's public link (#669): outfits are their owner's alone, so
 * whoever reads one may stop it; null while not shared.
 */
function outfitShareUrl(
  shareableId: string | null,
  siteUrl: string,
): string | null {
  return shareableId === null
    ? null
    : publicShareUrl(siteUrl, 'outfit', shareableId);
}

export function toOutfitResource(
  { outfit, entries }: OutfitContext,
  siteUrl: string,
): Outfit {
  return asResource(Outfit, {
    ...outfitFieldsRecord(outfit),
    planned: entries.planned,
    worn: entries.worn.map(({ entryId, day }) => ({ entryId, day })),
    publicShareUrl: outfitShareUrl(outfit.shareableId, siteUrl),
  });
}

/**
 * The changes feed's outfit (#196b-2, GET /changes): its stored fields and
 * rows. No `garments` or `toBuy` (each garment's name, photo, status and
 * whereabouts are the garment's, whose edits never move the outfit's
 * revision: the client draws them from its garments), no proposal `agent`
 * (the token's name) and no `planned` or `worn` (the calendar entries'
 * own). The agent's proposals are in it, with their reaction: the owner's feed
 * only, as every outfit.
 */
export const SyncedOutfit = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    origin: OutfitOriginField,
    slots: Type.Array(
      Type.Object(
        {
          category: Type.String(),
          garmentId: Type.Optional(
            Type.Integer({ description: 'Absent: a row kept empty' }),
          ),
        },
        { title: 'SyncedOutfitSlot' },
      ),
      { description: 'Its rows top to toe, as built' },
    ),
    proposal: Type.Optional(
      Type.Object(
        {
          reaction: literals(LOOK_REACTIONS),
          note: Type.Optional(Type.String()),
          ownerNote: Type.Optional(Type.String()),
          dismissedReason: Type.Optional(literals(OUTFIT_DISMISS_REASONS)),
        },
        {
          title: 'SyncedOutfitProposal',
          description: 'Your agent proposed it: its note and your reaction',
        },
      ),
    ),
    agent: Type.Optional(AgentResource),
    publicShareUrl: Type.Optional(PublicShareUrl),
  },
  {
    title: 'SyncedOutfit',
    description:
      "One of your outfits as stored: its rows name garments by id; what each looks like and whether it is bought yet is the garment's",
  },
);

export function toSyncedOutfit(
  row: SyncedOutfitRow,
  siteUrl: string,
): Static<typeof SyncedOutfit> {
  const shareUrl = outfitShareUrl(row.shareableId, siteUrl);
  return {
    id: row.id,
    ...withoutNulls({ name: row.name, notes: row.notes }),
    origin: row.origin,
    slots: row.slots.map((slot) => withoutNulls(slot)),
    ...(row.proposal && { proposal: withoutNulls(row.proposal) }),
    agent: toAgentResource(row.agent),
    ...(shareUrl !== null && { publicShareUrl: shareUrl }),
  };
}

const OutfitName = Type.String({ maxLength: OUTFIT_NAME_MAX });
const OutfitNotes = Type.String({ maxLength: OUTFIT_NOTES_MAX });

const OutfitSlot = Type.Object(
  {
    category: CloneType(SlotCategory, { description: "The row's category" }),
    garmentId: Type.Optional(
      CloneType(RowId, {
        description:
          'One of your own garments (closet; archived ones it holds already stay); absent, a row kept empty',
      }),
    ),
  },
  { title: 'OutfitSlot' },
);

const Slots = Type.Array(OutfitSlot, {
  maxItems: OUTFIT_SLOTS_MAX,
  description:
    "Its rows top to toe, replaced whole. A garment it cannot hold (another's, deleted, archived, or not bought yet while the outfit is planned) refuses the save, nothing written: a 404 when any is not yours, else a 409 naming them",
});

/**
 * A new outfit holds a garment: the page's form may save an empty one, but
 * a retried empty create would never match "the same garments" and make a
 * new outfit each time, so the API refuses it (the handler checks that one
 * row holds a garment; `minItems` only the array).
 */
const NewSlots = Type.Array(OutfitSlot, {
  minItems: 1,
  maxItems: OUTFIT_SLOTS_MAX,
  description: `${Slots.description ?? ''}. At least one row holds a garment (else a 400): an outfit with none could not be told from its retry`,
});

/** The rows as the outfit writers take them: an absent garment is an empty row. */
export function slotsOf(slots: Static<typeof Slots>): SlotInput[] {
  return slots.map(({ category, garmentId }) => ({
    category,
    garmentId: garmentId ?? null,
  }));
}

/** POST /outfits. */
export const NewOutfit = Type.Object(
  {
    name: Type.Optional(OutfitName),
    notes: Type.Optional(OutfitNotes),
    slots: NewSlots,
    plan: Type.Optional(
      Type.Object(
        {
          day: IsoDateSchema,
          occasion: Type.Optional(literals(OCCASIONS)),
        },
        {
          description:
            'Also plan it on this day (all day unless an occasion is given), in the same transaction; an outfit with pieces to buy cannot be (409)',
        },
      ),
    ),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this create, for retrying it offline: accepted, not yet stored (the same garments are the same outfit anyway)',
      }),
    ),
  },
  {
    title: 'NewOutfit',
    description:
      'An outfit of your own garments. Once per garment set: when they are an outfit of yours already, that one is the answer (200, `alreadySaved`, its own name and notes kept)',
  },
);

/** PATCH /outfits/{id}: absent leaves a field as it is. */
export const OutfitPatch = Type.Object(
  {
    name: Nullable(OutfitName, { description: 'null or blank: untitled' }),
    notes: Nullable(OutfitNotes, { description: 'null or blank: none' }),
    slots: Type.Optional(Slots),
  },
  {
    title: 'OutfitPatch',
    description:
      'Only what is sent changes. Editing an outfit makes its days planned by Plan my week yours (`entriesClaimed`)',
  },
);

const SCHEDULE_OUTCOMES = [
  'scheduled',
  'already-scheduled',
] as const satisfies readonly ScheduleOutcome[];

export const OutfitSaved = Type.Object(
  {
    id: Type.Integer(),
    /** The garments were an outfit of yours already: nothing created. */
    alreadySaved: Type.Boolean(),
    /** With a `plan`: planned, or it was on that day already. */
    schedule: Type.Optional(literals(SCHEDULE_OUTCOMES)),
  },
  { title: 'OutfitSaved', description: 'The outfit saved, new or found' },
);

export const OutfitUpdated = Type.Object(
  {
    entriesClaimed: Type.Integer({
      minimum: 0,
      description: 'Its calendar entries Plan my week had planned, now yours',
    }),
  },
  { title: 'OutfitUpdated' },
);

/**
 * POST /outfits/{id}/reactions: the owner's moves on one of the agent's outfits
 * (reactToProposal): Love (Save, once complete), Not for me with a
 * reason, and its Undo.
 */
export const OutfitReactionInput = Type.Union(
  [
    Type.Object({ event: Type.Literal('love') }),
    Type.Object({
      event: Type.Literal('decline'),
      reason: literals(OUTFIT_DISMISS_REASONS),
      note: Type.Optional(Type.String({ maxLength: DECLINE_NOTE_MAX })),
    }),
    Type.Object({ event: Type.Literal('reconsider') }),
  ],
  {
    title: 'OutfitReactionInput',
    description:
      '`love` (keep it; once every piece is bought it is yours), `decline` (Not for me, with a reason) or `reconsider` (undo that)',
  },
);

export const OutfitReacted = Type.Object(
  {
    from: literals(LOOK_REACTIONS),
    to: literals(LOOK_REACTIONS),
    /** Every piece owned: a love made it yours. */
    complete: Type.Boolean(),
  },
  { title: 'OutfitReacted' },
);

/**
 * A body naming an outfit two ways, a saved one (`outfitId`) or an idea's
 * garments (`garmentIds`), sent neither or both: the trip's
 * (POST /trips/{id}/outfits) and the calendar entry's
 * (PUT /calendar-entries/{id}/outfit) one refusal.
 */
export function outfitOrGarments(): HttpError {
  const message = t('api.OUTFIT_ONE_OF');
  return new HttpError(400, message, {
    validation: [{ path: 'body/outfitId', message }],
  });
}

/**
 * `name` sent with `outfitId` alone: a saved outfit keeps its own name, and a
 * name only goes with `garmentIds`, which make a new outfit. Pointed at the
 * field at fault, not at `outfitId`.
 */
export function outfitNameNeedsGarments(): HttpError {
  const message = t('api.OUTFIT_NAME_NEEDS_GARMENTS');
  return new HttpError(400, message, {
    validation: [{ path: 'body/name', message }],
  });
}
