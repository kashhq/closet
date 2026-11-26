import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedHosts,
  ConfigError,
  type Env,
  loadConfig,
  orderMailSenders,
  trustedProxies,
} from './config';

// Everything without a default.
const REQUIRED: Env = {
  ACCESS_TOKEN_SECRET: 'x'.repeat(32),
  DATABASE_HOST: 'localhost',
  DATABASE_NAME: 'closet_db',
  DATABASE_USER: 'closet',
  DATABASE_PASS: '',
};

const load = (env: Env, envFiles: string[] = []) =>
  loadConfig({ env: { ...REQUIRED, ...env }, envFiles });

const problemsOf = (env: Env): string[] => {
  try {
    loadConfig({ env, envFiles: [] });
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('loadConfig accepted the environment');
};

describe('loadConfig', () => {
  it('fills every default', () => {
    const config = load({});
    expect(config).toMatchObject({
      NODE_ENV: 'production',
      APP_ENV: 'production',
      PORT: 3000,
      LOG_FORMAT: 'json',
      LOG_LEVEL: 'info',
      TRUSTED_PROXIES: '127.0.0.1,::1',
      APP_NAME: 'Closet',
      APP_TIMEZONE: 'America/New_York',
      DISABLE_REGISTRATION: false,
      PWA_ENABLED: false,
      SITE_URL: 'http://localhost:3000',
      ICON_NAME: 'icon.png',
      WATERMARK_ENABLED: false,
      DATABASE_PORT: 5432,
      DATABASE_SSL: 'off',
      MAINTENANCE_ENABLED: true,
      MAX_HEIC_BYTES: 40 * 1024 * 1024,
      CUTOUT_ENABLED: true,
      CUTOUT_THREADS: 4,
      CUTOUT_POLL_SECONDS: 60,
    });
    expect(config.DATA_PATH).toBe(join(process.cwd(), 'data'));
    expect(config.MODELS_PATH).toBe(join(process.cwd(), 'models'));
    expect(config.PUBLIC_VAPID_KEY).toBeUndefined();
  });

  it('converts booleans and numbers spelled exactly', () => {
    const config = load({
      PORT: '8080',
      DISABLE_REGISTRATION: 'TRUE',
      CUTOUT_ENABLED: 'false',
      MAX_HEIC_BYTES: '1024',
    });
    expect(config.PORT).toBe(8080);
    expect(config.DISABLE_REGISTRATION).toBe(true);
    expect(config.CUTOUT_ENABLED).toBe(false);
    expect(config.MAX_HEIC_BYTES).toBe(1024);
  });

  it('ignores variables it does not declare', () => {
    expect(load({ HOME: '/root' })).not.toHaveProperty('HOME');
  });

  it('boots with the retired CUTOUT_MODE still set (production env files keep it)', () => {
    expect(load({ CUTOUT_MODE: 'client' })).not.toHaveProperty('CUTOUT_MODE');
  });

  it('names every missing required variable, and accepts an empty database password', () => {
    expect(problemsOf({ DATABASE_PASS: '' })).toEqual([
      'ACCESS_TOKEN_SECRET: is required (at least 32 characters; generate one with: openssl rand -hex 32)',
      'DATABASE_HOST: is required',
      'DATABASE_NAME: is required',
      'DATABASE_USER: is required',
    ]);
  });

  it.each([
    ['PORT', 'eighty', 'PORT: expected integer'],
    ['MAX_HEIC_BYTES', '1.5', 'MAX_HEIC_BYTES: expected integer'],
    [
      'MAX_HEIC_BYTES',
      '0',
      'MAX_HEIC_BYTES: expected integer to be greater or equal to 1',
    ],
    ['DISABLE_REGISTRATION', 'yes', 'DISABLE_REGISTRATION: expected boolean'],
    [
      'LOG_LEVEL',
      'verbose',
      'LOG_LEVEL: must be one of trace, debug, info, warn, error, fatal, silent',
    ],
    [
      'NODE_ENV',
      'staging',
      'NODE_ENV: must be one of development, production, test',
    ],
    ['APP_ENV', 'test', 'APP_ENV: must be one of production, dev, gate'],
    ['LOG_FORMAT', 'pretty', 'LOG_FORMAT: must be one of json, text'],
    [
      'DATABASE_SSL',
      'require',
      'DATABASE_SSL: must be one of verify, no-verify, off',
    ],
    ['APP_NAME', '', 'APP_NAME: expected string length greater or equal to 1'],
    [
      'CUTOUT_THREADS',
      '0',
      'CUTOUT_THREADS: expected integer to be greater or equal to 1',
    ],
  ])('refuses %s=%j, naming it', (key, value, problem) => {
    expect(problemsOf({ ...REQUIRED, [key]: value })).toEqual([problem]);
  });

  describe('the database settings renamed before 0.1 (#694)', () => {
    const loadWarned = (env: Env) => {
      const warnings: string[] = [];
      const config = loadConfig({
        env: { ...REQUIRED, ...env },
        envFiles: [],
        onDeprecated: (message) => warnings.push(message),
      });
      return { config, warnings };
    };

    it.each([
      ['verify', 'verify'],
      ['no-verify', 'no-verify'],
      ['off', 'off'],
      [' Off ', 'off'],
      ['false', 'off'],
    ])('reads DATABASE_SSL=%j as %s, silently', (raw, mode) => {
      expect(loadWarned({ DATABASE_SSL: raw })).toEqual({
        config: expect.objectContaining({ DATABASE_SSL: mode }) as unknown,
        warnings: [],
      });
    });

    // What it always meant, until homelab moves (docs/decisions.md 2026-11-14).
    it('boots DATABASE_SSL=true as no-verify, with one deprecation warning', () => {
      const { config, warnings } = loadWarned({ DATABASE_SSL: 'TRUE' });
      expect(config.DATABASE_SSL).toBe('no-verify');
      expect(warnings).toEqual([
        'DATABASE_SSL=true is deprecated: it means no-verify (the server certificate is not checked) and will mean verify; set no-verify or verify',
      ]);
    });

    it('reads DATABASE_SCHEMA as DATABASE_NAME, which wins when both are set', () => {
      expect(
        loadWarned({ DATABASE_NAME: undefined, DATABASE_SCHEMA: 'old' }),
      ).toEqual({
        config: expect.objectContaining({ DATABASE_NAME: 'old' }) as unknown,
        warnings: ['DATABASE_SCHEMA is deprecated: rename it DATABASE_NAME'],
      });
      expect(loadWarned({ DATABASE_SCHEMA: 'old' })).toEqual({
        config: expect.objectContaining({
          DATABASE_NAME: 'closet_db',
        }) as unknown,
        warnings: [
          'DATABASE_SCHEMA is ignored: DATABASE_NAME is set; remove DATABASE_SCHEMA',
        ],
      });
      // The environment over the files, whichever name each uses.
      const dir = mkdtempSync(join(tmpdir(), 'closet-name-'));
      try {
        const file = join(dir, '.env.local');
        writeFileSync(file, 'DATABASE_NAME=from_file\n');
        const warnings: string[] = [];
        const config = loadConfig({
          env: {
            ...REQUIRED,
            DATABASE_NAME: undefined,
            DATABASE_SCHEMA: 'from_env',
          },
          envFiles: [file],
          onDeprecated: (message) => warnings.push(message),
        });
        expect(config.DATABASE_NAME).toBe('from_env');
        expect(warnings).toEqual([
          'DATABASE_SCHEMA is deprecated: rename it DATABASE_NAME',
        ]);
      } finally {
        rmSync(dir, { recursive: true });
      }
      expect(load({ DATABASE_SCHEMA: 'old' })).not.toHaveProperty(
        'DATABASE_SCHEMA',
      );
    });

    it('takes DATABASE_SSL_CA only under verify, and only a readable file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'closet-ca-'));
      try {
        const ca = join(dir, 'ca.pem');
        writeFileSync(ca, 'pem');
        expect(
          load({ DATABASE_SSL: 'verify', DATABASE_SSL_CA: ca }).DATABASE_SSL_CA,
        ).toBe(ca);
        expect(
          problemsOf({
            ...REQUIRED,
            DATABASE_SSL: 'no-verify',
            DATABASE_SSL_CA: ca,
          }),
        ).toEqual([
          'DATABASE_SSL_CA: applies only when DATABASE_SSL is verify',
        ]);
        for (const path of [join(dir, 'missing.pem'), dir]) {
          expect(
            problemsOf({
              ...REQUIRED,
              DATABASE_SSL: 'verify',
              DATABASE_SSL_CA: path,
            }),
          ).toEqual(['DATABASE_SSL_CA: must be a readable file']);
        }
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });

  // The test tiers hash at 4; production may never (a weak cost is a
  // cheaper offline crack of a leaked hash). The default is 12.
  it('refuses a bcrypt cost under 12 in production only', () => {
    expect(load({}).PASSWORD_HASH_ROUNDS).toBe(12);
    expect(problemsOf({ ...REQUIRED, PASSWORD_HASH_ROUNDS: '11' })).toEqual([
      'PASSWORD_HASH_ROUNDS: at least 12 when APP_ENV is production',
    ]);
    expect(
      load({ APP_ENV: 'gate', PASSWORD_HASH_ROUNDS: '4' }).PASSWORD_HASH_ROUNDS,
    ).toBe(4);
  });

  // /file serves DATA_PATH and the photo backups carry it: a log never lands there.
  it('refuses a LOG_FILE under DATA_PATH, however it is spelled, naming the key only', () => {
    expect(load({}).LOG_FILE).toBeUndefined();
    expect(
      load({ DATA_PATH: '/srv/data', LOG_FILE: '/srv/logs/closet.log' })
        .LOG_FILE,
    ).toBe('/srv/logs/closet.log');
    for (const LOG_FILE of [
      '/srv/data/app.log',
      '/srv/data/../data/sub/app.log',
      '/srv/data/',
      '/srv/other/../data/app.log',
    ]) {
      expect(
        problemsOf({ ...REQUIRED, DATA_PATH: '/srv/data', LOG_FILE }),
      ).toEqual(['LOG_FILE: must not be under DATA_PATH']);
    }
  });

  it.each([
    ['the old default', 'ChangeMe!'],
    ['31 characters', 'x'.repeat(31)],
  ])(
    'refuses an ACCESS_TOKEN_SECRET of %s, saying how to make one',
    (_label, secret) => {
      expect(problemsOf({ ...REQUIRED, ACCESS_TOKEN_SECRET: secret })).toEqual([
        'ACCESS_TOKEN_SECRET: expected string length greater or equal to 32 (at least 32 characters; generate one with: openssl rand -hex 32)',
      ]);
    },
  );

  it('refuses an unknown time zone', () => {
    expect(problemsOf({ ...REQUIRED, APP_TIMEZONE: 'Mars/Olympus' })).toEqual([
      'APP_TIMEZONE: "Mars/Olympus" is not an IANA time zone',
    ]);
  });

  it('requires both VAPID keys when the PWA is on', () => {
    expect(
      problemsOf({
        ...REQUIRED,
        PWA_ENABLED: 'true',
        SITE_URL: 'https://closet.test',
      }),
    ).toEqual([
      'PUBLIC_VAPID_KEY: is required when PWA_ENABLED is true',
      'PRIVATE_VAPID_KEY: is required when PWA_ENABLED is true',
    ]);
    expect(
      load({
        PWA_ENABLED: 'true',
        SITE_URL: 'https://closet.test',
        PUBLIC_VAPID_KEY: 'a',
        PRIVATE_VAPID_KEY: 'b',
      }).PWA_ENABLED,
    ).toBe(true);
  });

  it('requires an https SITE_URL when the PWA is on, naming the key and never the value', () => {
    const keys = { PUBLIC_VAPID_KEY: 'a', PRIVATE_VAPID_KEY: 'b' };
    for (const SITE_URL of ['http://localhost:3000', 'mailto:me@closet.test']) {
      const problems = problemsOf({
        ...REQUIRED,
        ...keys,
        PWA_ENABLED: 'true',
        SITE_URL,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^SITE_URL: .*https/);
      expect(problems[0]).not.toContain(SITE_URL);
    }
    // Off, an http SITE_URL is the local-development default.
    expect(load({ SITE_URL: 'http://localhost:3000' }).PWA_ENABLED).toBe(false);
  });

  it('takes a Sentry DSN, treats an empty one as unset and refuses anything else', () => {
    expect(load({}).SENTRY_DSN).toBe('');
    expect(load({ SENTRY_DSN: '' }).SENTRY_DSN).toBe('');
    expect(
      load({ SENTRY_DSN: 'http://abc123@tracker.example/3' }).SENTRY_DSN,
    ).toBe('http://abc123@tracker.example/3');
    expect(
      load({ SENTRY_DSN: 'https://abc@sentry.example/prefix/12' }).SENTRY_DSN,
    ).toBe('https://abc@sentry.example/prefix/12');
    for (const bad of [
      'tracker.example/3',
      'http://tracker.example/3',
      'http://k@tracker.example/',
    ]) {
      const problems = problemsOf({ ...REQUIRED, SENTRY_DSN: bad });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^SENTRY_DSN: /);
      expect(problems[0]).not.toContain(bad);
    }
  });

  it('turns the order mail on with its token, and then needs its senders and owner (#25)', () => {
    expect(load({}).ORDER_MAIL_JMAP_TOKEN).toBe('');
    expect(load({}).ORDER_MAIL_POLL_MINUTES).toBe(5);
    expect(
      problemsOf({ ...REQUIRED, ORDER_MAIL_JMAP_TOKEN: 'fmu1-secret' }),
    ).toEqual([
      'ORDER_MAIL_SENDERS: is required when ORDER_MAIL_JMAP_TOKEN is set',
      'ORDER_MAIL_OWNER: is required when ORDER_MAIL_JMAP_TOKEN is set',
    ]);
    // The poll interval fails the schema, so the cross-field checks wait.
    expect(
      problemsOf({
        ...REQUIRED,
        ORDER_MAIL_JMAP_TOKEN: 'fmu1-secret',
        ORDER_MAIL_POLL_MINUTES: '0',
      }),
    ).toEqual([expect.stringMatching(/^ORDER_MAIL_POLL_MINUTES: /)]);
    const problems = problemsOf({
      ...REQUIRED,
      ORDER_MAIL_JMAP_TOKEN: 'fmu1-secret',
      ORDER_MAIL_SENDERS: 'me@gmail.com, not an address',
      ORDER_MAIL_OWNER: 'me',
    });
    expect(problems).toEqual([
      'ORDER_MAIL_SENDERS: must be email addresses, comma-separated',
      'ORDER_MAIL_OWNER: must be an email address',
    ]);
    const config = load({
      ORDER_MAIL_JMAP_TOKEN: 'fmu1-secret',
      ORDER_MAIL_SENDERS: ' Me@Gmail.com ,me@work.example,',
      ORDER_MAIL_OWNER: 'me@gmail.com',
    });
    expect(orderMailSenders(config)).toEqual([
      'me@gmail.com',
      'me@work.example',
    ]);
  });

  it('never puts a value in the message', () => {
    try {
      loadConfig({
        env: {
          ACCESS_TOKEN_SECRET: 'too-short-secret',
          DATABASE_PASS: 'hunter2',
        },
        envFiles: [],
      });
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
      expect(String(error)).not.toContain('too-short-secret');
      expect(String(error)).toContain('ACCESS_TOKEN_SECRET');
      return;
    }
    throw new Error('loadConfig accepted the environment');
  });

  describe('env files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closet-config-'));
    const local = join(dir, '.env.local');
    const shared = join(dir, '.env');
    writeFileSync(local, 'APP_NAME=Local\nICON_NAME=local.png\n');
    writeFileSync(shared, 'APP_NAME=Shared\nSITE_URL=https://shared.test\n');

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('lets the environment win over the first file, and the first file over the second', () => {
      const config = load({ ICON_NAME: 'env.png' }, [local, shared]);
      expect(config.APP_NAME).toBe('Local');
      expect(config.ICON_NAME).toBe('env.png');
      expect(config.SITE_URL).toBe('https://shared.test');
    });

    it('skips a file that does not exist', () => {
      expect(load({}, [join(dir, 'missing')]).APP_NAME).toBe('Closet');
    });
  });
});

