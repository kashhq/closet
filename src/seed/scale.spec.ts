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

  it('puts every outfit together from garments the persona owns', () => {
    const owned = new Set(scale.garments.map((g) => g.id));
    for (const outfit of scale.outfits) {
      for (const id of outfit.garmentIds) expect(owned).toContain(id);
    }
  });

  it('lives three years, the same on every run', () => {
    const life = simulate(scale, '2026-09-26');
    expect(life.weather.length).toBeGreaterThanOrEqual(SCALE_HISTORY_DAYS);
    expect(life.entries.filter((e) => e.worn).length).toBeGreaterThan(900);
    expect(simulate(scale, '2026-09-26')).toEqual(life);
  });
});
