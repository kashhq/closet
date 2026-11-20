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
   * Violating nodes per measure (an axe rule id, FIELD_FONT or TARGET_SIZE;
   * zeros left out). Follows the seed's dates and the platform's rounding, so
   * a rise only warns.
   */
  counts: Record<string, number>;
  /**
   * Distinct violating element kinds per measure (kindOf), sorted. Thirty
   * identical calendar cells are one kind, so the list does not follow the
   * seed: a kind the baseline lacks is what fails the compare.
   */
  kinds: Record<string, string[]>;
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

/**
 * What the pass reads off a violating element in the browser (a11y.ts,
 * `describeInPage`), raw: kindOf decides what of it reaches a kind.
 */
export interface ElementDescriptor {
  /** Lower-case tag name. */
  tag: string;
  /** The explicit `role` attribute. */
  role: string | null;
  /** The `type` attribute of an input or a button, else null. */
  type: string | null;
  /** A link's `href` attribute, else null. */
  href: string | null;
  classes: string[];
  region: RegionDescriptor;
}

/**
 * The element's nearest region: a form with an action, a `<section>` with an
 * id or `aria-labelledby`, a landmark (header, nav, aside, footer, dialog,
 * main), else the body. What separates two offenders of one shape on a page.
 */
export interface RegionDescriptor {
  tag: string;
  /** Its `id`, else its `aria-labelledby`. */
  name: string | null;
  /** A form's `action` attribute. */
  action: string | null;
  classes: string[];
}

/** One violating node as the pass found it. */
export interface Offender {
  measure: string;
  /** A selector or description a person can find the node by (the detail file only). */
  selector: string;
  /** kindOf of the element. */
  kind: string;
  detail: string;
}

/**
 * A word written in code (`garment-care`, `submit`, `wear`): lower-case
 * letters and hyphens. A uuid (v4 and v7 always carry their version digit),
 * a date, an index and a seeded name (capitalised, spaced) never match it.
 */
const CODE_WORD = /^[a-z]+(?:-[a-z]+)*$/;

function word(value: string | null): string | null {
  if (value === null) return null;
  return CODE_WORD.test(value) ? value : '*';
}

/**
 * The class names a stylesheet defines (`.btn`, `.app-bar`), its comments,
 * strings and layer names dropped; a name with an escape (Tailwind's `.lg\:btn`) is not one.
 * a11y.ts feeds it main.css and daisyUI's component sheets: the design
 * system's vocabulary, never a utility.
 */
export function designClassesOf(css: string): Set<string> {
  const code = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"[^"]*"|'[^']*'/g, '')
    // daisyUI's cascade layers (`@layer daisyui.l1.l2`) are not classes.
    .replace(/@layer[^{;]*/g, '');
  return new Set(
    [...code.matchAll(/\.([a-z][\w-]*)(?![\w\\-])/gi)].map((m) => m[1]),
  );
}

/**
 * Classes kept in a kind: the design system's, less BEM modifiers
 * (`ms-swatch--blue`), whose value is the garment's data.
 */
function designOf(
  classes: readonly string[],
  design: ReadonlySet<string>,
): string {
  return [...new Set(classes)]
    .filter((name) => design.has(name) && !name.includes('--'))
    .sort()
    .map((name) => `.${name}`)
    .join('');
}

/**
 * A link's or a form action's route shape: its path, each segment not a code
 * word (an id, a date, a token) as `*`, the query and hash dropped
 * (`/calendar/2026-11-19?week=1` is `/calendar/*`). Anything but a
 * root-relative path (another origin, a bare `#anchor`) is `*`: an outside
 * URL's path is a shop's, not ours.
 */
