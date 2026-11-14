import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';
import type { Logger } from '../logger';
import type { ErrorContext, ErrorTracker } from './error-tracker';
import { JobInterrupted, PartialFailure } from './partial-failure';

/**
 * The process's Prometheus metrics (#115), read by the homelab's vmagent
 * from GET /metrics (src/web/metrics/routes.ts), through
 * @prometheus-io/client (prom-client's successor, #136). One registry per
 * app, never the library's global one, so the integration specs' apps never
 * share a series.
 *
 * The contract with the homelab (observability.md's standard metrics; its
 * Grafana dashboards and rules read these names):
 * `http_request_duration_seconds{route,method,status_class}`,
 * `http_request_db_statements{route}`, `job_duration_seconds{name,outcome}`
 * and `app_info{version}`. No metric carries a `job` label: the
 * scraper sets it. Every label value comes from a closed set (a route
 * template, a job name below, a tool name, an outcome), never from a
 * request: no ids, no URLs, no user.
 *
 * Recording always happens (it is a few additions per request); only the
 * route that exposes them, the device beacon and the process's default
 * metrics are gated by METRICS_ENABLED.
 *
 * A failure outcome carries its error (the `*Ending` types below), which is
 * handed to the error tracker (#117, src/metrics/error-tracker.ts): the
 * places that record a job's, a push's or a tool's failure are the one
 * place each of those reaches Bugsink.
 */

/**
 * The scheduled work timed into job_duration_seconds: the timers server.ts
 * starts, and each background-removal run of the cutout queue.
 */
export type JobName =
  | 'reconciliation'
  | 'cutout'
  | 'cutout_retry'
  | 'reminders'
  | 'reminder_prune'
  | 'replan'
  | 'replan_prune'
  | 'order_mail'
  | 'muse_rounds'
  | 'sync_prune'
  | 'weather_prune';

/**
 * A job's ending, closed. `success` and `failure` are the homelab contract
 * (observability.md; homelab stacks/homeinfra/vmalert/rules/apps.yml): the
 * JobFailed alert and the RED dashboard select `outcome="failure"`, so any
 * error, timeout or crash of a job is `failure`, never a new word. A cutout
 * run may also end `discarded` or `interrupted` (src/cutout/queue.ts), which
 * the convention allows as non-alerting (owner decision C, 2026-10-13).
 * metrics.spec.ts holds this list.
 */
export const JOB_OUTCOMES = [
  'success',
  'failure',
  'discarded',
  'interrupted',
] as const;
type JobOutcome = (typeof JOB_OUTCOMES)[number];

type PushOutcome = 'delivered' | 'pruned' | 'failed';

type McpOutcome = 'ok' | 'refused' | 'error';

/**
 * How /file/** found the files it served (src/web/files/routes.ts): `none`,
 * from the URL's signature alone; `row`, by asking the database (an
 * unsigned or stale URL, a file the URL names that is gone).
 */
export type PhotoLookup = 'none' | 'row';

/**
 * How a job, a push send or a tool call ended: its outcome, and for the
 * failure outcome the error, which the metrics hand to the error tracker.
 * A failure without its error does not type-check.
 */
type Ending<Outcome extends string, Failure extends Outcome> =
  | { outcome: Exclude<Outcome, Failure> }
  | { outcome: Failure; error: unknown };

export type JobEnding = Ending<JobOutcome, 'failure'>;
export type PushEnding = Ending<PushOutcome, 'failed'>;
export type McpEnding = Ending<McpOutcome, 'error'>;

/** Where a device's timing came from (public/js/vitals.js). */
export const CLIENT_TIMING_KINDS = ['full', 'htmx', 'restore'] as const;
type ClientTimingKind = (typeof CLIENT_TIMING_KINDS)[number];

/**
 * What a device measures, in milliseconds. `ttfb` and `lcp` are a full
 * load's; `request` (sent to answered) and `settle` (answered to swapped
 * and settled) an htmx request's; `settle` alone a history restore's; `inp`
 * the slowest interaction while a page was on screen.
 */
