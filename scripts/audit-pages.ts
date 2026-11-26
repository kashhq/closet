import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import sharp from 'sharp';
import { type A11yPass, auditAccessibility, browserVisits } from './audit/a11y';
import { a11yPageNotes, compareA11y } from './audit/a11y-report';
import { Budgets } from './audit/budget';
import {
  AUDIT_PERSONAS,
  type AuditPersona,
  createFixture,
  type Fixture,
} from './audit/fixture';
import {
  type AuditReport,
  compareReports,
  parseReport,
  refuseOnlyWithOut,
  renderComparison,
  renderReport,
  REPORT_VERSION,
  type StepResult,
} from './audit/report';
import { AUDIT_PHASES } from './audit/steps';
import {
  assertUniqueIds,
  type Explained,
  explainSlowest,
  measurePhase,
  type Outcome,
  type Phase,
  type Step,
} from './audit/walk';

/**
 * `npm run audit:pages` (#157): every page, fragment, action, MCP tool and
 * job the page audits (#158-#174) name, measured as the demo persona on the
 * production build: server time p50/p95 over repeated runs after warm-up,
 * SQL statements and rows per request, response bytes; first, every page in
 * Chromium at 390 px for axe, field font and target size (audit/a11y.ts,
 * #722). Writes a markdown table and a JSON report a later run diffs
 * against (`--compare`, which fails on more accessibility violations).
 * docs/perf/README.md is the guide; the committed baseline lives there too.
 *
 *   --runs N            timed runs per step (default 20)
 *   --warmup N          untimed runs first (default 3)
 *   --out PREFIX        writes PREFIX.md and PREFIX.json (default scripts/results/audit);
 *                       the app's log goes to scripts/results/<name>.app.log
 *   --persona NAME      demo (default: 83 garments) or scale (500 garments, 3 years; src/seed/scale.ts)
 *   --only TEXT         only steps whose issue (#159), name or target contains TEXT
 *   --compare FILE      diff this run against a report (PREFIX.compare.md, and stdout)
 *   --explain           EXPLAIN (ANALYZE, BUFFERS) each step's slowest statements (PREFIX.explain.md)
 *
 * SQL is recorded by wrapping node-postgres in this process
 * (test/support/query-recorder.ts); nothing is added to the app.
 */

const PROJECT_ROOT = resolve(__dirname, '..');
/** Gitignored: the default output, and every run's app log. */
const RESULTS = join(PROJECT_ROOT, 'scripts', 'results');

const DEFAULT_OUT = 'scripts/results/audit';
const OPTIONS = {
  runs: { type: 'string', default: '20' },
  warmup: { type: 'string', default: '3' },
  out: { type: 'string' },
  persona: { type: 'string', default: 'demo' },
  only: { type: 'string' },
  compare: { type: 'string' },
  explain: { type: 'boolean', default: false },
} as const;

function count(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be a whole number of at least ${minimum}`);
  }
  return parsed;
}

function auditPersona(value: string): AuditPersona {
  const persona = AUDIT_PERSONAS.find((name) => name === value);
  if (!persona) {
    throw new Error(`--persona must be one of ${AUDIT_PERSONAS.join(', ')}`);
  }
  return persona;
}

/** The report to compare against: a run of the same persona, or a refusal. */
async function readBaseline(
  file: string,
  persona: AuditPersona,
): Promise<AuditReport> {
  const baseline = parseReport(
    await readFile(resolve(PROJECT_ROOT, file), 'utf8'),
    file,
  );
  if (baseline.persona !== persona) {
    throw new Error(
      `${file} is the ${baseline.persona} persona's run; this is ${persona}'s`,
    );
  }
  return baseline;
}

function selected(step: Step, only: string | undefined): boolean {
  if (!only) return true;
  const needle = only.toLowerCase();
  return [`#${step.issue}`, step.name, step.target].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/** A 1200x800 JPEG, the photo every upload step posts and the shop serves. */
function testPhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#4a6' },
  })
    .jpeg()
    .toBuffer();
}

async function explainConnection(fixture: Fixture): Promise<Client> {
  const client = new Client(
    fixture.build.db.connectionOptions(
      fixture.build.db.dbConfig(fixture.config),
    ),
  );
  await client.connect();
  return client;
}

function renderExplained(
  explained: { result: StepResult; plans: Explained[] }[],
): string {
  const lines = ['# Page audit: slowest statements', ''];
  for (const { result, plans } of explained) {
    if (plans.length === 0) continue;
    lines.push(`## #${result.issue} ${result.name} (\`${result.target}\`)`, '');
    for (const plan of plans) {
      lines.push(
        `${plan.ms.toFixed(1)} ms:`,
        '',
        '```sql',
        plan.sql,
        '```',
        '',
        '```',
        plan.plan,
        '```',
        '',
      );
    }
  }
  return lines.join('\n');
}

