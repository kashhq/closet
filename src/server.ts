import { type AppOptions, type ClosetApp, createApp } from './app';
import type { Config } from './config';
import { type CutoutQueue, retryFailedCutouts } from './cutout/queue';
import type { CutoutRunner } from './cutout/runner';
import type { Db } from './db/client';
import type { Logger } from './logger';
import type { Metrics } from './metrics/metrics';
import { scheduleMinutely } from './maintenance/minutely';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorageWhole } from './maintenance/reconcile';
import { type ScheduledJob, stopBeforeClose } from './maintenance/scheduled';
import { pruneSyncTombstones } from './maintenance/sync-prune';
import { pruneWeatherCaches } from './maintenance/weather-prune';
import { addDays, todayIn } from './calendar-date';
import { pruneReminders, sendDueRemindersWhole } from './web/push/reminders';
import { pollOrderMailWhole } from './web/wardrobe/order-mail/poll';
import { closeQuietRounds } from './web/wishlist/round-end';
import type { PushSender } from './web/push/sender';
import {
  pruneReplans,
  type ReplanDeps,
  ReplanRetries,
  replanWeeksWhole,
} from './web/week-plan/replan';

// The hour, in APP_TIMEZONE, of the nightly jobs: the storage
// reconciliation, the cutout retry, the prunes.
const RECONCILE_HOUR = 3;

/**
 * The server process: createApp(), the nightly jobs, the push reminders
 * (with PWA_ENABLED), the order mail's poll (with ORDER_MAIL_JMAP_TOKEN),
 * the week's daily re-plan (the planner's entries
 * judged against the forecast with WEATHER_ENABLED, and always against
 * what can still be worn), the quiet close of Muse's rounds, the
 * background-removal queue started with
 * `runner`,
 * signal handling, listen. main.ts passes the model (ModelRunner), or none
 * with CUTOUT_ENABLED=false, which alone decides whether the queue starts and
 * the nightly retry is scheduled (a runner passed then is ignored);
 * test/support/test-server.ts, which Playwright and Lighthouse boot on
 * the build, passes a stub, so no test downloads or runs
 * the 940 MB model. createApp() itself never starts the queue or a timer:
 * the integration harness and the CLIs never run jobs or send anything.
 * `options` are createApp's test-only ones (the test server's stand-in for
 * Open-Meteo); main.ts passes none. Returns the listening app, so a caller
 * that started something beside it (the test server's stub) can stop it
 * when the app's server closes, and its error tracker, which main.ts's
 * crash handler reports through.
 */
export async function serve(
  config: Config,
  logger: Logger,
  runner: CutoutRunner | undefined,
  options: AppOptions = {},
): Promise<Pick<ClosetApp, 'app' | 'errors'>> {
  const {
    app,
    db,
    photos,
    cutouts,
    roster,
    push,
    weather,
    orderMail,
    metrics,
    errors,
  } = await createApp(config, logger, options);

  // Every timer, stopped together at preClose (a run in flight waited for)
  // before onClose ends the queue and the pool (#78).
  const jobs: ScheduledJob[] = [];
  const reconciliation = logger.child({ logger: 'Reconciliation' });
  if (config.MAINTENANCE_ENABLED) {
    jobs.push(
      scheduleNightly({
        name: 'Storage reconciliation',
        hour: RECONCILE_HOUR,
        timeZone: config.APP_TIMEZONE,
        run: metrics.timeJob('reconciliation', () =>
          reconcileStorageWhole({
            db,
            photos,
            logger: reconciliation,
            timeZone: config.APP_TIMEZONE,
          }),
        ),
        logger: reconciliation,
      }),
    );
  } else {
    reconciliation.info(
      'Storage reconciliation disabled (MAINTENANCE_ENABLED=false)',
    );
  }
  if (config.CUTOUT_ENABLED) {
    if (!runner) throw new Error('CUTOUT_ENABLED needs a cutout runner');
    jobs.push(startCutouts(config, logger, metrics, db, cutouts, runner));
  }
  // The changes feed's old deletions (src/maintenance/sync-prune.ts):
  // database only, so with or without MAINTENANCE_ENABLED.
  const sync = { db, logger: logger.child({ logger: 'Sync' }) };
  jobs.push(
    scheduleNightly({
      name: 'Sync tombstone prune',
      hour: RECONCILE_HOUR,
      timeZone: config.APP_TIMEZONE,
      run: metrics.timeJob('sync_prune', () => pruneSyncTombstones(sync)),
      logger: sync.logger,
    }),
  );
  // The weather caches' unused locations (src/maintenance/weather-prune.ts):
  // database only, so with or without WEATHER_ENABLED or MAINTENANCE_ENABLED.
  const weatherPrune = { db, logger: logger.child({ logger: 'Weather' }) };
  jobs.push(
    scheduleNightly({
      name: 'Weather cache prune',
      hour: RECONCILE_HOUR,
      timeZone: config.APP_TIMEZONE,
      run: metrics.timeJob('weather_prune', () =>
        pruneWeatherCaches(weatherPrune, new Date()),
      ),
      logger: weatherPrune.logger,
    }),
  );
  // One set of re-plan deps: the minutely run and the morning reminder's
  // re-plan first (src/web/push/reminders.ts) are the same re-plan.
  const replan: ReplanDeps = {
    db,
    weather,
    push,
    timeZone: config.APP_TIMEZONE,
    logger: logger.child({ logger: 'WeekPlan' }),
    retries: new ReplanRetries(),
  };
  if (push) {
    jobs.push(...startReminders(config, logger, metrics, push, replan));
  }
  jobs.push(...startReplans(config, metrics, replan));
  // A Muse round its agent never finished, closed once quiet
  // (src/web/wishlist/round-end.ts); notified only with PWA_ENABLED.
  const rounds = { db, push, logger: logger.child({ logger: 'Muse' }) };
  jobs.push(
    scheduleMinutely({
      name: 'Muse round close',
      run: metrics.timeJob('muse_rounds', (now: Date) =>
        closeQuietRounds(rounds, now),
      ),
      logger: rounds.logger,
    }),
  );
  if (orderMail) {
    jobs.push(
      scheduleMinutely({
        name: 'Order mail poll',
        everyMinutes: config.ORDER_MAIL_POLL_MINUTES,
        run: metrics.timeJob('order_mail', () => pollOrderMailWhole(orderMail)),
        logger: orderMail.logger,
      }),
    );
  }
  // Before listen(): Fastify takes no hooks once it is ready.
  stopBeforeClose(app, jobs, logger.child({ logger: 'Scheduler' }));
  // Every job, for /health/ready's cron_jobs check (a run that never ends).
  roster.adopt(jobs);

  // `docker stop` sends SIGTERM: stop accepting, let in-flight requests
  // finish and stop the timers (preClose), then onClose ends the queue and
  // the pool and the process exits on its own.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info(`${signal}: shutting down`);
      app.close().catch((error: unknown) => {
        logger.error({ err: error }, 'Shutdown failed');
        process.exitCode = 1;
      });
    });
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  return { app, errors };
}