describe('allowedHosts (#702)', () => {
  it("is SITE_URL's host by default, its port kept unless a default one", () => {
    expect(allowedHosts(load({}))).toEqual(['localhost:3000']);
    expect(
      allowedHosts(load({ SITE_URL: 'https://Closet.Example.com:443/app' })),
    ).toEqual(['closet.example.com']);
  });

  it('adds each ALLOWED_HOSTS entry as a host key', () => {
    const config = load({
      SITE_URL: 'https://closet.example.com',
      ALLOWED_HOSTS: ' Closet.Test , closet:3000,closet.example.com:443,',
    });
    expect(allowedHosts(config)).toEqual([
      'closet.example.com',
      'closet.test',
      'closet:3000',
    ]);
  });

  it.each([
    'https://closet.test',
    'closet.test/path',
    'user@closet.test',
    'closet.test:port',
    'closet box',
  ])('refuses %s, naming the key without the value', (bad) => {
    const problems = problemsOf({
      ...REQUIRED,
      ALLOWED_HOSTS: `ok.test,${bad}`,
    });
    expect(problems).toEqual([
      'ALLOWED_HOSTS: must be host names or host:port, comma-separated (no scheme or path)',
    ]);
  });
});

describe('trustedProxies', () => {
  it('splits and trims the list', () => {
    expect(
      trustedProxies({ TRUSTED_PROXIES: ' 10.0.0.1, 172.16.0.0/12 ,' }),
    ).toEqual(['10.0.0.1', '172.16.0.0/12']);
  });
});