function routeShape(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//')) return '*';
  const path = url.split(/[?#]/, 1)[0];
  return path
    .split('/')
    .map((segment) => (segment === '' ? '' : word(segment)))
    .join('/');
}

function regionKind(
  region: RegionDescriptor,
  design: ReadonlySet<string>,
): string {
  const name = word(region.name);
  const action = region.action === null ? '' : ` ${routeShape(region.action)}`;
  return `${region.tag}${name === null ? '' : `#${name}`}${designOf(region.classes, design)}${action}`;
}

/**
 * The element's kind, from the element itself, never from a selector string
 * (#1207: every parse of axe's selectors leaked the next escape or data
 * value). Tag, explicit role, an input's or button's type, its design-system
 * classes, a link's route shape and its region: `a.link /garments/* in
 * main.page-shell`, `button[type=submit].btn in form /calendar/plan-week`. No
 * attribute value but a code word reaches it, so the
 * seed and the clock cannot, and thirty calendar cells are one kind.
 */
export function kindOf(
  element: ElementDescriptor,
  design: ReadonlySet<string>,
): string {
  const role = word(element.role);
  const type = word(element.type);
  return [
    element.tag,
    role === null ? '' : `[role=${role}]`,
    type === null ? '' : `[type=${type}]`,
    designOf(element.classes, design),
    element.href === null ? '' : ` ${routeShape(element.href)}`,
    ` in ${regionKind(element.region, design)}`,
  ].join('');
}

/** A watch on the page for one run: what changed since it began (a line each), and its end. */
export interface PageWatch {
  changes(): string[];
  stop(): void;
}

/** One axe run and two reruns before a page that keeps changing fails. */
export const STILL_RUN_ATTEMPTS = 3;

/** runWhileStill's answer: the still run's result and what each discarded run saw change. */
export interface StillRun<T> {
  result: T;
  discarded: string[][];
}

/**
 * `run`'s result from a run during which the page held still: a run that saw
 * a change (a `load` trigger, a poll, a late module swapping the DOM) is
 * discarded and rerun, and after `attempts` the page fails, naming what
 * changed; a half-stale result is never returned (#1207). a11y.ts injects it
 * into the page by its source, so it must reference nothing outside itself.
 */
export async function runWhileStill<T>(
  watch: () => PageWatch,
  run: () => Promise<T>,
  attempts: number,
): Promise<StillRun<T>> {
  const discarded: string[][] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const watching = watch();
    try {
      const result = await run();
      const changes = [...new Set(watching.changes())];
      if (changes.length === 0) return { result, discarded };
      discarded.push(changes);
    } finally {
      watching.stop();
    }
  }
  const last = discarded.at(-1) ?? [];
  throw new Error(
    `the page changed during each of ${attempts} axe runs: ${last.slice(0, 5).join('; ')}`,
  );
}

/** A page's PageA11y `counts` (nodes) and `kinds` (distinct kinds) per measure. */
export function tally(
  offenders: readonly Pick<Offender, 'measure' | 'kind'>[],
): Pick<PageA11y, 'counts' | 'kinds'> {
  const counts: Record<string, number> = {};
  const kinds = new Map<string, Set<string>>();
  for (const { measure, kind } of offenders) {
    counts[measure] = (counts[measure] ?? 0) + 1;
    const set = kinds.get(measure) ?? new Set<string>();
    set.add(kind);
    kinds.set(measure, set);
  }
  return {
    counts,
    kinds: Object.fromEntries(
      [...kinds].map(([measure, set]) => [measure, [...set].sort()]),
    ),
  };
}

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'] as const;

export interface A11yIncrease {
  id: string;
  target: string;
  measure: string;
  before: number;
  after: number;
}

export interface A11yNewKind {
  id: string;
  target: string;
  measure: string;
  kind: string;
}

export interface A11yComparison {
  /** A (page, measure, kind) the baseline lacks: the one thing that fails the compare. */
  newKinds: A11yNewKind[];
  /** Node counts that rose on a page both runs have: printed as WORSE, never failing. */
  increases: A11yIncrease[];
  /** Pages this run has and the baseline lacks: reported, never failing. */
  newPages: { id: string; target: string; total: number }[];
  /** Pages the baseline has and this (unfiltered) run lacks: a rename is one of each. */
  missingPages: string[];
}

const totalOf = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

function newKindsOf(page: PageA11y, was: PageA11y): A11yNewKind[] {
  const { id, target } = page;
  return Object.entries(page.kinds).flatMap(([measure, kinds]) => {
    const known = new Set(was.kinds[measure] ?? []);
    return kinds
      .filter((kind) => !known.has(kind))
      .map((kind) => ({ id, target, measure, kind }));
  });
}

function increasesOf(page: PageA11y, was: PageA11y): A11yIncrease[] {
  const { id, target } = page;
  return Object.entries(page.counts)
    .filter(([measure, count]) => count > (was.counts[measure] ?? 0))
    .map(([measure, after]) => ({
      id,
      target,
      measure,
      before: was.counts[measure] ?? 0,
      after,
    }));
}

/**
 * Kinds fail, counts warn: a kind is the same on any day and OS, so a new one
 * is a real regression; a node count follows the seed's dates and font
 * rounding, so a rise is only worth a look (the nightly gates no deploy). A
 * page only this run has is new, and one only the baseline has is missing
 * (unless `--only` filtered this run): neither fails, the author refreshes
 * the baseline.
 */
export function compareA11y(
  before: A11yReport,
  after: A11yReport,
): A11yComparison {
  const old = new Map(before.pages.map((page) => [page.id, page]));
  const newKinds: A11yNewKind[] = [];
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
    newKinds.push(...newKindsOf(page, was));
    increases.push(...increasesOf(page, was));
  }
  const seen = new Set(after.pages.map((page) => page.id));
  const missingPages = after.partial
    ? []
    : before.pages.filter((page) => !seen.has(page.id)).map((page) => page.id);
  return { newKinds, increases, newPages, missingPages };
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

export const REFRESH_BASELINE =
  'npm run audit:pages -- --out docs/perf/baseline';

/** The compare as markdown: new kinds (failing), count rises (warnings), then the pages to add to or drop from the baseline. */
export function renderA11yComparison(comparison: A11yComparison): string[] {
  const { newKinds, increases } = comparison;
  const lines = ['## Accessibility', ''];
  if (newKinds.length === 0) {
    lines.push('No violation kind the baseline lacks.', '');
  } else {
    lines.push(
      'New violation kinds (the compare fails):',
      '',
      '| Page | Target | Rule | Kind |',
      '| --- | --- | --- | --- |',
      ...newKinds.map(
        (item) =>
          `| #${item.id} | \`${item.target.replaceAll('|', '\\|')}\` | \`${item.measure}\` | \`${item.kind.replaceAll('|', '\\|')}\` |`,
      ),
      '',
    );
  }
  if (increases.length > 0) {
    lines.push(
      'Node counts above the baseline (WORSE, a warning: counts follow the seed and the platform):',
      '',
      '| Page | Target | Rule | Before | After |',
      '| --- | --- | --- | --: | --: |',
      ...increases.map(
        (increase) =>
          `| #${increase.id} | \`${increase.target.replaceAll('|', '\\|')}\` | \`${increase.measure}\` | ${increase.before} | ${increase.after} |`,
      ),
      '',
    );
  }
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
