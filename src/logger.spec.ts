import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LogCapture } from '../test/support/log-capture';
import { createLogger, createLoggerTo, PRETTY } from './logger';

describe('createLoggerTo', () => {
  it('never writes a credential header, whoever logs a request', () => {
    const logs = new LogCapture();
    const logger = createLoggerTo('info', logs);
    logger.info(
      {
        req: {
          headers: {
            cookie: 'access_token=cookie-secret',
            authorization: 'Bearer auth-secret',
            'user-agent': 'test',
          },
        },
        res: { headers: { 'set-cookie': 'access_token=set-secret' } },
      },
      'request',
    );
    const [record] = logs.records;
    expect(record.req).toEqual({
      headers: {
        cookie: '[redacted]',
        authorization: '[redacted]',
        'user-agent': 'test',
      },
    });
    expect(record.res).toEqual({ headers: { 'set-cookie': '[redacted]' } });
  });

  it('names the module on every line of a child, and keeps LOG_LEVEL', () => {
    const logs = new LogCapture();
    const photos = createLoggerTo('info', logs).child({ logger: 'Photos' });
    photos.debug('hidden');
    photos.info('shown');
    expect(logs.records).toEqual([
      expect.objectContaining({
        level: 'info',
        logger: 'Photos',
        msg: 'shown',
      }),
    ]);
  });
});

describe('the err serializer', () => {
  function loggedErr(error: unknown) {
    const logs = new LogCapture();
    createLoggerTo('info', logs).warn({ err: error }, 'failed');
    return logs.records[0].err;
  }

  it('redacts an upstream URL and key=value pairs, keeping file:// frames', () => {
    const cause = new Error(
      'connect ECONNREFUSED postgres://ci:hunter2@10.0.0.5/closet',
    );
    const error = Object.assign(
      new Error('GET https://api.example/v1?key=s3cret failed, token=abc', {
        cause,
      }),
      { code: 'E_UPSTREAM', status: 502, options: { key: 's3cret' } },
    );
    const err = loggedErr(error);
    const text = JSON.stringify(err);
    expect(text).not.toMatch(/s3cret|hunter2|abc/);
    expect(err).toEqual({
      type: 'Error',
      // The cause leads; its URL's redaction takes the separator with it.
      message: 'connect ECONNREFUSED <url> GET <url> failed, <param>',
      stack: expect.stringContaining(
        'caused by: Error: connect ECONNREFUSED <url>',
      ) as string,
      code: 'E_UPSTREAM',
      status: 502,
    });
    expect(err?.stack).toMatch(/\(file:\/\/|\bat .*logger\.spec\.ts/);
  });

  it("drops a failed query's whole params tail and keeps the stack's frames (Codex review of #406)", () => {
    // A user's note with a newline and "at " must not end the cut early.
    const error = new Error('db down', {
      cause: new Error(
        'Failed query: select 1 where email = $1\nparams: owner@example.com,line one\n    at private note',
      ),
    });
    const err = loggedErr(error);
    expect(JSON.stringify(err)).not.toMatch(/owner@example|private note/);
    expect(err?.message).toBe(
      'Failed query: select 1 where email = $1\nparams: [Filtered]: db down',
    );
    expect(err?.stack).toMatch(
      /caused by: Error: Failed query: select 1 where email = \$1\nparams: \[Filtered\]\n\s+at /,
    );
  });

  it('scrubs a stack that does not quote its message whole, and logs a missing stack as empty', () => {
    const rewritten = new Error(
      'Failed query: select 1\nparams: owner@example.com',
    );
    rewritten.stack =
      'DrizzleQueryError: rewritten\nparams: owner@example.com\n    at query';
    const stackless = new Error('');
    stackless.stack = undefined;
    expect(loggedErr(rewritten)?.stack).toBe(
      'DrizzleQueryError: rewritten\nparams: [Filtered]',
    );
    expect(loggedErr(stackless)?.stack).toBe('');
  });

  // Drizzle's wrapper is the statement, the reason its cause (#643): cut
  // outermost first, every outage line said `Failed query: select ...` alone.
  it('leads with the Postgres reason and its innermost SQLSTATE, not the statement Drizzle wraps it in', () => {
    const reason = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' },
    );
    const socket = Object.assign(new Error('Connection terminated'), {
      cause: reason,
      code: 'ECONNRESET',
    });
    const statement = `Failed query: select ${'"garment"."id", '.repeat(40)}1`;
    expect(statement.length).toBeGreaterThan(600);
    const err = loggedErr(new Error(statement, { cause: socket }));
    expect(err?.code).toBe('57P01');
    expect(err?.message).toMatch(
      /^terminating connection due to administrator command: Connection terminated: Failed query: select /,
    );
    expect(err?.message).toHaveLength(201);
  });

  it('cuts a long message and logs a thrown non-Error by its type alone', () => {
    expect(loggedErr(new Error('x'.repeat(300)))?.message).toBe(
      `${'x'.repeat(200)}…`,
    );
    expect(loggedErr('upstream body text')).toEqual({ type: 'string' });
  });
});

