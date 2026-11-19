import { afterAll, expect, vi } from 'vitest';
import { releasePrototypeLeaks } from './prototype-hygiene';

/**
 * Per spec file of the integration project, whose workers share one module
 * graph across files (`isolate: false`, vitest.config.mts): whatever process
 * state a file changed through `vi` ends with the file, so the next file in
 * the worker starts from real timers, the real environment and real globals.
 * Vitest itself restores spies between files; it does not restore these.
 *
 * Nor can anything restore a built-in prototype a module extended at import,
 * so the file that loaded it fails instead, and the key is hidden so no
 * later file fails for it: every app in the worker would see it otherwise
 * (#620, #629, prototype-hygiene.ts).
 */
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(
    releasePrototypeLeaks(),
    'a module this file imported added enumerable keys to a built-in prototype: hide them where it is imported (hidePrototypeExtensions)',
  ).toEqual([]);
});
