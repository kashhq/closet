import { describe, expect, it } from 'vitest';
import {
  type A11yReport,
  a11yPageNotes,
  compareA11y,
  countKinds,
  renderA11y,
  renderA11yComparison,
  signatureOf,
  TARGET_SIZE,
} from './a11y-report';

function report(
  pages: Record<string, Record<string, number>>,
  extra: Partial<A11yReport> = {},
): A11yReport {
  return {
    viewport: { width: 390, height: 844 },
    axeVersion: '4.0.0',
    rules: { label: { impact: 'critical', help: 'Form elements need labels' } },
    pages: Object.entries(pages).map(([id, counts]) => ({
      id,
      issue: Number.parseInt(id.replace('#', ''), 10) || 1,
      name: id,
      target: `/${id}`,
      counts,
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

  it('counts distinct kinds per measure, not nodes', () => {
    const cells = [1, 2, 3, 30].map((n) => ({
      measure: TARGET_SIZE,
      signature: `.cell:nth-child(${n}) > a`,
    }));
    const other = { measure: TARGET_SIZE, signature: 'button' };
    expect(countKinds([...cells, other])).toEqual({ [TARGET_SIZE]: 2 });
    expect(countKinds([])).toEqual({});
  });
});

describe('compareA11y', () => {
  it('lists a measure that went up on a page both have', () => {
    const { increases } = compareA11y(
      report({ a: { label: 1 } }),
      report({ a: { label: 2 } }),
    );
    expect(increases).toEqual([
      { id: 'a', target: '/a', measure: 'label', before: 1, after: 2 },
    ]);
  });

  it('counts a measure absent from the baseline page as zero', () => {
    const { increases } = compareA11y(
      report({ a: { label: 1 } }),
      report({ a: { label: 1, [TARGET_SIZE]: 1 } }),
    );
    expect(increases).toMatchObject([
      { measure: TARGET_SIZE, before: 0, after: 1 },
    ]);
  });

  it('does not fail a lower count', () => {
    const { increases } = compareA11y(
      report({ a: { label: 3 } }),
      report({ a: {} }),
    );
    expect(increases).toEqual([]);
  });

  it('reports a page the baseline lacks as new, not as an increase', () => {
    const result = compareA11y(
      report({ a: {} }),
      report({ a: {}, b: { label: 2, [TARGET_SIZE]: 1 } }),
    );
    expect(result.increases).toEqual([]);
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
  it('says so when nothing went up', () => {
    const text = renderA11yComparison(
      compareA11y(report({ a: {} }), report({ a: {} })),
    ).join('\n');
    expect(text).toContain('No page has more violations');
  });

  it('tables the increases and names the command for new pages', () => {
    const text = renderA11yComparison(
      compareA11y(
        report({ a: { label: 1 } }),
        report({ a: { label: 2 }, b: { label: 1 } }),
      ),
    ).join('\n');
    expect(text).toContain('increases (the compare fails)');
    expect(text).toContain('| #a | `/a` | `label` | 1 | 2 |');
    expect(text).toContain(
      'new page #b (/b): 1 violations, add it to the baseline with `npm run audit:pages -- --out docs/perf/baseline`',
    );
  });

  it('has no notes when the pages match', () => {
    expect(
      a11yPageNotes({ increases: [], newPages: [], missingPages: [] }),
    ).toEqual([]);
  });
});

describe('renderA11y', () => {
  it('totals each measure over its pages, worst impact first', () => {
    const text = renderA11y(
      report({
        a: { [TARGET_SIZE]: 5, label: 1 },
        b: { [TARGET_SIZE]: 2 },
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