describe('the line shape', () => {
  it('writes ts (RFC 3339 UTC), the level by name, the version and the logger', () => {
    const lines: string[] = [];
    const logger = createLoggerTo(
      'info',
      { write: (line: string) => lines.push(line) },
      'abc1234',
    );
    logger.child({ logger: 'Photos' }).warn({ count: 2 }, 'shown');
    expect(JSON.parse(lines[0])).toEqual({
      ts: expect.stringMatching(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      ) as string,
      level: 'warn',
      version: 'abc1234',
      logger: 'Photos',
      count: 2,
      msg: 'shown',
    });
  });
});

describe('createLogger', () => {
  const base = {
    LOG_LEVEL: 'info',
    LOG_FORMAT: 'json',
    APP_VERSION: 'abc1234',
  } as const;

  // Async destinations land their lines later: wait for them.
  async function until(done: () => boolean | Promise<boolean>): Promise<void> {
    for (let waited = 0; waited < 5000; waited += 20) {
      if (await done()) return;
      await sleep(20);
    }
    throw new Error('the log never got there');
  }

  it('writes to stdout alone by default: one line per entry, no file to open', () => {
    const stdout = new LogCapture();
    createLogger({ ...base }, stdout)
      .child({ logger: 'Spec' })
      .info('console only');
    expect(stdout.records).toMatchObject([
      { level: 'info', logger: 'Spec', msg: 'console only' },
    ]);
  });

  it('adds JSON lines to LOG_FILE when it is set, beside stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'closet-logger-'));
    try {
      const file = join(dir, 'debug.log');
      const stdout = new LogCapture();
      createLogger({ ...base, LOG_FILE: file }, stdout)
        .child({ logger: 'Spec' })
        .info('both sinks');
      await until(async () =>
        (await readFile(file, 'utf8').catch(() => '')).includes('both sinks'),
      );
      expect(JSON.parse((await readFile(file, 'utf8')).trim())).toMatchObject({
        level: 'info',
        logger: 'Spec',
        msg: 'both sinks',
      });
      expect(stdout.messages('info', 'Spec')).toEqual(['both sinks']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A write error is an `error` event on the file's stream: with no listener it
  // would end the process. The file here is a directory, which fails to open.
  it('reports an unwritable LOG_FILE to stdout once, keeps logging, and never throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'closet-logger-'));
    try {
      const stdout = new LogCapture();
      const logger = createLogger({ ...base, LOG_FILE: dir }, stdout).child({
        logger: 'Spec',
      });
      logger.info('first');
      await until(() => stdout.messages('error', 'Logger').length > 0);
      for (let i = 0; i < 20; i++) logger.info(`later ${i}`);
      await sleep(100);
      expect(stdout.messages('error', 'Logger')).toEqual([
        'LOG_FILE is not writable; its lines are dropped',
      ]);
      expect(stdout.messages('info', 'Spec')).toHaveLength(21);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('caps the LOG_FILE buffer and reports the drops once per stall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'closet-logger-'));
    try {
      const stdout = new LogCapture();
      // A cap below one line: nothing is ever buffered, so nothing drains.
      const logger = createLogger(
        { ...base, LOG_FILE: join(dir, 'debug.log') },
        stdout,
        1,
      ).child({ logger: 'Spec' });
      for (let i = 0; i < 5; i++) logger.info(`line ${i}`);
      expect(stdout.messages('warn', 'Logger')).toEqual([
        'LOG_FILE is not keeping up; lines are dropped',
      ]);
      expect(stdout.messages('info', 'Spec')).toHaveLength(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints a readable line with LOG_FORMAT=text: level name and message together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'closet-logger-'));
    try {
      const out = join(dir, 'pretty.txt');
      // The console destination, pointed at a file so the spec can read it.
      const logger = createLogger(
        { ...base, LOG_FORMAT: 'text' },
        pino.transport({
          target: 'pino-pretty',
          options: { ...PRETTY, colorize: false, destination: out },
        }),
      );
      logger.info('format check');
      await until(async () =>
        (await readFile(out, 'utf8').catch(() => '')).includes('format check'),
      );
      expect(await readFile(out, 'utf8')).toMatch(/INFO.*format check/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
