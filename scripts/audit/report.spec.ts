import { describe, expect, it } from 'vitest';
import {
  type AuditReport,
  compareReports,
  isChanged,
  renderComparison,
  renderReport,
  REPORT_VERSION,
  refuseOnlyWithOut,
  sqlKey,
  type StepResult,
} from './report';

const SESSION = 'select "id" from "user" where "id" = $1';
const GRID = 'select "id", "name" from "garment" where "owner_id" = $1';
const COUNT = 'select count(*) from "garment" where "owner_id" = $1';

function step(overrides: Partial<StepResult> & { name: string }): StepResult {
  return {
    id: `159 ${overrides.name}`,
    issue: 159,
    area: 'Wardrobe grid',
    kind: 'page',
    target: 'GET /wardrobe',
    status: 200,
    serverMs: { n: 20, min: 9, p50: 10, p95: 12, max: 14 },
    dbMs: { n: 20, min: 2, p50: 3, p95: 4, max: 5 },
    statements: { median: 2, min: 2, max: 2 },
    rows: { median: 49, min: 49, max: 49 },
    bytes: { median: 51200, min: 51200, max: 51200 },
    wireBytes: { median: 8192, min: 8192, max: 8192 },
    sql: [sqlKey(SESSION), sqlKey(GRID)],
    slowest: [{ sql: sqlKey(GRID), ms: 1.5 }],
    ...overrides,
  };
}

function report(steps: StepResult[], extraSql: string[] = []): AuditReport {
  return {
    version: REPORT_VERSION,
    persona: 'demo',
    createdAt: '2026-09-28T12:00:00.000Z',
    commit: 'abc1234',
    machine: {
      cpus: 16,
      model: 'Test CPU',
      node: 'v22.20.0',
      load: { start: 0.5, end: 0.7 },
    },
    runs: 20,
    warmup: 3,
    steps,
    sql: Object.fromEntries(
      [SESSION, GRID, ...extraSql].map((text) => [sqlKey(text), text]),
    ),
    unwalked: [],
  };
}

describe('sqlKey', () => {
  it('is short and the same for the same text', () => {
    expect(sqlKey(GRID)).toHaveLength(10);
    expect(sqlKey(GRID)).toBe(sqlKey(GRID));
    expect(sqlKey(GRID)).not.toBe(sqlKey(SESSION));
  });
});

describe('compareReports', () => {
  it('reports nothing for the same numbers and a time inside the noise', () => {
    const before = report([step({ name: 'Grid' })]);
    const after = report([
      step({
        name: 'Grid',
        serverMs: { n: 20, min: 9, p50: 11, p95: 13, max: 15 },
      }),
    ]);
    const [delta] = compareReports(before, after);
    expect(delta.timeChanged).toBe(false);
    expect(isChanged(delta)).toBe(false);
  });

  it('flags a time only past both the relative and the absolute threshold', () => {
    const at = (p50: number) =>
      report([
        step({
          name: 'Grid',
          serverMs: { n: 20, min: p50, p50, p95: p50, max: p50 },
        }),
      ]);
    // +50% but 0.5 ms: under the absolute floor.
    expect(compareReports(at(1), at(1.5))[0].timeChanged).toBe(false);
    // +4 ms but 20%: under the relative floor.
    expect(compareReports(at(20), at(24))[0].timeChanged).toBe(false);
    expect(compareReports(at(20), at(30))[0].timeChanged).toBe(true);
    expect(compareReports(at(40), at(20))[0].timeChanged).toBe(true);
  });

  it('reports any change in statements, rows and bytes, with the SQL gained and lost', () => {
    const before = report([step({ name: 'Grid' })]);
    const after = report(
      [
        step({
          name: 'Grid',
          statements: { median: 3, min: 3, max: 3 },
          rows: { median: 50, min: 50, max: 50 },
          bytes: { median: 40960, min: 40960, max: 40960 },
          sql: [sqlKey(SESSION), sqlKey(COUNT), sqlKey(COUNT)],
        }),
      ],
      [COUNT],
    );
    const [delta] = compareReports(before, after);
    expect(delta.statements).toEqual({ before: 2, after: 3 });
    expect(delta.rows).toEqual({ before: 49, after: 50 });
    expect(delta.bytes).toEqual({ before: 51200, after: 40960 });
    expect(delta.addedSql).toEqual([COUNT]);
    expect(delta.removedSql).toEqual([GRID]);
    expect(isChanged(delta)).toBe(true);
  });

  it('counts a statement sent once more as gained (a multiset, not a set)', () => {
    const before = report([step({ name: 'Grid' })]);
    const after = report([
      step({
        name: 'Grid',
        sql: [sqlKey(SESSION), sqlKey(SESSION), sqlKey(GRID)],
      }),
    ]);
    expect(compareReports(before, after)[0].addedSql).toEqual([SESSION]);
  });

  it('names steps that are new or gone', () => {
    const before = report([step({ name: 'Grid' }), step({ name: 'Old' })]);
    const after = report([step({ name: 'Grid' }), step({ name: 'New' })]);
    const byName = Object.fromEntries(
      compareReports(before, after).map((delta) => [
        delta.name,
        delta.presence,
      ]),
    );
    expect(byName).toEqual({ Grid: 'both', New: 'new', Old: 'gone' });
  });
});

