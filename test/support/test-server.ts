import { join, resolve } from 'node:path';
import type * as ConfigModule from '../../src/config';
import type * as DbClientModule from '../../src/db/client';
import type * as LoggerModule from '../../src/logger';
import type * as ServerModule from '../../src/server';
import { CUTOUT_STUB_ORIGIN, startCutoutStub } from './cutout-stub';
import { startJmapStub } from './jmap-stub';
import { startWeatherStub } from './weather-stub';

/**
 * The built server (dist/, `npm run build` first) as src/main.ts boots it,
 * with one difference: background removal runs a stub instead of the 940 MB
 * model, which no test downloads. Playwright (playwright.config.ts) and
 * Lighthouse (lighthouserc.js) start it with `npm run start:test`; an upload
 * goes pending, as in production, and its cutout arrives as soon as the queue
 * reaches it, unless a spec holds it pending (cutout-stub.ts). And the weather comes from
 * a stand-in for Open-Meteo (weather-stub.ts: the seed's simulated New York
 * weather), so no test run calls the real service and the screenshots'
 * weather is the same on every run of a date. Configuration is the
 * environment's, as for main.ts.
 */

const DIST = join(resolve(__dirname, '..', '..'), 'dist');

async function main(): Promise<void> {
  // The build, not src/: the tests run what the image ships.
  const { loadConfig } = (await import(
    join(DIST, 'config.js')
  )) as typeof ConfigModule;
  const { createLogger } = (await import(
    join(DIST, 'logger.js')
  )) as typeof LoggerModule;
  const { serve } = (await import(
    join(DIST, 'server.js')
  )) as typeof ServerModule;
  const { connectionOptions, dbConfig } = (await import(
    join(DIST, 'db', 'client.js')
  )) as typeof DbClientModule;
  const config = loadConfig();
  const logger = createLogger(config);
  const cutouts = await startCutoutStub(
    connectionOptions(dbConfig(config)),
    logger,
  );
  const weather = await startWeatherStub();
  // The order mail's poll, when the environment sets ORDER_MAIL_JMAP_TOKEN
  // (playwright.config.ts does not, #706), reads an empty stand-in inbox,
  // never Fastmail.
  const jmap = config.ORDER_MAIL_JMAP_TOKEN
    ? await startJmapStub(config.ORDER_MAIL_JMAP_TOKEN)
    : undefined;
  logger.info(
    `Test server: background removal stubbed (at once; holds on ${CUTOUT_STUB_ORIGIN}), weather from ${weather.options.endpoints.forecast}${jmap ? `, order mail from ${jmap.options.sessionUrl}` : ''}`,
  );
  const { app } = await serve(config, logger, cutouts.runner, {
    weather: weather.options,
    orderMail: jmap?.options,
  });
  // serve() closes the app on SIGTERM; the stubs' own servers would keep the
  // process alive after it (a caller waited forever, #112). Their HTTP
  // servers close after the timers have stopped, so nothing asks them.
  app.server.once('close', () => {
    void weather.close();
    void jmap?.close();
    void cutouts.close();
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
