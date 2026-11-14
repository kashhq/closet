import { createHash } from 'node:crypto';
import { type Count, noiseBetween, relativeChange, type Timing } from './stats';

/**
 * The page audit's report (scripts/audit-pages.ts): the JSON a later run is
 * diffed against, its markdown table, and the diff. Pure, so report.spec.ts
 * pins it; the walk that fills it is scripts/audit/walk.ts.
 */

export const REPORT_VERSION = 2;

/**
 * A time change counts only past both: relative to the baseline's p50, and
 * absolute. Two runs of one build on the production host, shared with other agents'
 * test runs, disagree by 35% and 2.5 ms at their 90th percentile; past both,
 * 3 steps of 274 (docs/perf/README.md, Noise).
 */
const TIME_NOISE = { relative: 0.35, absoluteMs: 2 };

export type StepKind =
  | 'page'
  | 'fragment'
  | 'action'
  | 'file'
  | 'mcp'
  | 'job'
  | 'platform';

export interface StepResult {
  /** Stable between runs, what the diff matches on: `<issue> <name>`. */
  id: string;
  issue: number;
  /** The audit issue's subject: "Today", "Wardrobe grid". */
  area: string;
  name: string;
  kind: StepKind;
  /** `GET /wardrobe/:id`, `mcp search_garments`, `job replan`. */
  target: string;
  /** The HTTP status every run answered; null for a job. */
  status: number | null;
  /** Wall time of the request in process (inject) or of the job's run. */
  serverMs: Timing;
  /** Server-Timing's `db`; null where the answer has none (a job, a checked secret, a static path). */
  dbMs: Timing | null;
  statements: Count;
  rows: Count;
  /** The body as the browser reads it (decompressed). */
  bytes: Count;
  /** The body as sent, with `Accept-Encoding: br, gzip`. */
  wireBytes: Count;
  /** The last run's statements in order, as keys of AuditReport.sql. */
  sql: string[];
  /** The last run's slowest statements. */
  slowest: { sql: string; ms: number }[];
}

export interface AuditReport {
  version: typeof REPORT_VERSION;
  createdAt: string;
  commit: string;
  /** The seed persona the walk ran over (fixture.ts): reports of two never compare. */
  persona: string;
  machine: {
    cpus: number;
    model: string;
    node: string;
    /** The 1-minute load average as the walk started and ended: how busy the box was. */
    load: { start: number; end: number };
  };
  runs: number;
  warmup: number;
  steps: StepResult[];
  /** Statement key to its SQL text: each distinct statement once. */
  sql: Record<string, string>;
  /** Route templates and MCP tools no step reached (empty when the walk was filtered). */
  unwalked: string[];
}

/** A report read back (`--compare`): refused when another version wrote it. */
export function parseReport(text: string, source: string): AuditReport {
  const parsed = JSON.parse(text) as { version?: unknown };
  if (parsed.version !== REPORT_VERSION) {
    throw new Error(
      `${source} is a version ${String(parsed.version)} report; this is version ${REPORT_VERSION}`,
    );
  }
  return parsed as AuditReport;
}

/** A statement's key in AuditReport.sql: short, and the same for the same text. */
export function sqlKey(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 10);
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const ms = (value: number) => value.toFixed(1);

function count(value: Count, format: (n: number) => string = String): string {
  return value.min === value.max
    ? format(value.median)
    : `${format(value.median)} (${format(value.min)}–${format(value.max)})`;
}