describe('rendering', () => {
  it('writes a table per audit issue, and what was not walked', () => {
    const markdown = renderReport({
      ...report([
        step({ name: 'Grid' }),
        step({
          name: 'Today',
          id: '158 Today',
          issue: 158,
          area: 'Today',
          target: 'GET /',
          statements: { median: 8, min: 8, max: 9 },
        }),
      ]),
      unwalked: ['/wardrobe/new'],
    });
    expect(markdown.indexOf('## #158 Today')).toBeLessThan(
      markdown.indexOf('## #159 Wardrobe grid'),
    );
    expect(markdown).toContain(
      '| Grid | `GET /wardrobe` | 200 | 10.0 | 12.0 | 3.0 | 2 | 49 | 50.0 | 8.0 |',
    );
    // A count that varied between runs shows its range.
    expect(markdown).toContain('| 8 (8–9) |');
    expect(markdown).toContain('- `/wardrobe/new`');
  });

  it('writes the comparison: the changed steps, their SQL, and the noise line', () => {
    const before = report([step({ name: 'Grid' })]);
    const after = report(
      [
        step({
          name: 'Grid',
          serverMs: { n: 20, min: 4, p50: 5, p95: 6, max: 7 },
          statements: { median: 1, min: 1, max: 1 },
          sql: [sqlKey(GRID)],
        }),
      ],
      [],
    );
    const markdown = renderComparison(
      before,
      after,
      compareReports(before, after),
    );
    expect(markdown).toContain('1 faster, 0 slower');
    expect(markdown).toContain('**10.0 → 5.0 (-50%)**');
    expect(markdown).toContain('2 → 1 (-1)');
    expect(markdown).toContain(`- removed: \`${SESSION}\``);
  });

  it('says so when nothing changed', () => {
    const same = report([step({ name: 'Grid' })]);
    expect(renderComparison(same, same, compareReports(same, same))).toContain(
      'Nothing changed beyond the noise.',
    );
  });

  it('leaves accessibility out when the baseline has no a11y section', () => {
    const before = report([step({ name: 'Grid' })]);
    const after = {
      ...before,
      a11y: {
        viewport: { width: 390, height: 844 },
        axeVersion: '4',
        rules: {},
        pages: [],
      },
    };
    expect(
      renderComparison(before, after, compareReports(before, after)),
    ).not.toContain('## Accessibility');
  });
});

describe('refuseOnlyWithOut', () => {
  it('refuses a filtered run that would write the baseline', () => {
    expect(() => refuseOnlyWithOut('calendar', 'docs/perf/baseline')).toThrow(
      '--out writes the whole baseline; drop --only',
    );
  });

  it('allows --only alone and --out alone', () => {
    expect(() => refuseOnlyWithOut('calendar', undefined)).not.toThrow();
    expect(() =>
      refuseOnlyWithOut(undefined, 'docs/perf/baseline'),
    ).not.toThrow();
  });
});
