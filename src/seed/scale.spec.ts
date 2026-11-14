import { describe, expect, it } from 'vitest';
import { loadPersona } from './persona';
import {
  SCALE_GARMENTS,
  SCALE_HISTORY_DAYS,
  SCALE_OUTFITS,
  scalePersona,
} from './scale';
import { simulate } from './simulate';

describe('the scale persona', () => {
  const demo = loadPersona('demo');
  const scale = scalePersona(demo);

  it('grows demo to the 0.1 target and keeps demo first, unchanged', () => {
    expect(scale.garments).toHaveLength(SCALE_GARMENTS);
    expect(scale.outfits).toHaveLength(SCALE_OUTFITS);
    expect(scale.garments.slice(0, demo.garments.length)).toEqual(
      demo.garments,
    );
    expect(scale.outfits.slice(0, demo.outfits.length)).toEqual(demo.outfits);
  });

  it('is generated the same every time, with unique ids and garment sets', () => {
    expect(scalePersona(demo)).toEqual(scale);
    const ids = scale.garments.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sets = scale.outfits.map((o) => [...o.garmentIds].sort().join());
    expect(new Set(sets).size).toBe(sets.length);
  });

  it('puts every outfit together from distinct garments the persona owns', () => {
    const owned = new Set(scale.garments.map((g) => g.id));
    for (const outfit of scale.outfits) {
      for (const id of outfit.garmentIds) expect(owned).toContain(id);
      expect(new Set(outfit.garmentIds).size).toBe(outfit.garmentIds.length);
    }
  });

  it('stops with a reason when the bible has too few combinations', () => {
    // One plain garment: its 500 copies make about 500 one-garment outfits.
    const plain = demo.garments.find(
      (g) => !g.archivedOn && !g.away && g.fields.conditionNote === null,
    )!;
    const named = demo.outfits.find((o) => o.name !== null)!;
    const tiny = {
      ...demo,
      garments: [plain],
      outfits: [{ ...named, garmentIds: [plain.id] }],
    };
    expect(() => scalePersona(tiny)).toThrow(/distinct ones/);
  });

  it('lives three years, the same on every run', () => {
    const life = simulate(scale, '2026-09-26');
    expect(life.weather.length).toBeGreaterThanOrEqual(SCALE_HISTORY_DAYS);
    expect(life.entries.filter((e) => e.worn).length).toBeGreaterThan(900);
    expect(simulate(scale, '2026-09-26')).toEqual(life);
  });
});