/** `|` would end a markdown cell. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|');
}

function groupByArea<T extends { issue: number; area: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => a.issue - b.issue)) {
    const title = `#${item.issue} ${item.area}`;
    groups.set(title, [...(groups.get(title) ?? []), item]);
  }
  return groups;
}

/** The report as markdown: a table per audit issue, then what was not walked. */
export function renderReport(report: AuditReport): string {
  const lines = [
    '# Page audit',
    '',
    `Commit \`${report.commit}\`, persona \`${report.persona}\`, ${report.createdAt}. ${report.runs} runs per step after ${report.warmup} warm-up, ` +
      `${report.machine.cpus} × ${report.machine.model}, Node ${report.machine.node}, ` +
      `load average ${report.machine.load.start.toFixed(1)} at the start and ${report.machine.load.end.toFixed(1)} at the end. ` +
      'Server ms is the request in process (`inject`), db ms Server-Timing’s `db`; ' +
      'statements and rows are the median run’s, with the range when runs differed; KB decompressed, and as sent with `br`.',
    '',
  ];
  for (const [title, steps] of groupByArea(report.steps)) {
    lines.push(
      `## ${title}`,
      '',
      '| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |',
      '| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |',
    );
    for (const step of steps) {
      lines.push(
        `| ${cell(step.name)} | \`${cell(step.target)}\` | ${step.status ?? ''} | ${ms(step.serverMs.p50)} | ${ms(step.serverMs.p95)} | ${step.dbMs ? ms(step.dbMs.p50) : ''} | ${count(step.statements)} | ${count(step.rows)} | ${count(step.bytes, kb)} | ${count(step.wireBytes, kb)} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Not walked', '');
  lines.push(
    report.unwalked.length === 0
      ? 'Every route template and MCP tool was reached.'
      : report.unwalked.map((route) => `- \`${route}\``).join('\n'),
  );
  lines.push('');
  return lines.join('\n');
}

interface Change {
  before: number;
  after: number;
}

export interface StepDelta {
  id: string;
  issue: number;
  area: string;
  name: string;
  target: string;
  presence: 'both' | 'new' | 'gone';
  p50: Change | null;
  /** Past TIME_NOISE (or the given threshold) in either direction. */
  timeChanged: boolean;
  statements: Change | null;
  rows: Change | null;
  bytes: Change | null;
  /** SQL the step sends now and did not (and the reverse), texts, once each. */
  addedSql: string[];
  removedSql: string[];
}

/** `after` minus `before` as multisets of keys: what `after` has more of. */
function extraKeys(after: readonly string[], before: readonly string[]) {
  const left = new Map<string, number>();
  for (const key of before) left.set(key, (left.get(key) ?? 0) + 1);
  const extra: string[] = [];
  for (const key of after) {
    const remaining = left.get(key) ?? 0;
    if (remaining > 0) left.set(key, remaining - 1);
    else extra.push(key);
  }
  return [...new Set(extra)];
}

const change = (before: number, after: number): Change | null =>
  before === after ? null : { before, after };

/**
 * Every step of either report, matched by id, with what moved. Counts and
 * bytes are exact (the walk is deterministic for a seed day), so any change
 * is reported; time only past the noise threshold.
 */
export function compareReports(
  before: AuditReport,
  after: AuditReport,
  threshold = TIME_NOISE,
): StepDelta[] {
  const old = new Map(before.steps.map((step) => [step.id, step]));
  const current = new Map(after.steps.map((step) => [step.id, step]));
  const deltas: StepDelta[] = [];
  for (const step of after.steps) {
    const was = old.get(step.id);
    if (!was) {
      deltas.push({
        ...identity(step),
        presence: 'new',
        p50: null,
        timeChanged: false,
        statements: null,
        rows: null,
        bytes: null,
        addedSql: [],
        removedSql: [],
      });
      continue;
    }
    const p50 = { before: was.serverMs.p50, after: step.serverMs.p50 };
    const moved = Math.abs(p50.after - p50.before);
    deltas.push({
      ...identity(step),
      presence: 'both',
      p50,
      timeChanged:
        moved > threshold.absoluteMs && moved > threshold.relative * p50.before,
      statements: change(was.statements.median, step.statements.median),
      rows: change(was.rows.median, step.rows.median),
      bytes: change(was.bytes.median, step.bytes.median),
      addedSql: extraKeys(step.sql, was.sql).map((key) => after.sql[key]),
      removedSql: extraKeys(was.sql, step.sql).map((key) => before.sql[key]),
    });
  }
  for (const step of before.steps) {
    if (current.has(step.id)) continue;
    deltas.push({
      ...identity(step),
      presence: 'gone',
      p50: null,
      timeChanged: false,
      statements: null,
      rows: null,
      bytes: null,
      addedSql: [],
      removedSql: [],
    });
  }
  return deltas;
}

function identity(step: StepResult) {
  const { id, issue, area, name, target } = step;
  return { id, issue, area, name, target };
}

/** A delta worth a line: anything but time inside the noise. */
export function isChanged(delta: StepDelta): boolean {
  return (
    delta.presence !== 'both' ||
    delta.timeChanged ||
    countsChanged(delta) ||
    sqlChanged(delta)
  );
}

function countsChanged(delta: StepDelta): boolean {
  return [delta.statements, delta.rows, delta.bytes].some((c) => c !== null);
}

function sqlChanged(delta: StepDelta): boolean {
  return delta.addedSql.length + delta.removedSql.length > 0;
}

function signed(value: number, format: (n: number) => string): string {
  return `${value > 0 ? '+' : ''}${format(value)}`;
}

function countCell(value: Change | null, format: (n: number) => string) {
  return value
    ? `${format(value.before)} → ${format(value.after)} (${signed(value.after - value.before, format)})`
    : '';
}

function timeCell(delta: StepDelta): string {
  if (!delta.p50) return delta.presence;
  const { before, after } = delta.p50;
  const percent = Math.round(relativeChange(before, after) * 100);
  const text = `${ms(before)} → ${ms(after)} (${signed(percent, String)}%)`;
  return delta.timeChanged ? `**${text}**` : text;
}

const SQL_SHOWN = 160;

function shortSql(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SQL_SHOWN ? `${flat.slice(0, SQL_SHOWN)}…` : flat;
}

/**
 * The diff as markdown: a table of the steps that changed, the statements
 * each gained or lost, and how far the two runs' times disagree overall
 * (run it twice on one build and that line is the box's noise).
 */
export function renderComparison(
  before: AuditReport,
  after: AuditReport,
  deltas: readonly StepDelta[],
  threshold = TIME_NOISE,
): string {
  const both = deltas.filter((delta) => delta.p50 !== null);
  const noise = noiseBetween(both.map((delta) => delta.p50!));
  const changed = deltas.filter(isChanged);
  const faster = both.filter(
    (delta) => delta.timeChanged && delta.p50!.after < delta.p50!.before,
  ).length;
  const slower = both.filter(
    (delta) => delta.timeChanged && delta.p50!.after > delta.p50!.before,
  ).length;
  const lines = [
    '# Page audit: comparison',
    '',
    `Before \`${before.commit}\` (${before.createdAt}), after \`${after.commit}\` (${after.createdAt}).`,
    '',
    `Across ${noise.steps} steps the p50s differ by ${(noise.median * 100).toFixed(1)}% at the median and ` +
      `${(noise.p90 * 100).toFixed(1)}% at the 90th percentile. A time counts as changed past ` +
      `${threshold.relative * 100}% and ${threshold.absoluteMs} ms (bold): ${faster} faster, ${slower} slower.`,
    '',
  ];
  if (changed.length === 0) {
    lines.push('Nothing changed beyond the noise.', '');
    return lines.join('\n');
  }
  lines.push(
    '| Step | Target | p50 ms | Statements | Rows | KB |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const delta of changed) {
    lines.push(
      `| #${delta.issue} ${cell(delta.name)} | \`${cell(delta.target)}\` | ${timeCell(delta)} | ${countCell(delta.statements, String)} | ${countCell(delta.rows, String)} | ${countCell(delta.bytes, kb)} |`,
    );
  }
  const withSql = changed.filter(
    (delta) => delta.addedSql.length > 0 || delta.removedSql.length > 0,
  );
  if (withSql.length > 0) {
    lines.push('', '## Statements', '');
    for (const delta of withSql) {
      lines.push(`### #${delta.issue} ${delta.name}`, '');
      for (const text of delta.addedSql) {
        lines.push(`- added: \`${shortSql(text)}\``);
      }
      for (const text of delta.removedSql) {
        lines.push(`- removed: \`${shortSql(text)}\``);
      }
      lines.push('');
    }
  }
  lines.push('');
  return lines.join('\n');
}