const CLIENT_TIMING_METRICS = [
  'ttfb',
  'lcp',
  'inp',
  'request',
  'settle',
] as const;
type ClientTimingMetric = (typeof CLIENT_TIMING_METRICS)[number];

export interface ClientTimingSample {
  /** A route template the device read from Server-Timing (`/wardrobe/:id`). */
  route: string;
  kind: ClientTimingKind;
  /** Answered from the service worker's page cache. */
  cache: boolean;
  ms: Partial<Record<ClientTimingMetric, number>>;
}

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// Statements per request: a page is one to a handful, a write a transaction
// of a few more; past 50 is a loop sending one per row.
const STATEMENT_BUCKETS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55];
const JOB_BUCKETS = [0.01, 0.05, 0.25, 1, 2.5, 5, 10, 30, 60, 120, 300];
// A phone on the tailnet: from a cached swap (tens of ms) to a cold load
// over a poor connection (seconds).
const CLIENT_BUCKETS = [
  0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 3, 5, 8, 13,
];

/** What trackCutoutQueue counts (countPendingCutouts, src/cutout/queries.ts). */
export interface PendingCutouts {
  depth: number;
  /** The oldest pending photo's request time; null with none pending (or none dated). */
  oldestRequestedAt: Date | null;
}

export interface MetricsOptions {
  /** METRICS_ENABLED: adds the process's default metrics (CPU, memory, event loop). */
  enabled: boolean;
  /** The build's release (BuildInfo.release, the bare 7-char sha): app_info's `version`. */
  version: string;
  logger: Logger;
  /** Where failures go (DISABLED_ERROR_TRACKER without SENTRY_DSN). */
  errors: ErrorTracker;
}

export class Metrics {
  readonly registry = new Registry();
  readonly enabled: boolean;

  private readonly httpDuration: Histogram<'route' | 'method' | 'status_class'>;
  private readonly httpStatements: Histogram<'route'>;
  private readonly jobDuration: Histogram<'name' | 'outcome'>;
  private readonly pushSends: Counter<'outcome'>;
  private readonly mcpCalls: Histogram<'tool' | 'outcome'>;
  private readonly clientTiming: Histogram<
    'route' | 'kind' | 'metric' | 'cache'
  >;
  private readonly clientDropped: Counter<'reason'>;
  private readonly photoRequests: Counter<'lookup'>;
  // Every route the app registered (registerHttpMetrics' onRoute hook): the
  // only values a device may name as its route.
  private readonly routeTemplates = new Set<string>();
  private readonly logger: Logger;
  private readonly errors: ErrorTracker;

