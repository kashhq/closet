import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Client } from 'pg';
import {
  type RecordedStatement,
  recordStatements,
} from '../../test/support/query-recorder';
import type { AuditLimit, Budgets } from './budget';
import type { AuditRequest, Fixture } from './fixture';
import { type StepKind, type StepResult, sqlKey } from './report';
import { summarizeCount, summarizeTiming } from './stats';

/**
 * How the page audit measures one step (scripts/audit-pages.ts): its
 * setup (unmeasured), then the request or job with every SQL statement
 * recorded, repeated after warm-up. The steps themselves are steps.ts.
 */

/** One measured run. */
interface Sample {
  ms: number;
  dbMs: number | null;
  status: number | null;
  statements: RecordedStatement[];
  bytes: number;
  wireBytes: number;
}

export interface Step {
  issue: number;
  area: string;
  name: string;
  kind: StepKind;
  /** What the report names: `GET /wardrobe/:id`, `mcp <tool>`, `job <name>`. */
  target: string;
  /** The route template an HTTP step reaches, for the coverage check. */
  route?: string;
  /**
   * Timed runs, when fewer than the walk's: a costly step, or one whose
   * budget would make the walk wait for every few runs. Never sized to
   * dodge a rate limit; that is `limits`.
   */
  runs?: number;
  warmup?: number;
  /**
   * Every app rate limit a run spends (budget.ts, from the constants in
   * src/web/security/rate-limit.ts). The walk waits for room in each before
   * every run, warm-up included, so steps sharing a budget never meet a
   * 429. A step that hits a limited route or tool must declare it.
   */
  limits?: readonly AuditLimit[];
  measure: (fixture: Fixture) => Promise<Sample>;
}

interface StepBase<P> {
  issue: number;
  area: string;
  name: string;
  runs?: number;
  warmup?: number;
  limits?: readonly AuditLimit[];
  /** Per run, unmeasured: what the request needs (a row to delete, a new account). */
  prepare?: (fixture: Fixture) => Promise<P>;
}

export interface HttpStep<P> extends StepBase<P> {
  kind: Exclude<StepKind, 'job'>;
  /** The route template the request must reach, as `METHOD /template`. */
  route: string;
  /** The report's name for it when not the route (`mcp search_garments`). */
  target?: string;
  request: (fixture: Fixture, prepared: P) => AuditRequest;
  /** The status every run must answer. */
  expect: number;
  /** A refusal a 2xx can carry (an MCP tool's error): its message, else undefined. */
  check?: (body: string) => string | undefined;
}

export interface JobStep<P> extends StepBase<P> {
  kind: 'job';
  /** `job <name>`. */
  target: string;
  run: (fixture: Fixture, prepared: P) => Promise<void>;
}

/** Server-Timing's `route` description and `db` duration. */
function serverTiming(header: unknown): { route?: string; db?: number } {
  if (typeof header !== 'string') return {};
  return {
    route: /route;desc="([^"]*)"/.exec(header)?.[1],
    db: Number(/db;dur=([\d.]+)/.exec(header)?.[1] ?? NaN),
  };
}

function decoded(raw: Buffer, encoding: unknown): Buffer {
  if (encoding === 'br') return brotliDecompressSync(raw);
  if (encoding === 'gzip') return gunzipSync(raw);
  return raw;
}

/** A step's id in the report, what a later run's diff matches it by. */
function stepId(step: Pick<Step, 'issue' | 'name'>): string {
  return `${step.issue} ${step.name}`;
}

/** Refuses two steps with one id: the diff would compare one with the other. */
export function assertUniqueIds(steps: readonly Step[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    const id = stepId(step);
    if (seen.has(id)) throw new Error(`Two steps are named "#${id}"`);
    seen.add(id);
  }
}

/** The part of `METHOD /template` a route answers to. */
function routeTemplate(target: string): string {
  return target.slice(target.indexOf(' ') + 1);
}