// The queue (pending cutouts from before a restart first; createApp stops
// it) and the nightly retry of failed ones, returned.
function startCutouts(
  config: Config,
  logger: Logger,
  metrics: Metrics,
  db: Db,
  cutouts: CutoutQueue,
  runner: CutoutRunner,
): ScheduledJob {
  const log = logger.child({ logger: 'Cutout' });
  cutouts.start(runner);
  return scheduleNightly({
    name: 'Cutout retry',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: metrics.timeJob('cutout_retry', async () => {
      if ((await retryFailedCutouts(db, log)) > 0) cutouts.wake();
    }),
    logger: log,
  });
}

// The push reminders (src/web/push/reminders.ts): every minute, what is due
// is claimed and sent (a morning one after its person's re-plan); the claims
// of past days go nightly. Both returned.
function startReminders(
  config: Config,
  logger: Logger,
  metrics: Metrics,
  sender: PushSender,
  replan: ReplanDeps,
): ScheduledJob[] {
  const log = logger.child({ logger: 'Push' });
  const deps = {
    db: replan.db,
    sender,
    weather: replan.weather,
    timeZone: config.APP_TIMEZONE,
    logger: log,
    replan,
  };
  const reminders = scheduleMinutely({
    name: 'Push reminders',
    run: metrics.timeJob('reminders', (now: Date, signal: AbortSignal) =>
      sendDueRemindersWhole(deps, now, signal),
    ),
    logger: log,
  });
  const prune = scheduleNightly({
    name: 'Reminder claims prune',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: metrics.timeJob('reminder_prune', () =>
      pruneReminders(
        deps,
        addDays(todayIn(config.APP_TIMEZONE, new Date()), -1),
      ),
    ),
    logger: log,
  });
  return [reminders, prune];
}

// The week's daily re-plan (src/web/week-plan/replan.ts): every minute a
// run that does nothing before REPLAN_HOUR and then re-plans each user due
// one, once for the day (so a restart after the hour catches up); the
// claims of past days go nightly. Both returned. Scheduled with or without
// WEATHER_ENABLED: without a forecast it still swaps an outfit that can no
// longer be worn.
function startReplans(
  config: Config,
  metrics: Metrics,
  deps: ReplanDeps,
): ScheduledJob[] {
  const replans = scheduleMinutely({
    name: 'Week re-plan',
    run: metrics.timeJob('replan', (now: Date) => replanWeeksWhole(deps, now)),
    logger: deps.logger,
  });
  const prune = scheduleNightly({
    name: 'Re-plan claims prune',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: metrics.timeJob('replan_prune', () =>
      pruneReplans(deps, addDays(todayIn(config.APP_TIMEZONE, new Date()), -1)),
    ),
    logger: deps.logger,
  });
  return [replans, prune];
}
