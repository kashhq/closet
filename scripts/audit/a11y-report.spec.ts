import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type A11yReport,
  a11yPageNotes,
  compareA11y,
  designClassesOf,
  type ElementDescriptor,
  kindOf,
  renderA11y,
  renderA11yComparison,
  tally,
  TARGET_SIZE,
} from './a11y-report';

const BASELINE = join(__dirname, '..', '..', 'docs', 'perf', 'baseline.json');

type PageSpec = {
  counts?: Record<string, number>;
  kinds?: Record<string, string[]>;
};

/** Counts default to one node per kind, so a spec only states what it varies. */
function report(
  pages: Record<string, PageSpec>,
  extra: Partial<A11yReport> = {},
): A11yReport {
  return {
    viewport: { width: 390, height: 844 },
    axeVersion: '4.0.0',
    rules: { label: { impact: 'critical', help: 'Form elements need labels' } },
    pages: Object.entries(pages).map(([id, { kinds = {}, counts }]) => ({
      id,
      issue: Number.parseInt(id.replace('#', ''), 10) || 1,
      name: id,
      target: `/${id}`,
      kinds,
      counts:
        counts ??
        Object.fromEntries(
          Object.entries(kinds).map(([m, k]) => [m, k.length]),
        ),
    })),
    ...extra,
  };
}

describe('kindOf and tally', () => {
  const design = new Set([
    'btn',
    'btn-ghost',
    'app-bar',
    'ms-swatch',
    'ms-swatch--blue',
  ]);
  const region = { tag: 'main', name: null, action: null, classes: [] };
  const element = (over: Partial<ElementDescriptor>): ElementDescriptor => ({
    tag: 'a',
    role: null,
    type: null,
    classes: [],
    region,
    ...over,
  });

  it('keeps tag, role, type, design classes and the region', () => {
    expect(
      kindOf(
        element({
          tag: 'button',
          role: 'tab',
          type: 'submit',
          classes: ['w-12', 'btn-ghost', 'btn', 'btn'],
          region: {
            tag: 'header',
            name: null,
            action: null,
            classes: ['app-bar', 'flex'],
          },
        }),
        design,
      ),
    ).toBe('button[role=tab][type=submit].btn.btn-ghost in header.app-bar');
  });

  it('drops utilities and BEM modifiers, whose value is data', () => {
    expect(
      kindOf(
        element({ classes: ['ms-swatch', 'ms-swatch--blue', 'px-2'] }),
        design,
      ),
    ).toBe('a.ms-swatch in main');
  });

  it('gives one kind to elements differing only by an id, a date or a token', () => {
    const form = (action: string, name: string) =>
      kindOf(
        element({ region: { tag: 'form', name, action, classes: [] } }),
        design,
      );
    expect(
      form(
        '/garments/0193e4567-e89b-72d3-a456-426614174000/wear?day=2026-11-19',
        'day-2026-11-19',
      ),
    ).toBe(
      form('/garments/123e4567-e89b-12d3-a456-426614174000/wear', 'Run 4'),
    );
    expect(form('/calendar/2026-11-19/plan', 'garment-care')).toBe(
      'a in form#garment-care /calendar/*/plan',
    );
    expect(
      kindOf(element({ role: 'Thursday, Nov 20', type: 'x"y' }), design),
    ).toBe('a[role=*][type=*] in main');
  });

  it('keeps two offenders of one shape in different regions apart', () => {
    const inSection = (name: string) =>
      kindOf(
        element({
          region: { tag: 'section', name, action: null, classes: [] },
        }),
        design,
      );
    expect(inSection('garment-care')).not.toBe(inSection('garment-wear'));
    expect(inSection('garment-care')).toBe('a in section#garment-care');
  });

  it('reads the design classes a stylesheet defines, not its comments, strings or escapes', () => {
    expect(
      [
        ...designClassesOf(
          '@layer daisyui.l1 { /* .note */ .btn:hover, :where(.app-bar) > .lg\\:btn { margin: .5rem 0.25rem; } } @import "x.css";',
        ),
      ].sort(),
    ).toEqual(['app-bar', 'btn']);
  });

  it('holds every kind of the committed demo baseline free of data', () => {
    const { a11y } = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
      a11y: A11yReport;
    };
    const kinds = a11y.pages.flatMap((page) =>
      Object.values(page.kinds).flat(),
    );
    expect(kinds.length).toBeGreaterThan(0);
    // A kind holding a digit held data (a date, an id, an index): changing
    // its digits would change it. A heading's tag is the one digit allowed.
    const otherDigits = (text: string) =>
      text.replace(/\d/g, (d) => String((Number(d) + 1) % 10));
    for (const kind of kinds) {
      const bare = kind.replace(/\bh[1-6]\b/g, 'h');
      expect(otherDigits(bare)).toBe(bare);
      expect(kind).toMatch(/ in [a-z]+/);
    }
  });

  it('tallies nodes and sorted distinct kinds per measure', () => {
    const cells = [30, 1, 2, 3].map(() => ({
      measure: TARGET_SIZE,
      kind: kindOf(element({ classes: ['btn'] }), design),
    }));
    const other = { measure: TARGET_SIZE, kind: 'button in main' };
    expect(tally([...cells, other])).toEqual({
      counts: { [TARGET_SIZE]: 5 },
      kinds: { [TARGET_SIZE]: ['a.btn in main', 'button in main'] },
    });
    expect(tally([])).toEqual({ counts: {}, kinds: {} });
  });
});