export function http<P = undefined>(step: HttpStep<P>): Step {
  const template = routeTemplate(step.route);
  return {
    ...step,
    target: step.target ?? step.route,
    route: template,
    async measure(fixture) {
      // eslint-disable-next-line closet/no-forged-copy -- an unconstrained P, never user-facing copy
      const prepared = (await step.prepare?.(fixture)) as P;
      const options = fixture.injectOptions(step.request(fixture, prepared));
      const started = performance.now();
      const { result: res, statements } = await recordStatements(() =>
        fixture.app.inject(options),
      );
      const ms = performance.now() - started;
      const body = decoded(res.rawPayload, res.headers['content-encoding']);
      if (res.statusCode !== step.expect) {
        throw new Error(
          `answered ${res.statusCode}, not ${step.expect}: ${body.toString('utf8', 0, 400)}`,
        );
      }
      const refused = step.check?.(body.toString('utf8'));
      if (refused) throw new Error(refused);
      const timing = serverTiming(res.headers['server-timing']);
      if (timing.route !== undefined && timing.route !== template) {
        throw new Error(`reached ${timing.route}, not ${template}`);
      }
      return {
        ms,
        dbMs:
          timing.db !== undefined && !Number.isNaN(timing.db)
            ? timing.db
            : null,
        status: res.statusCode,
        statements,
        bytes: body.length,
        wireBytes: res.rawPayload.length,
      };
    },
  };
}

export function job<P = undefined>(step: JobStep<P>): Step {
  return {
    ...step,
    async measure(fixture) {
      // eslint-disable-next-line closet/no-forged-copy -- an unconstrained P, never user-facing copy
      const prepared = (await step.prepare?.(fixture)) as P;
      const started = performance.now();
      const { statements } = await recordStatements(() =>
        step.run(fixture, prepared),
      );
      return {
        ms: performance.now() - started,
        dbMs: null,
        status: null,
        statements,
        bytes: 0,
        wireBytes: 0,
      };
    },
  };
}

interface Measured {
  result: StepResult;
  /** The last run's statements, for EXPLAIN. */
  last: RecordedStatement[];
}

const SLOWEST_KEPT = 3;

/** A group of steps the walk runs together (steps.ts: reads, writes, tools, jobs). */
export interface Phase {
  name: string;
  /**
   * Round-robin: each round runs every step once, so a step's samples
   * spread over the whole phase and a burst of load elsewhere on the box
   * lands on one sample of many steps rather than on all of one step's.
   * Only for steps without side effects that another step would see.
   */
  interleave: boolean;
  steps: readonly Step[];
}

export type Outcome =
  | { step: Step; measured: Measured }
  | { step: Step; error: Error };

interface Planned {
  step: Step;
  warmup: number;
  runs: number;
  samples: Sample[];
  error?: Error;
}

/** What every phase of one walk shares (scripts/audit-pages.ts builds it once). */
export interface Walk {
  fixture: Fixture;
  defaults: { runs: number; warmup: number };
  /** Every recorded statement's text by its key, filled as steps finish. */
  sqlTexts: Record<string, string>;
  /** The rate limits' spent calls: one tracker for the walk, since a budget spans phases. */
  budgets: Budgets;
  /** Stops the walk between runs. */
  interrupted: AbortSignal;
}

/**
 * Every step of the phase, warm-up runs first, in rounds when the phase
 * interleaves and one step after another when not. A step that fails is
 * dropped from the later rounds.
 */
