import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Lockfile {
  packages: Record<string, { version?: string }>;
}
interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, '..', file), 'utf8')) as T;

const manifest = read<Manifest>('package.json');
const lock = read<Lockfile>('package-lock.json');

const isTailwind = (name: string): boolean =>
  name === 'tailwindcss' || name.startsWith('@tailwindcss/');
const direct = Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
}).filter(([name]) => isTailwind(name));
const locked = Object.entries(lock.packages).filter(([path]) =>
  /(^|\/)node_modules\/(tailwindcss|@tailwindcss\/[^/]+)$/.test(path),
);

// scripts/lg-check.ts compiles classes with @tailwindcss/node + oxide; a
// different version of any other Tailwind package (a nested copy under the
// CLI, say) would make it judge CSS that the bundle build never produces.
describe('Tailwind resolves to one version', () => {
  it('pins every direct Tailwind dependency to the same exact version', () => {
    expect(direct.length).toBeGreaterThanOrEqual(4);
    for (const [name, range] of direct)
      expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(direct.map(([, range]) => range)).size).toBe(1);
  });

  it('locks every Tailwind package at that version, none nested', () => {
    const [[, pinned]] = direct;
    expect(
      locked.filter(([, pkg]) => pkg.version !== pinned).map(([path]) => path),
    ).toEqual([]);
    expect(
      locked
        .filter(([path]) => path.split('node_modules/').length > 2)
        .map(([path]) => path),
    ).toEqual([]);
  });
});
