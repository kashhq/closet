import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The statement counts the integration specs pin, as the metrics ratchet's
 * `statements.<METHOD>:<route template>` keys (devkit docs/metrics-keys.md,
 * decision H of 2026-10-13): every request made inside a recordQueries
 * block (test/integration/harness.ts), keyed by its method and route and
 * holding the most statements any such request sent. Deterministic, as the
 * specs are: the same commit gives the same file.
 *
 * Written only when STATEMENTS_OUT names the file (`make ci-db`): each spec
 * file's process writes a fragment beside it at afterAll
 * (statement-budgets-setup.ts), and the global teardown merges them
 * (statement-budgets-global.ts), the largest count winning per key.
 */

export interface RequestStatements {
  /** `<METHOD>:<route template>`, `unmatched` for a 404 no route matched (never noted). */
  key: string;
  statements: number;
}

const budgets = new Map<string, number>();

/**
 * A 404 no route matched has no route template to budget, and the statements
 * collector (devkit/metrics/statements.py) refuses a key without one: it is
 * left out, so the file holds only real routes whatever the specs request.
 */
export const isRouteKey = (key: string) =>
  key.slice(key.indexOf(':') + 1).startsWith('/');

export function noteStatements(requests: readonly RequestStatements[]): void {
  for (const { key, statements } of requests.filter(({ key }) =>
    isRouteKey(key),
  )) {
    budgets.set(key, Math.max(budgets.get(key) ?? 0, statements));
  }
}

/** The output file, when this run writes one. */
export function statementsOut(): string | undefined {
  return process.env.STATEMENTS_OUT || undefined;
}

const fragmentsOf = (out: string) => `${out}.d`;

/** This process's counts, as one fragment (nothing when none were noted). */
export function writeFragment(out: string): void {
  if (budgets.size === 0) return;
  const dir = fragmentsOf(out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${process.pid}-${randomBytes(4).toString('hex')}.json`),
    JSON.stringify(Object.fromEntries(budgets)),
  );
}

/** Drops the fragments a previous run left. */
export function clearFragments(out: string): void {
  rmSync(fragmentsOf(out), { recursive: true, force: true });
}

/**
 * Every fragment merged into `out` as flat `statements.<key>` numbers,
 * sorted, so the file diffs by key; returns how many keys it holds.
 */
export function mergeFragments(out: string): number {
  const dir = fragmentsOf(out);
  const merged = new Map<string, number>();
  const fragments = existsSync(dir) ? readdirSync(dir) : [];
  for (const name of fragments) {
    const counts = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<
      string,
      number
    >;
    for (const [key, statements] of Object.entries(counts)) {
      merged.set(key, Math.max(merged.get(key) ?? 0, statements));
    }
  }
  const snapshot = Object.fromEntries(
    [...merged.keys()]
      .sort()
      .map((key) => [`statements.${key}`, merged.get(key)!]),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  clearFragments(out);
  return merged.size;
}