describe('compareA11y', () => {
  it('fails on a kind the baseline page lacks', () => {
    const { newKinds } = compareA11y(
      report({ a: { kinds: { label: ['input.x'] } } }),
      report({ a: { kinds: { label: ['input.x', 'input.y'] } } }),
    );
    expect(newKinds).toEqual([
      { id: 'a', target: '/a', measure: 'label', kind: 'input.y' },
    ]);
  });

  it('treats a measure absent from the baseline page as all new', () => {
    const { newKinds } = compareA11y(
      report({ a: {} }),
      report({ a: { kinds: { [TARGET_SIZE]: ['button'] } } }),
    );
    expect(newKinds).toMatchObject([{ measure: TARGET_SIZE, kind: 'button' }]);
  });

  it('only warns when the node count rises on a known kind', () => {
    const { newKinds, increases } = compareA11y(
      report({
        a: {
          kinds: { [TARGET_SIZE]: ['button'] },
          counts: { [TARGET_SIZE]: 2 },
        },
      }),
      report({
        a: {
          kinds: { [TARGET_SIZE]: ['button'] },
          counts: { [TARGET_SIZE]: 5 },
        },
      }),
    );
    expect(newKinds).toEqual([]);
    expect(increases).toEqual([
      { id: 'a', target: '/a', measure: TARGET_SIZE, before: 2, after: 5 },
    ]);
  });

  it('does not fail a kind that was fixed and then came back', () => {
    // The baseline keeps the kind until a refresh, so its return is not new.
    const baseline = report({ a: { kinds: { label: ['input.x'] } } });
    expect(compareA11y(baseline, report({ a: {} })).newKinds).toEqual([]);
    expect(
      compareA11y(baseline, report({ a: { kinds: { label: ['input.x'] } } }))
        .newKinds,
    ).toEqual([]);
  });

  it('does not report a lower count', () => {
    const result = compareA11y(
      report({ a: { kinds: { label: ['x'] }, counts: { label: 3 } } }),
      report({ a: {} }),
    );
    expect(result.increases).toEqual([]);
    expect(result.newKinds).toEqual([]);
  });

  it('reports a page the baseline lacks as new, not as a new kind', () => {
    const result = compareA11y(
      report({ a: {} }),
      report({
        a: {},
        b: { kinds: { label: ['x', 'y'], [TARGET_SIZE]: ['z'] } },
      }),
    );
    expect(result.newKinds).toEqual([]);
    expect(result.newPages).toEqual([{ id: 'b', target: '/b', total: 3 }]);
    expect(result.missingPages).toEqual([]);
  });

  it('reports a baseline page this run lacks, unless --only filtered the run', () => {
    const before = report({ a: {}, b: {} });
    expect(compareA11y(before, report({ a: {} })).missingPages).toEqual(['b']);
    expect(
      compareA11y(before, report({ a: {} }, { partial: true })).missingPages,
    ).toEqual([]);
  });

  it('a renamed step is one new page and one missing page', () => {
    const result = compareA11y(report({ old: {} }), report({ renamed: {} }));
    expect(result.newPages).toHaveLength(1);
    expect(result.missingPages).toEqual(['old']);
  });
});

describe('renderA11yComparison', () => {
  it('says so when no kind is new', () => {
    const text = renderA11yComparison(
      compareA11y(report({ a: {} }), report({ a: {} })),
    ).join('\n');
    expect(text).toContain('No violation kind the baseline lacks');
  });

  it('tables new kinds as failing and count rises as warnings', () => {
    const text = renderA11yComparison(
      compareA11y(
        report({ a: { kinds: { label: ['x'] }, counts: { label: 1 } } }),
        report({
          a: { kinds: { label: ['x', 'y'] }, counts: { label: 4 } },
          b: { kinds: { label: ['x'] } },
        }),
      ),
    ).join('\n');
    expect(text).toContain('New violation kinds (the compare fails)');
    expect(text).toContain('| #a | `/a` | `label` | `y` |');
    expect(text).toContain('(WORSE, a warning');
    expect(text).toContain('| #a | `/a` | `label` | 1 | 4 |');
    expect(text).toContain(
      'new page #b (/b): 1 violations, add it to the baseline with `npm run audit:pages -- --out docs/perf/baseline`',
    );
  });

  it('has no notes when the pages match', () => {
    expect(
      a11yPageNotes({
        newKinds: [],
        increases: [],
        newPages: [],
        missingPages: [],
      }),
    ).toEqual([]);
  });
});

describe('renderA11y', () => {
  it('totals each measure over its pages, worst impact first', () => {
    const text = renderA11y(
      report({
        a: { counts: { [TARGET_SIZE]: 5, label: 1 } },
        b: { counts: { [TARGET_SIZE]: 2 } },
      }),
    ).join('\n');
    expect(text.indexOf('| `label` |')).toBeLessThan(
      text.indexOf(`| \`${TARGET_SIZE}\` |`),
    );
    expect(text).toContain('| 7 |');
  });

  it('says so when there are no violations', () => {
    expect(renderA11y(report({ a: {} })).join('\n')).toContain(
      'No violations.',
    );
  });
});
