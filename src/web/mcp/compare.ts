import {
  categoryRole,
  GARMENT_ROLES,
  type GarmentRole,
} from '../../wardrobe/properties';

/**
 * compare_with_shared_wardrobe (#33): the requester's closet against a
 * wardrobe shared with them (the demo persona's, the owner's target), by
 * role and type, so their Claude can talk through the gaps (what to buy
 * next, #34) and what they have that the other does not. Pure: both sides
 * arrive as rows (closet garments, inCloset), the answer is plain data.
 */

/** One garment as the comparison reads it. */
export interface ComparedGarment {
  id: number;
  name: string | null;
  category: string;
  /** Null when untyped or the category has no types (a custom one). */
  type: string | null;
  brand: string | null;
  /** GARMENT_COLORS names. */
  colors: string[];
  /** '49.90', US dollars; null when unknown, absent on a VIEW share (#680). */
  price?: string | null;
  sourceUrl: string | null;
}

/** A role and type (or, untyped, the category) that either side holds. */
interface ComparisonGroup {
  role: GarmentRole;
  /** The type, or the category for an untyped garment. */
  kind: string;
  owned: GarmentBrief[];
  shared: GarmentBrief[];
}

interface GarmentBrief {
  id: number;
  name: string | null;
  brand: string | null;
  colors: string[];
  price?: string | null;
  sourceUrl: string | null;
}

export interface WardrobeComparison {
  /** Garments per role on each side, every role listed. */
  counts: Record<GarmentRole, { owned: number; shared: number }>;
  /** What the shared wardrobe has and the requester has none of: most first. */
  gaps: ComparisonGroup[];
  /** Kinds both hold, with how many each: where the counts differ is a hint. */
  overlap: ComparisonGroup[];
  /** What only the requester has. */
  onlyOwned: ComparisonGroup[];
}

function brief(piece: ComparedGarment): GarmentBrief {
  return {
    id: piece.id,
    name: piece.name,
    brand: piece.brand,
    colors: piece.colors,
    price: piece.price,
    sourceUrl: piece.sourceUrl,
  };
}

const ROLE_ORDER = new Map(GARMENT_ROLES.map((role, index) => [role, index]));

/** Roles in GARMENT_ROLES order, then the kind alphabetically. */
function byRoleThenKind(a: ComparisonGroup, b: ComparisonGroup): number {
  return (
    ROLE_ORDER.get(a.role)! - ROLE_ORDER.get(b.role)! ||
    a.kind.localeCompare(b.kind)
  );
}

export function compareWardrobes(
  owned: readonly ComparedGarment[],
  shared: readonly ComparedGarment[],
): WardrobeComparison {
  const counts = Object.fromEntries(
    GARMENT_ROLES.map((role) => [role, { owned: 0, shared: 0 }]),
  ) as Record<GarmentRole, { owned: number; shared: number }>;
  const groups = new Map<string, ComparisonGroup>();
  const add = (garment: ComparedGarment, side: 'owned' | 'shared') => {
    const role = categoryRole(garment.category);
    const kind = garment.type ?? garment.category;
    counts[role][side] += 1;
    const key = `${role}\u0000${kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { role, kind, owned: [], shared: [] };
      groups.set(key, group);
    }
    group[side].push(brief(garment));
  };
  for (const garment of owned) add(garment, 'owned');
  for (const garment of shared) add(garment, 'shared');

  const all = [...groups.values()].sort(byRoleThenKind);
  return {
    counts,
    gaps: all
      .filter((group) => group.owned.length === 0)
      // Stable: equal counts keep role-then-kind order.
      .sort((a, b) => b.shared.length - a.shared.length),
    overlap: all.filter(
      (group) => group.owned.length > 0 && group.shared.length > 0,
    ),
    onlyOwned: all.filter((group) => group.shared.length === 0),
  };
}
