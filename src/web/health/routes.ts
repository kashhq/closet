import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { buildMigrationTimes, lastMigrationAt } from '../../db/migrate';
import { probeWritable, storageFix } from '../../storage-probe';
import { identityRefusal, STORAGE_MARKER_FIX } from '../files/storage-identity';
import type { WebOptions } from '../plugin';
import { enforceLimit, HEALTH_LIMIT } from '../security/rate-limit';
import {
  checkCutoutQueue,
  checkDatabase,
  checkJobs,
  checkOrderMailOwner,
  checkTrustedProxies,
  createStorageCheck,
  readiness,
} from './checks';

/**
 * The fleet's two health endpoints (observability.md, Health Contract;
 * src/web/health/AGENTS.md). Public, static paths (static-prefixes.ts: no
 * session, no access line), `no-store` so no cache answers for the server.
 *
 * - GET /health/live checks nothing: 200 while the process serves.
 *   public/js/connectivity.js probes it with HEAD, so the offline banner
 *   never says "offline" because a dependency is down.
 * - GET /health/ready runs the checks (checks.ts): 200 up, 503 down.
 *   The image's HEALTHCHECK, scripts/smoke-image.sh and devkit's
 *   contract probe read it. Rate-limited (HEALTH_LIMIT).
 * - GET /healthz is /health/ready's handler and budget, kept for phones
 *   whose cached connectivity.js still HEADs it (Fastify answers HEAD
 *   from the GET route, without the body).
 */
export const healthRoutes: FastifyPluginCallback<WebOptions> = (
  app,
  { config, db, logger, jobs, cutouts, photos, proxyWatch, orderMailWatch },
  done,
) => {
  const log = logger.child({ logger: 'Health' });
  // Once: it reads (and hashes) every migration file.
  const buildMigrations = buildMigrationTimes();
  const limit = app.createRateLimit(HEALTH_LIMIT);
  const storage = createStorageCheck({
    directories: config.storageDirs,
    probe: probeWritable,
    fix: storageFix,
    identity: async () => {
      // The marker against the id claimed (and, in production, paired) at
      // boot: no statement, so a slow database never reads as storage (#833).
      const problem = await photos.storage.identityProblem();
      return problem && identityRefusal(problem);
    },
    identityFix: `see ${STORAGE_MARKER_FIX}`,
    logger: log,
  });

  app.get(
    '/health/live',
    { config: { public: true } },
    async (_request, reply) =>
      reply.header('Cache-Control', 'no-store').send({ status: 'up' }),
  );

  const ready = async (request: FastifyRequest, reply: FastifyReply) => {
    await enforceLimit(limit, request, { logger: log, who: request.ip });
    const body = readiness(config.release, {
      ...(await checkDatabase(() => lastMigrationAt(db), buildMigrations, log)),
      storage: await storage(),
      cron_jobs: checkJobs(jobs.stuck()),
      cutout_queue: checkCutoutQueue(cutouts.state),
      trusted_proxies: checkTrustedProxies(proxyWatch.peer),
      order_mail_owner: checkOrderMailOwner(orderMailWatch.missing),
    });
    return reply
      .status(body.status === 'up' ? 200 : 503)
      .header('Cache-Control', 'no-store')
      .send(body);
  };
  app.get('/health/ready', { config: { public: true } }, ready);
  app.get('/healthz', { config: { public: true } }, ready);

  done();
};
