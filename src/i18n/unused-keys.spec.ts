import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../project-root';
import english from './en/lang.json';

/** Every catalog key, dotted (`wear.WORE_IT`). */
function keysOf(node: object, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [prefix + key]
      : keysOf(value as object, `${prefix}${key}.`),
  );
}

/** The app's own code, specs left out: a key only a spec names is unused. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx?|js)$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
      ? [readFileSync(path, 'utf8')]
      : [];
  });
}

// A key built at runtime (`t(`occasion.${occasion}`)`) has no literal to find.
// Each prefix here names one family; the spec below checks the code still
// builds keys from it, so a retired family cannot keep its prefix.
const DYNAMIC_PREFIXES = [
  'errorPage.title.', // error-page.tsx, by the error's kind
  'gallery.problem.', // gallery/chips.tsx, by IdeaProblem
  'agent.reason.', // wishlist/suggestion-parts.tsx
  'agent.toast.', // the decision toasts
  'occasion.', // date-labels.ts
  'property.', // wardrobe/labels.ts: property.<name>.<value>
  'roles.', // wardrobe/labels.ts
  'sizes.measurement.',
  'sizes.unit.',
  'sizes.unitLabel.',
  'style.budget.', // style/labels.ts
  'style.style.',
  'trips.phase.', // trips/labels.ts
  'trips.warning.away.', // trip-page.tsx, by the away reason
  'weather.condition.', // weather/views.tsx
];

// #734: a key nothing names stays in the catalog until someone wonders what
// it is for; the retired features' strings piled up this way.
describe('the catalog', () => {
  const code = [
    ...sources(join(PROJECT_ROOT, 'src')),
    ...sources(join(PROJECT_ROOT, 'public/js')),
    ...sources(join(PROJECT_ROOT, 'views/assets/page')),
  ].join('\n');

  it('has no key that no source names', () => {
    const unused = keysOf(english)
      .filter((key) => !DYNAMIC_PREFIXES.some((p) => key.startsWith(p)))
      .filter(
        (key) =>
          !["'", '"', '`'].some((quote) => code.includes(quote + key + quote)),
      );
    expect(unused).toEqual([]);
  });

  it('declares only prefixes that a key and the code still use', () => {
    const keys = keysOf(english);
    const stale = DYNAMIC_PREFIXES.filter(
      (prefix) =>
        !keys.some((key) => key.startsWith(prefix)) ||
        !code.includes(`\`${prefix}\${`),
    );
    expect(stale).toEqual([]);
  });
});