interface Walked {
  results: StepResult[];
  sql: Record<string, string>;
  explained: { result: StepResult; plans: Explained[] }[];
  failures: string[];
  /** Spent waiting for the app's rate limits (budget.ts). */
  waitedMs: number;
}

/** Each phase in turn; a failing step is reported and the walk goes on. */
async function walk(
  fixture: Fixture,
  phases: readonly Phase[],
  options: { runs: number; warmup: number; explain: boolean },
  interrupted: AbortSignal,
): Promise<Walked> {
  const walked: Walked = {
    results: [],
    sql: {},
    explained: [],
    failures: [],
    waitedMs: 0,
  };
  // One for the whole walk: a budget's calls carry over from phase to phase.
  const budgets = new Budgets({
    now: () => performance.now(),
    sleep: (ms) => sleep(ms),
    onWait: (limit, ms) => {
      console.log(
        `  waiting ${(ms / 1000).toFixed(1)} s for the ${limit.key} budget (${limit.max} per ${limit.windowMs / 1000} s)`,
      );
    },
  });
  const explainClient = options.explain
    ? await explainConnection(fixture)
    : undefined;
  try {
    for (const phase of phases) {
      if (interrupted.aborted) break;
      console.log(
        `${phase.name}: ${phase.steps.length} steps${phase.interleave ? ', in rounds' : ''}`,
      );
      const outcomes = await measurePhase(phase, {
        fixture,
        defaults: options,
        sqlTexts: walked.sql,
        budgets,
        interrupted,
      });
      for (const outcome of outcomes) {
        await record(outcome, explainClient, walked);
      }
    }
  } finally {
    await explainClient?.end();
    walked.waitedMs = budgets.waitedMs;
  }
  return walked;
}

async function record(
  outcome: Outcome,
  explainClient: Client | undefined,
  walked: Walked,
): Promise<void> {
  const { step } = outcome;
  const label = `#${step.issue} ${step.name} (${step.target})`;
  if ('error' in outcome) {
    walked.failures.push(`${label}: ${outcome.error.message}`);
    console.error(`${label}: FAILED ${outcome.error.message}`);
    return;
  }
  const { result, last } = outcome.measured;
  walked.results.push(result);
  console.log(
    `${label}: p50 ${result.serverMs.p50.toFixed(1)} ms, ${result.statements.median} statements`,
  );
  if (explainClient) {
    walked.explained.push({
      result,
      plans: await explainSlowest(explainClient, last),
    });
  }
}

/** Route templates and MCP tools no step reached. */
async function notWalked(
  fixture: Fixture,
  steps: readonly Step[],
): Promise<string[]> {
  const reached = new Set(steps.flatMap((step) => [step.route, step.target]));
  const tools = (await fixture.mcpTools()).map((tool) => `mcp ${tool}`);
  return [...fixture.closet.metrics.routes(), ...tools].filter(
    (target) => !reached.has(target),
  );
}

/** PREFIX.md and .json, and .explain.md and .compare.md when asked; their paths. */
async function writeOutputs(
  out: string,
  report: AuditReport,
  walked: Walked,
  options: { explain: boolean; baseline: AuditReport | undefined },
): Promise<string[]> {
  await writeFile(`${out}.json`, `${JSON.stringify(report, null, 1)}\n`);
  await writeFile(`${out}.md`, renderReport(report));
  const written = [`${out}.md`, `${out}.json`];
  if (options.explain) {
    await writeFile(`${out}.explain.md`, renderExplained(walked.explained));
    written.push(`${out}.explain.md`);
  }
  if (options.baseline) {
    const comparison = renderComparison(
      options.baseline,
      report,
      compareReports(options.baseline, report),
    );
    await writeFile(`${out}.compare.md`, comparison);
    written.push(`${out}.compare.md`);
    console.log(`\n${comparison}`);
  }
  return written;
}

