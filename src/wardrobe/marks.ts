import type { AwayReason } from './availability';
import type { GarmentStatus } from './status';

/**
 * What a garment's status mark can say, in the order a badge shows them:
 * the first is the one in words, the rest go to screen readers. Status
 * first (not owned yet, owned once), then why an owned garment cannot be
 * worn now (away, then the wash). `set-aside` is a Muse pick the owner
 * turned down and stands in for `to-buy`, so the two never meet; only a
 * wishlist garment is set aside (buying one keeps its `dismissedAt`).
 *
 * The badge itself (one daisyUI variant and one string per mark) is
 * `<GarmentMark>`, src/web/layout/garment-mark.tsx; this is the rule every
 * surface derives its marks with, so a mark means the same thing on each.
 */
export const GARMENT_MARKS = [
  'to-buy',
  'archived',
  'away:lent',
  'away:repair',
  'needs-wash',
  'set-aside',
] as const;
export type GarmentMarkKind = (typeof GARMENT_MARKS)[number];

/**
 * What a surface knows of a garment. Status is always read; the rest is
 * optional because a surface marks only what it already reads (the grid
 * reads away and the wash for the owner, Muse reads setAside, Styling
 * neither): an absent field is no mark, never a guess.
 */
export interface MarkedGarment {
  status: GarmentStatus;
  away?: AwayReason | null;
  needsWash?: boolean;
  setAside?: boolean;
}

export interface MarkOptions {
  /**
   * Someone who may see the care state is looking: the owner, or for the
   * wash a MANAGE partner (#680), whose surfaces read no away. A VIEW
   * grantee never gets the away or wash marks, even when the surface
   * passes them.
   */
  ownerView: boolean;
}

export function garmentMarks(
  garment: MarkedGarment,
  { ownerView }: MarkOptions,
): GarmentMarkKind[] {
  const { first, last } = statusMarks(garment);
  const marks: GarmentMarkKind[] = [...first];
  if (ownerView && garment.away) marks.push(`away:${garment.away}`);
  if (ownerView && garment.needsWash) marks.push('needs-wash');
  marks.push(...last);
  return marks;
}

/**
 * What the status says, before and after away and the wash. Exhaustive on
 * purpose: a new status fails the typecheck here until it decides its mark.
 */
function statusMarks(garment: MarkedGarment): {
  first: GarmentMarkKind[];
  last: GarmentMarkKind[];
} {
  switch (garment.status) {
    case 'wishlist':
      return garment.setAside
        ? { first: [], last: ['set-aside'] }
        : { first: ['to-buy'], last: [] };
    case 'archived':
      return { first: ['archived'], last: [] };
    case 'closet':
      return { first: [], last: [] };
    default: {
      const unknown: never = garment.status;
      throw new Error(`No mark for garment status ${String(unknown)}`);
    }
  }
}
