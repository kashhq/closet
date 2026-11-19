/**
 * The accessibility pass's report (a11y.ts fills it): per page, per rule
 * violation counts, the diff that fails `--compare` on an increase, and the
 * markdown. Pure, like report.ts, which embeds it.
 */

/** Below this, iOS Safari zooms the page when the field takes focus. */
export const FIELD_FONT_MIN_PX = 16;
/** Apple's and WCAG 2.5.5's (AAA) minimum tap target, each side. */
export const TARGET_MIN_PX = 44;
/**
 * Slack under TARGET_MIN_PX before a target counts: a font's sub-pixel
 * metrics differ between macOS and Linux, so a 43.8 px box on one is 44.1 on
 * the other. Real shortfalls are whole CSS units (a 40 px class).
 */
export const TARGET_TOLERANCE_PX = 0.5;

/** The page's measures beside axe's rule ids, in the counts and the compare. */
export const FIELD_FONT = `field font < ${FIELD_FONT_MIN_PX} px`;
export const TARGET_SIZE = `target < ${TARGET_MIN_PX} px`;

export interface PageA11y {
  id: string;
  issue: number;
  name: string;
  target: string;
  /**
   * Violating element kinds per measure (signatureOf), not nodes: an axe rule
   * id, FIELD_FONT or TARGET_SIZE; zeros left out. Thirty identical calendar
   * cells are one kind, so the number does not follow the seed's dates.
   */
  counts: Record<string, number>;
}

export interface A11yReport {
  viewport: { width: number; height: number };
  axeVersion: string;
  /** Every axe rule that fired anywhere: its impact and axe's one-line help. */
  rules: Record<string, { impact: string; help: string }>;
  pages: PageA11y[];
  /** Set when `--only` filtered the pages: the baseline's other pages are not missing. */
  partial?: true;
}

/** One violating node as the pass found it. */
export interface Offender {
  measure: string;
  /** A selector or description a person can find the node by. */
  selector: string;
  /** What distinguishes the element's kind from other nodes (signatureOf's input). */
  signature: string;
  detail: string;
}

/**
 * Collapses what varies with seeded data or position into one kind: the
 * `:nth-child(3)` index, a uuid and an ISO date. Two nodes of one rule with
 * the same signature are one violation kind.
 */
export function signatureOf(selector: string): string {
  return selector
    .replace(/:nth-(child|of-type|last-child|last-of-type)\(\d+\)/g, ':nth-$1')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      'ID',
    )
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE');
}

/** Distinct (measure, signature) pairs per measure: PageA11y.counts. */
export function countKinds(
  offenders: readonly Pick<Offender, 'measure' | 'signature'>[],
): Record<string, number> {
  const kinds = new Map<string, Set<string>>();
  for (const { measure, signature } of offenders) {
    const set = kinds.get(measure) ?? new Set<string>();
    set.add(signatureOf(signature));
    kinds.set(measure, set);
  }
  return Object.fromEntries(
    [...kinds].map(([measure, set]) => [measure, set.size]),
  );
}

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'] as const;

export interface A11yIncrease {
  id: string;
  target: string;
  measure: string;
  before: number;
  after: number;
}

export interface A11yComparison {
  increases: A11yIncrease[];
  /** Pages this run has and the baseline lacks: reported, never failing. */
  newPages: { id: string; target: string; total: number }[];
  /** Pages the baseline has and this (unfiltered) run lacks: a rename is one of each. */
  missingPages: string[];
}

const totalOf = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

/**
 * Every measure that went up on a page both runs have. A page only this run
 * has is new, and one only the baseline has is missing (unless `--only`
 * filtered this run): neither fails, the author refreshes the baseline.
 */
export function compareA11y(
  before: A11yReport,
  after: A11yReport,
): A11yComparison {
  const old = new Map(before.pages.map((page) => [page.id, page.counts]));
  const increases: A11yIncrease[] = [];
  const newPages: A11yComparison['newPages'] = [];
  for (const page of after.pages) {
    const was = old.get(page.id);
    if (!was) {
      newPages.push({
        id: page.id,
        target: page.target,
        total: totalOf(page.counts),
      });
      continue;
    }
    for (const [measure, count] of Object.entries(page.counts)) {
      if (count > (was[measure] ?? 0)) {
        increases.push({
          id: page.id,
          target: page.target,
          measure,
          before: was[measure] ?? 0,
          after: count,
        });
      }
    }
  }
  const seen = new Set(after.pages.map((page) => page.id));
  const missingPages = after.partial
    ? []
    : before.pages.filter((page) => !seen.has(page.id)).map((page) => page.id);
  return { increases, newPages, missingPages };
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
      `counts are violating element kinds (one per distinct selector pattern, not per node). \`${FIELD_FONT}\` is a text field iOS zooms into, \`${TARGET_SIZE}\` a tap target smaller on either side.`,
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

export const REFRESH_BASELINE =
  'npm run audit:pages -- --out docs/perf/baseline';

/** The compare as markdown: the failing increases, then the pages to add to or drop from the baseline. */
export function renderA11yComparison(comparison: A11yComparison): string[] {
  const { increases } = comparison;
  const lines =
    increases.length === 0
      ? [
          '## Accessibility',
          '',
          'No page has more violations than the baseline.',
          '',
        ]
      : [
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
  lines.push(...a11yPageNotes(comparison));
  return lines;
}

/** New and missing pages, one line each; empty when the pages match. */
export function a11yPageNotes(comparison: A11yComparison): string[] {
  const notes = [
    ...comparison.newPages.map(
      (page) =>
        `- new page #${page.id} (${page.target}): ${page.total} violations, add it to the baseline with \`${REFRESH_BASELINE}\``,
    ),
    ...comparison.missingPages.map(
      (id) =>
        `- missing page #${id}: in the baseline, not in this run (renamed or removed?), refresh it with \`${REFRESH_BASELINE}\``,
    ),
  ];
  return notes.length === 0 ? [] : [...notes, ''];
}