/** No default in OPTIONS: only an explicit --out can overwrite a baseline. */
function outPrefix(only: string | undefined, out: string | undefined): string {
  refuseOnlyWithOut(only, out);
  return resolve(PROJECT_ROOT, out ?? DEFAULT_OUT);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: OPTIONS, strict: true });
  const runs = count(values.runs, 'runs', 1);
  const warmup = count(values.warmup, 'warmup', 0);
  const persona = auditPersona(values.persona);
  const out = outPrefix(values.only, values.out);
  const baseline = values.compare
    ? await readBaseline(values.compare, persona)
    : undefined;
  assertUniqueIds(AUDIT_PHASES.flatMap((phase) => phase.steps));
  const phases = AUDIT_PHASES.map((phase) => ({
    ...phase,
    steps: phase.steps.filter((step) => selected(step, values.only)),
  })).filter((phase) => phase.steps.length > 0);
  if (phases.length === 0) throw new Error(`No step matches "${values.only}"`);

  console.log(
    `Booting dist/ on a scratch database and seeding Theo (${persona})...`,
  );
  const bootStarted = performance.now();
  await mkdir(dirname(out), { recursive: true });
  // Beside the other runs' output, never in docs/perf/ with a baseline.
  await mkdir(RESULTS, { recursive: true });
  const appLog = join(RESULTS, `${basename(out)}.app.log`);
  // Every offending node of the accessibility pass, beside the log.
  const a11yNodes = join(RESULTS, `${basename(out)}.a11y-nodes.json`);
  const fixture = await createFixture({
    persona,
    photo: await testPhoto(),
    appLog,
  });
  console.log(
    `Ready in ${((performance.now() - bootStarted) / 1000).toFixed(1)} s (data in ${fixture.dataPath}).`,
  );
  // Ctrl-C mid-walk still drops the scratch database (a kill does not; the
  // integration tier's sweep drops those after an hour).
  const interrupted = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.error(`${signal}: dropping the scratch database`);
      interrupted.abort();
      void fixture.close().finally(() => process.exit(130));
    });
  }
  const walkStarted = performance.now();
  const [loadAtStart] = loadavg();
  let walked: Walked;
  let unwalked: string[];
  let a11y: A11yPass;
  try {
    // Before the walk: the pass is read-only (a11y.ts), so the steps still
    // start on the seed as it was.
    a11y = await auditAccessibility(
      fixture,
      browserVisits(
        fixture,
        phases.flatMap((phase) => phase.steps),
      ),
      a11yNodes,
    );
    walked = await walk(
      fixture,
      phases,
      { runs, warmup, explain: values.explain },
      interrupted.signal,
    );
    unwalked = values.only
      ? []
      : await notWalked(
          fixture,
          phases.flatMap((phase) => phase.steps),
        );
  } finally {
    await fixture.close();
  }
  const cpu = cpus();
  const report: AuditReport = {
    version: REPORT_VERSION,
    createdAt: new Date().toISOString(),
    commit: fixture.build.buildInfo.loadBuildInfo(undefined).release,
    persona,
    machine: {
      cpus: cpu.length,
      model: cpu[0]?.model.trim() ?? 'unknown',
      node: process.version,
      load: { start: loadAtStart, end: loadavg()[0] },
    },
    runs,
    warmup,
    steps: walked.results,
    sql: walked.sql,
    unwalked,
    a11y: values.only ? { ...a11y.report, partial: true } : a11y.report,
  };
  const written = await writeOutputs(out, report, walked, {
    explain: values.explain,
    baseline,
  });
  console.log(
    `\n${walked.results.length} steps in ${((performance.now() - walkStarted) / 1000).toFixed(0)} s; ` +
      `${(walked.waitedMs / 1000).toFixed(0)} s of it waiting for rate limits; ` +
      `${unwalked.length} route(s) or tool(s) not walked${unwalked.length ? `: ${unwalked.join(', ')}` : ''}.`,
  );
  console.log(
    `Wrote ${written.map((path) => relative(process.cwd(), path)).join(', ')}`,
  );
  refuseFailures([...a11y.failures, ...walked.failures], appLog);
  if (baseline) refuseNewA11yKinds(baseline, report, a11yNodes);
}

function refuseFailures(failures: readonly string[], appLog: string): void {
  if (failures.length === 0) return;
  throw new Error(
    `${failures.length} step(s) failed:\n${failures.join('\n')}\nThe app's log: ${relative(process.cwd(), appLog)}`,
  );
}

/** The one gate in the compare, on kinds; count rises print as WORSE (docs/perf/README.md). */
function refuseNewA11yKinds(
  baseline: AuditReport,
  report: AuditReport,
  nodesFile: string,
): void {
  // A baseline from before #722 has no pass to compare with.
  if (!baseline.a11y || !report.a11y) return;
  const comparison = compareA11y(baseline.a11y, report.a11y);
  const { newKinds, increases } = comparison;
  const notes = a11yPageNotes(comparison);
  if (notes.length > 0) console.log(`\nAccessibility:\n${notes.join('\n')}`);
  for (const increase of increases) {
    console.log(
      `WORSE accessibility nodes: ${increase.measure} on #${increase.id} (${increase.target}): ${increase.before} → ${increase.after}`,
    );
  }
  if (newKinds.length === 0) return;
  throw new Error(
    `${newKinds.length} accessibility violation kind(s) the baseline lacks:\n` +
      newKinds
        .map(
          (item) =>
            `  ${item.measure} on #${item.id} (${item.target}): ${item.kind}`,
        )
        .join('\n') +
      `\nEach node: ${relative(process.cwd(), nodesFile)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
