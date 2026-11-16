import { createAppErrorTracker } from './app';
import { type Config, ConfigError, loadConfig } from './config';
import { bootModelRunner } from './cutout/boot';
import { SchemaAheadError, schemaAheadRefusal } from './db/migrate';
import { createBootLogger, createLogger, type Logger } from './logger';
import {
  createCrashHandler,
  DISABLED_ERROR_TRACKER,
  type ErrorTracker,
  reportBootFailure,
} from './metrics/error-tracker';
import { serve } from './server';
import {
  probeWritable,
  storageFix,
  sweepProbeLeftovers,
} from './storage-probe';
import {
  identityRefusal,
  StorageIdentityError,
} from './web/files/storage-identity';

// Before the boot probe: a dead predecessor's probe files go here, once,
// since the probes never list a directory (#855).
async function sweepLeftovers(
  directories: readonly string[],
  boot: Logger,
): Promise<void> {
  for (const directory of new Set(directories)) {
    const sweep = await sweepProbeLeftovers(directory);
    if (!sweep.swept) {
      boot.warn(
        `Could not sweep probe leftovers in ${directory} (${sweep.code})`,
      );
    } else if (sweep.removed > 0) {
      boot.info(`Removed ${sweep.removed} probe leftovers in ${directory}`);
    }
  }
}

// A boot that fails (bad configuration, a refused migration, a taken port)
// ends the process, whatever still holds the event loop, so the container
// reports it. The logger loses no line: JSON is written synchronously, and
// the text format's worker flushes on exit (src/logger.ts).
//
// Once serving, a crash (an uncaught exception, or an unhandled rejection,
// which Node raises as one) is sent to the error tracker before the
// process exits 1 as it would have (createCrashHandler). Here only, never
// in createApp: the specs' processes boot many apps and keep Node's own.
async function main(): Promise<void> {
  const boot = createBootLogger();
  let config: Config;
  try {
    // A renamed variable or value still set (DATABASE_SCHEMA,
    // DATABASE_SSL=true) boots, saying so once per boot.
    config = loadConfig({ onDeprecated: (message) => boot.warn(message) });
  } catch (error) {
    // A ConfigError names the bad keys (never their values); anything else
    // is a bug, logged with its stack.
    if (error instanceof ConfigError) boot.fatal(error.message);
    else boot.fatal({ err: error }, 'Configuration failed to load');
    process.exit(1);
  }
  // An unwritable data directory (a root-owned host mount; the image runs
  // non-root) would otherwise fail on the first upload with a bare EACCES
  // stack: refuse the boot, naming the fix. Only DATA_PATH stops
  // the boot: an unwritable MODELS_PATH leaves every page serving, so it is
  // /health/ready's `storage` check that reports it (src/web/health).
  await sweepLeftovers([config.DATA_PATH, config.MODELS_PATH], boot);
  const data = await probeWritable(config.DATA_PATH);
  if (!data.writable) {
    boot.fatal(
      `DATA_PATH ${config.DATA_PATH} is not writable by this process (${data.code}): ${storageFix([{ directory: config.DATA_PATH, code: data.code }])}`,
    );
    process.exit(1);
  }
  const logger = createLogger(config);
  // Made here, before serve(), so a boot that fails inside it (migrations,
  // storage, listen) reaches Bugsink: the container would otherwise
  // crash-loop with only its logs to say so. serve() uses this one.
  let errors: ErrorTracker = DISABLED_ERROR_TRACKER;
  try {
    errors = await createAppErrorTracker(config, logger);
    await serve(config, logger, bootModelRunner(config, logger), { errors });
    const onCrash = createCrashHandler({
      errors,
      logger,
      exit: (code) => process.exit(code),
    });
    process.on('uncaughtException', (error, origin) => {
      void onCrash(error, origin);
    });
  } catch (error) {
    // An unmounted photo share (createPhotos' claim), an image older than
    // the database's schema or a ConfigError found at boot is a refusal
    // naming the fix: no stack to read.
    if (error instanceof ConfigError) {
      // Its problems name keys, never values.
      logger.fatal(`Invalid configuration: ${error.problems.join('; ')}`);
    } else if (error instanceof StorageIdentityError) {
      logger.fatal(identityRefusal(error.problem));
    } else if (error instanceof SchemaAheadError) {
      logger.fatal(schemaAheadRefusal(error.newestAt));
    } else {
      logger.fatal({ err: error }, 'Boot failed');
    }
    await reportBootFailure(errors, error, logger);
    process.exit(1);
  }
}

void main();