export async function measurePhase(
  phase: Phase,
  walk: Walk,
): Promise<Outcome[]> {
  const { fixture, defaults, budgets, interrupted } = walk;
  const planned: Planned[] = phase.steps.map((step) => ({
    step,
    warmup: Math.min(step.warmup ?? defaults.warmup, defaults.warmup),
    runs: Math.min(step.runs ?? defaults.runs, defaults.runs),
    samples: [],
  }));
  const runOnce = async (entry: Planned, round: number) => {
    if (entry.error || round >= entry.warmup + entry.runs) return;
    try {
      const sample = await budgets.spend(entry.step.limits ?? [], () =>
        entry.step.measure(fixture),
      );
      if (round >= entry.warmup) entry.samples.push(sample);
    } catch (error) {
      entry.error = error instanceof Error ? error : new Error(String(error));
    }
  };
  const rounds = Math.max(0, ...planned.map((p) => p.warmup + p.runs));
  if (phase.interleave) {
    for (let round = 0; round < rounds && !interrupted.aborted; round++) {
      for (const entry of planned) await runOnce(entry, round);
    }
  } else {
    for (const entry of planned) {
      for (let round = 0; round < rounds && !interrupted.aborted; round++) {
        await runOnce(entry, round);
      }
    }
  }
  return planned.map((entry) => outcome(entry, walk.sqlTexts));
}

/** A planned step's outcome: its error, or no samples when interrupted. */
function outcome(entry: Planned, sqlTexts: Record<string, string>): Outcome {
  if (entry.error) return { step: entry.step, error: entry.error };
  if (entry.samples.length === 0) {
    return { step: entry.step, error: new Error('interrupted') };
  }
  return {
    step: entry.step,
    measured: summarize(entry.step, entry.samples, sqlTexts),
  };
}

/** A step's samples as its row of the report. */
function summarize(
  step: Step,
  samples: readonly Sample[],
  sqlTexts: Record<string, string>,
): Measured {
  const last = samples[samples.length - 1];
  const keys = last.statements.map((statement) => {
    const key = sqlKey(statement.sql);
    sqlTexts[key] = statement.sql;
    return key;
  });
  const dbTimes = samples
    .map((sample) => sample.dbMs)
    .filter((value): value is number => value !== null);
  return {
    last: last.statements,
    result: {
      id: stepId(step),
      issue: step.issue,
      area: step.area,
      name: step.name,
      kind: step.kind,
      target: step.target,
      status: last.status,
      serverMs: summarizeTiming(samples.map((sample) => sample.ms)),
      dbMs: dbTimes.length === samples.length ? summarizeTiming(dbTimes) : null,
      statements: summarizeCount(
        samples.map((sample) => sample.statements.length),
      ),
      rows: summarizeCount(
        samples.map((sample) =>
          sample.statements.reduce((sum, s) => sum + s.rows, 0),
        ),
      ),
      bytes: summarizeCount(samples.map((sample) => sample.bytes)),
      wireBytes: summarizeCount(samples.map((sample) => sample.wireBytes)),
      sql: keys,
      slowest: [...last.statements]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, SLOWEST_KEPT)
        .map((statement) => ({ sql: sqlKey(statement.sql), ms: statement.ms })),
    },
  };
}

const EXPLAINABLE = /^\s*(select|with|insert|update|delete)\b/i;

export interface Explained {
  sql: string;
  ms: number;
  plan: string;
}

/**
 * EXPLAIN (ANALYZE, BUFFERS) of a step's slowest statements, each in a
 * transaction rolled back, so a write's plan is measured and undone. On
 * the audit's own connection, after the step: nothing here is recorded.
 */
export async function explainSlowest(
  client: Client,
  statements: readonly RecordedStatement[],
): Promise<Explained[]> {
  const slowest = [...statements]
    .filter((statement) => EXPLAINABLE.test(statement.sql))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, SLOWEST_KEPT);
  const explained: Explained[] = [];
  for (const statement of slowest) {
    await client.query('begin');
    try {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `explain (analyze, buffers) ${statement.sql}`,
        [...statement.values],
      );
      explained.push({
        sql: statement.sql,
        ms: statement.ms,
        plan: rows.map((row) => row['QUERY PLAN']).join('\n'),
      });
    } catch (error) {
      explained.push({
        sql: statement.sql,
        ms: statement.ms,
        plan: `(not explained: ${error instanceof Error ? error.message : String(error)})`,
      });
    } finally {
      await client.query('rollback');
    }
  }
  return explained;
}