  constructor({ enabled, version, logger, errors }: MetricsOptions) {
    this.enabled = enabled;
    this.logger = logger;
    this.errors = errors;
    const registers = [this.registry];
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Time from request to response, by route template, method and status class.',
      labelNames: ['route', 'method', 'status_class'],
      buckets: HTTP_BUCKETS,
      registers,
    });
    this.httpStatements = new Histogram({
      name: 'http_request_db_statements',
      help: 'SQL statements a request sent (transaction control included), by route template.',
      labelNames: ['route'],
      buckets: STATEMENT_BUCKETS,
      registers,
    });
    // Always 1: the series exists to carry the running build's version, so
    // a dashboard or alert can tell which release a number came from.
    new Gauge({
      name: 'app_info',
      help: 'The running build: version is its APP_VERSION (the 7-char git sha). Always 1.',
      labelNames: ['version'],
      registers,
    }).set({ version }, 1);
    this.jobDuration = new Histogram({
      name: 'job_duration_seconds',
      help: 'Scheduled and background jobs: run time by job name and outcome.',
      labelNames: ['name', 'outcome'],
      buckets: JOB_BUCKETS,
      registers,
    });
    this.pushSends = new Counter({
      name: 'push_sends_total',
      help: 'Web Push sends, one per device, by outcome.',
      labelNames: ['outcome'],
      registers,
    });
    this.mcpCalls = new Histogram({
      name: 'mcp_tool_call_duration_seconds',
      help: 'MCP tool calls by tool and outcome.',
      labelNames: ['tool', 'outcome'],
      buckets: HTTP_BUCKETS,
      registers,
    });
    this.clientTiming = new Histogram({
      name: 'client_timing_seconds',
      help: "Devices' own timings (public/js/vitals.js) by route template, navigation kind, metric and service-worker cache hit.",
      labelNames: ['route', 'kind', 'metric', 'cache'],
      buckets: CLIENT_BUCKETS,
      registers,
    });
    this.clientDropped = new Counter({
      name: 'client_timing_dropped_total',
      help: 'Device timing samples dropped, by reason.',
      labelNames: ['reason'],
      registers,
    });
    this.photoRequests = new Counter({
      name: 'photo_requests_total',
      help: 'Photos served by /file/**, by how the files were found: none (a signed URL) or row (a database lookup).',
      labelNames: ['lookup'],
      registers,
    });
    if (enabled) collectDefaultMetrics({ register: this.registry });
  }

  /** Called for every route as it is registered (registerHttpMetrics). */
  addRoute(template: string): void {
    this.routeTemplates.add(template);
  }

  /** A route template of this app: the only route a device may name. */
  hasRoute(template: string): boolean {
    return this.routeTemplates.has(template);
  }

  /** Every route template, sorted: the page audit's coverage check (scripts/audit/). */
  routes(): string[] {
    return [...this.routeTemplates].sort();
  }

  /** One answered request: its time, and the SQL statements it sent. */
  observeRequest(
    route: string,
    method: string,
    status: number,
    seconds: number,
    statements: number,
  ): void {
    this.httpDuration.observe(
      { route, method, status_class: `${Math.floor(status / 100)}xx` },
      seconds,
    );
    this.httpStatements.observe({ route }, statements);
  }

  observeJob(name: JobName, ending: JobEnding, seconds: number): void {
    this.jobDuration.observe({ name, outcome: ending.outcome }, seconds);
    // A PartialFailure whose causes an earlier run captured is counted, not
    // captured again (PartialFailure.reported).
    const reported =
      'error' in ending &&
      ending.error instanceof PartialFailure &&
      ending.error.reported;
    if (!reported) this.capture(ending, { source: 'job', tags: { job: name } });
  }

  /**
   * A scheduled job's `run`, timed under `name` (server.ts wraps every timer
   * it starts): `success`, or `failure` when it throws (captured, and
   * rethrown for the scheduler to log); a JobInterrupted is `interrupted`,
   * rethrown too but never captured.
   */
  timeJob<A extends unknown[], T>(
    name: JobName,
    run: (...args: A) => Promise<T>,
  ): (...args: A) => Promise<T> {
    return async (...args) => {
      const started = performance.now();
      const seconds = () => (performance.now() - started) / 1000;
      let result: T;
      try {
        result = await run(...args);
      } catch (error) {
        const ending: JobEnding =
          error instanceof JobInterrupted
            ? { outcome: 'interrupted' }
            : { outcome: 'failure', error };
        this.observeJob(name, ending, seconds());
        throw error;
      }
      this.observeJob(name, { outcome: 'success' }, seconds());
      return result;
    };
  }

  countPushSend(ending: PushEnding): void {
    this.pushSends.inc({ outcome: ending.outcome });
    this.capture(ending, { source: 'push' });
  }

  countPhotoRequest(lookup: PhotoLookup): void {
    this.photoRequests.inc({ lookup });
  }

  observeMcpCall(tool: string, ending: McpEnding, seconds: number): void {
    this.mcpCalls.observe({ tool, outcome: ending.outcome }, seconds);
    this.capture(ending, { source: 'mcp', tags: { tool } });
  }

  private capture(
    ending: JobEnding | PushEnding | McpEnding,
    context: ErrorContext,
  ): void {
    if ('error' in ending) this.errors.captureException(ending.error, context);
  }

  /**
   * The cutout queue cannot have its model (CutoutQueue, queue-state.ts):
   * called once per outage and failure kind, never per retry, so Bugsink
   * shows one event per kind instead of one every five minutes.
   */
  captureCutoutModelUnavailable(kind: string, error: unknown): void {
    this.errors.captureException(error, {
      source: 'cutout_model',
      tags: { kind },
    });
  }

  /**
   * The background-removal queue's pending photos, counted in the database
   * (any server's writes count): `cutout_queue_depth`, and
   * `cutout_queue_oldest_age_seconds`, how long the oldest has waited (#689:
   * a queue that cannot run its model shows as an age that only grows).
   * Each scrape starts a count and answers with the last one that finished,
   * so the depth is at most one scrape interval old; the age is measured at
   * the scrape from the oldest request time that count read. Only the first
   * scrape waits, for the first count's attempt: if that fails, both stay
   * at 0 until a count succeeds, and no later scrape waits. The scrape
   * never waits on the database otherwise: in production that is a round
   * trip to pgvault on the NAS, which was most of every scrape's time
   * (#174). One count at a time, shared by both gauges: a scrape while one
   * is still out starts none. A failed count is logged and the last value
   * stands.
   */
  trackCutoutQueue(pending: () => Promise<PendingCutouts>): void {
    const logger = this.logger;
    let counting: Promise<void> | undefined;
    let attempted = false;
    let depth = 0;
    let oldest: Date | null = null;
    // Never rejects: past the first scrape nothing awaits it, and an
    // unhandled rejection is a crash (main.ts, createCrashHandler). The
    // reset is a .finally() so it always runs after the assignment, even
    // when `pending` throws synchronously.
    const refresh = async (): Promise<void> => {
      counting ??= (async () => {
        try {
          const counted = await pending();
          if (!Number.isFinite(counted.depth)) {
            throw new Error(`not a count: ${String(counted.depth)}`);
          }
          depth = counted.depth;
          oldest = counted.oldestRequestedAt;
        } catch (error) {
          logger.warn(
            { err: error },
            "Could not read the cutout queue's depth",
          );
        }
        attempted = true;
      })().finally(() => {
        counting = undefined;
      });
      if (!attempted) await counting;
    };
    const registers = [this.registry];
    new Gauge({
      name: 'cutout_queue_depth',
      help: 'Photos waiting for background removal (pending cutouts).',
      registers,
      async collect() {
        await refresh();
        this.set(depth);
      },
    });
    new Gauge({
      name: 'cutout_queue_oldest_age_seconds',
      help: 'How long the oldest pending cutout has waited, in seconds; 0 with none pending.',
      registers,
      async collect() {
        await refresh();
        this.set(
          oldest === null
            ? 0
            : Math.max(0, (Date.now() - oldest.getTime()) / 1000),
        );
      },
    });
  }

  /**
   * Records one device sample. A route the app does not have is dropped
   * (and counted), so a device cannot add a series of its choosing.
   * Returns whether it was recorded.
   */
  observeClientTiming(sample: ClientTimingSample): boolean {
    if (!this.hasRoute(sample.route)) {
      this.clientDropped.inc({ reason: 'unknown_route' });
      return false;
    }
    const cache = sample.cache ? 'hit' : 'miss';
    for (const metric of CLIENT_TIMING_METRICS) {
      const ms = sample.ms[metric];
      if (ms === undefined) continue;
      this.clientTiming.observe(
        { route: sample.route, kind: sample.kind, metric, cache },
        ms / 1000,
      );
    }
    return true;
  }

  /** The exposition text and its content type, for GET /metrics. */
  async exposition(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
