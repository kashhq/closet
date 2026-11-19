/**
 * The accessibility pass's report (a11y.ts fills it): per page, per rule
 * violation counts, the diff that fails `--compare` on an increase, and the
 * markdown. Pure, like report.ts, which embeds it.
 */

/** Below this, iOS Safari zooms the page when the field takes focus. */
export const FIELD_FONT_MIN_PX = 16;
/** Apple's and WCAG 2.5.5's (AAA) minimum tap target, each side. */
export const TARGET_MIN_PX = 44;

/** The page's measures beside axe's rule ids, in the counts and the compare. */
export const FIELD_FONT = `field font < ${FIELD_FONT_MIN_PX} px`;
export const TARGET_SIZE = `target < ${TARGET_MIN_PX} px`;

export interface PageA11y {
  id: string;
  issue: number;
  name: string;
  target: string;
  /** Violating nodes per measure: an axe rule id, FIELD_FONT or TARGET_SIZE; zeros left out. */
  counts: Record<string, number>;
}

export interface A11yReport {
  viewport: { width: number; height: number };
  axeVersion: string;
  /** Every axe rule that fired anywhere: its impact and axe's one-line help. */
  rules: Record<string, { impact: string; help: string }>;
  pages: PageA11y[];
}

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'] as const;

export interface A11yIncrease {
  id: string;
  target: string;
  measure: string;
  before: number;
  after: number;
}

/**
 * Every page's measure that went up. A page the baseline lacks compares
 * from zero; a page this run skipped (`--only`) is not compared.
 */
export function a11yIncreases(
  before: A11yReport,
  after: A11yReport,
): A11yIncrease[] {
  const old = new Map(before.pages.map((page) => [page.id, page.counts]));
  return after.pages.flatMap((page) => {
    const was = old.get(page.id) ?? {};
    return Object.entries(page.counts)
      .filter(([measure, count]) => count > (was[measure] ?? 0))
      .map(([measure, count]) => ({
        id: page.id,
        target: page.target,
        measure,
        before: was[measure] ?? 0,
        after: count,
      }));
  });
}

function impactOf(report: A11yReport, measure: string): string {
  return report.rules[measure]?.impact ?? 'measure';
}

/** The pass as markdown: each measure's total and its pages, worst impact first. */
export function renderA11y(report: A11yReport): string[] {
  const totals = new Map<string, { count: number; pages: string[] }>();
  for (const page of report.pages) {
    for (const [measure, count] of Object.entries(page.counts)) {
      const total = totals.get(measure) ?? { count: 0, pages: [] };
      total.count += count;
      total.pages.push(`#${page.issue} ${page.name} (${count})`);
      totals.set(measure, total);
    }
  }
  const rank = (measure: string) => {
    const index = (IMPACT_ORDER as readonly string[]).indexOf(
      impactOf(report, measure),
    );
    return index === -1 ? IMPACT_ORDER.length : index;
  };
  const lines = [
    '## Accessibility',
    '',
    `${report.pages.length} pages at ${report.viewport.width} × ${report.viewport.height} in Chromium, axe-core ${report.axeVersion}; ` +
      `counts are violating nodes. \`${FIELD_FONT}\` is a text field iOS zooms into, \`${TARGET_SIZE}\` a tap target smaller on either side.`,
    '',
  ];
  if (totals.size === 0) {
    lines.push('No violations.', '');
    return lines;
  }
  lines.push('| Rule | Impact | Nodes | Pages |', '| --- | --- | --: | --- |');
  for (const [measure, total] of [...totals].sort(
    ([a, x], [b, y]) => rank(a) - rank(b) || y.count - x.count,
  )) {
    lines.push(
      `| \`${measure}\` | ${impactOf(report, measure)} | ${total.count} | ${total.pages.join(', ').replaceAll('|', '\\|')} |`,
    );
  }
  lines.push('');
  return lines;
}

export function renderA11yIncreases(
  increases: readonly A11yIncrease[],
): string[] {
  if (increases.length === 0) {
    return [
      '## Accessibility',
      '',
      'No page has more violations than the baseline.',
      '',
    ];
  }
  return [
    '## Accessibility: increases (the compare fails)',
    '',
    '| Page | Target | Rule | Before | After |',
    '| --- | --- | --- | --: | --: |',
    ...increases.map(
      (increase) =>
        `| #${increase.id} | \`${increase.target.replaceAll('|', '\\|')}\` | \`${increase.measure}\` | ${increase.before} | ${increase.after} |`,
    ),
    '',
  ];
}
