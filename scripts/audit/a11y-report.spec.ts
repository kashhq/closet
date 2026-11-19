import { describe, expect, it } from 'vitest';
import {
  type A11yReport,
  a11yPageNotes,
  compareA11y,
  renderA11y,
  renderA11yComparison,
  signatureOf,
  tally,
  TARGET_SIZE,
} from './a11y-report';

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

describe('signatureOf and countKinds', () => {
  it('strips positions, ids and dates from a selector', () => {
    expect(signatureOf('.cell:nth-child(7) > a')).toBe('.cell:nth-child > a');
    expect(
      signatureOf(
        'a[href="/g/123e4567-e89b-12d3-a456-426614174000/2026-11-19"]',
      ),
    ).toBe('a[href="/g/ID/DATE"]');
  });

  it('tallies nodes and sorted distinct kinds per measure', () => {
    const cells = [30, 1, 2, 3].map((n) => ({
      measure: TARGET_SIZE,
      signature: `.cell:nth-child(${n}) > a`,
    }));
    const other = { measure: TARGET_SIZE, signature: 'button' };
    expect(tally([...cells, other])).toEqual({
      counts: { [TARGET_SIZE]: 5 },
      kinds: { [TARGET_SIZE]: ['.cell:nth-child > a', 'button'] },
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
