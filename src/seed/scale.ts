import { addDays, type IsoDate } from '../calendar-date';
import type { Persona, SeedGarment, SeedOutfit } from './persona';
import { stream } from './random';
import { REFERENCE_ANCHOR } from './simulate';

/**
 * The scale persona (#707): the demo persona's closet, outfits, week, trips
 * and wishlist grown to the 0.1 target (500 garments, about 1,000 outfits,
 * three years of entries and wears), so the page audit can time what the
 * demo's 83 garments and 13 weeks never stress: the Saved tab, the
 * generator's memory, insights' worn pairs, a full changes-feed sync.
 *
 * A generator over the demo bible, not a second bible: it adds clones of the
 * demo's garment rows (the form's checked fields, a new name and acquisition
 * day) and outfits that swap each garment of a demo outfit for another of
 * its category. The demo's own garments, outfits and capsules come first and
 * unchanged, so its week, events and trips still name what they name. The
 * history is simulated by simulate.ts as for the others, over three years.
 */

export const SCALE_GARMENTS = 500;
export const SCALE_OUTFITS = 1000;
export const SCALE_HISTORY_DAYS = 3 * 365;

/**
 * Generated garments are acquired in the history's first half year: an
 * outfit needs all its garments owned, so later ones would leave the early
 * years bare.
 */
const ACQUIRED_SPREAD_DAYS = 180;

/** Outfit draws before the seed gives up: ten per outfit, far past what the demo bible discards. */
const MAX_OUTFIT_DRAWS = SCALE_OUTFITS * 10;

export function scalePersona(demo: Persona): Persona {
  const garments = grownCloset(demo.garments);
  return {
    ...demo,
    key: 'scale',
    account: {
      email: 'scale@closet.invalid',
      firstName: 'Theo',
      lastName: 'Scale',
    },
    historyDays: SCALE_HISTORY_DAYS,
    garments,
    outfits: grownOutfits(demo.outfits, garments),
  };
}

function grownCloset(demo: SeedGarment[]): SeedGarment[] {
  // A plain, present garment to copy: the worn-out, lent and archived ones
  // stay the demo's own.
  const templates = demo.filter(
    (g) => !g.archivedOn && !g.away && g.fields.conditionNote === null,
  );
  const random = stream('scale', 'closet');
  const first = addDays(REFERENCE_ANCHOR, -(SCALE_HISTORY_DAYS - 1));
  const grown = [...demo];
  for (let n = demo.length; n < SCALE_GARMENTS; n += 1) {
    const template = templates[(n - demo.length) % templates.length];
    const copy = Math.floor((n - demo.length) / templates.length) + 2;
    const acquiredOn: IsoDate = addDays(
      first,
      Math.floor(random.next() * ACQUIRED_SPREAD_DAYS),
    );
    grown.push({
      ...template,
      id: `G${String(n + 1).padStart(3, '0')}`,
      fields: {
        ...template.fields,
        name: `${template.fields.name} ${copy}`,
        acquiredOn,
        quantity: 1,
      },
      repairs: [],
    });
  }
  return grown;
}

function grownOutfits(
  demo: SeedOutfit[],
  garments: SeedGarment[],
): SeedOutfit[] {
  const byId = new Map(garments.map((g) => [g.id, g]));
  const pool = new Map<string, string[]>();
  for (const g of garments) {
    if (g.archivedOn || g.away) continue;
    pool.set(g.fields.category, [...(pool.get(g.fields.category) ?? []), g.id]);
  }
  // createOutfit keeps one outfit per garment set: a repeat would fail the seed.
  const seen = new Set(demo.map((o) => [...o.garmentIds].sort().join()));
  const random = stream('scale', 'outfits');
  const outfits = [...demo];
  const bases = demo.filter((o) => o.name !== null);
  for (let n = 0; outfits.length < SCALE_OUTFITS; n += 1) {
    // Draws are discarded (a garment drawn twice, a repeated set), so a
    // bible whose combinations run out must stop the seed, not hang it.
    if (n === MAX_OUTFIT_DRAWS) {
      throw new Error(
        `The scale persona drew ${n} outfits and found only ${outfits.length} of ${SCALE_OUTFITS} distinct ones: the demo bible's categories no longer have the combinations`,
      );
    }
    const base = bases[n % bases.length];
    const garmentIds = base.garmentIds.map((id) => {
      const same = pool.get(byId.get(id)!.fields.category)!;
      return same[Math.floor(random.next() * same.length)];
    });
    // Two slots of one category (layered tops) may draw the same garment.
    if (new Set(garmentIds).size < garmentIds.length) continue;
    const key = [...garmentIds].sort().join();
    if (seen.has(key)) continue;
    seen.add(key);
    outfits.push({
      ...base,
      name: `${base.name} ${outfits.length + 1}`,
      favourite: false,
      garmentIds,
    });
  }
  return outfits;
}
