import fs from 'fs';
import path from 'path';
import { PUBLIC_DIR } from '../src/static-assets';
import { CLIENT_MODULES } from './static-assets';

// The licence notices the image owes its third-party code (#640), written to
// public/THIRD-PARTY-NOTICES.txt by `npm run generate:notices` (in `npm run
// build`) and served at /THIRD-PARTY-NOTICES.txt, linked from /about. The
// client files are minified or copied with their banners stripped, so the
// notices travel here instead of inside each file.

const ROOT = path.join(PUBLIC_DIR, '..');
export const NOTICES_FILE = path.join(PUBLIC_DIR, 'THIRD-PARTY-NOTICES.txt');

/**
 * Packages whose code or fonts reach a served file but are devDependencies
 * (bundled at build time): the two webfonts (views/assets/fonts.css), the
 * stylesheet's component library and what views/assets/src-sw.ts bundles
 * into sw.js. Their own dependencies come with them. The production tree
 * (package-lock.json, everything not `dev`) is listed regardless.
 */
const BUNDLED_AT_BUILD: readonly string[] = [
  '@fontsource-variable/fraunces',
  '@fontsource-variable/inter',
  'daisyui',
  'workbox-cacheable-response',
  'workbox-core',
  'workbox-expiration',
  'workbox-navigation-preload',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
];

// Icons are path data drawn through Icon (src/web/layout/icon.tsx), no
// package, so no licence file travels with them. Both sets are MIT.
const ICON_CREDITS = `ICONS

The app's inline SVG icons are drawn from two MIT-licensed sets:

  Heroicons (https://heroicons.com), Copyright (c) Tailwind Labs, Inc.
  Hugeicons free icon set (https://hugeicons.com), Copyright (c) Hugeicons

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
these icons and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const WEATHER_CREDIT = `WEATHER DATA

Forecasts and climate normals are provided by Open-Meteo.com
(https://open-meteo.com), licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/).`;

const HEADER = `THIRD-PARTY NOTICES

This application includes the third-party software, fonts and data below.
Each package entry gives its declared licence and the licence
files it ships.`;

interface LockPackage {
  license?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

type Lock = Record<string, LockPackage>;

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\..+)?$/i;
const RULE = '='.repeat(78);
const MODULES = 'node_modules/';

function readLock(): Lock {
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'),
  ) as { packages: Lock };
  return lock.packages;
}

/** The lock key `name` resolves to from the package at `from`: a nested copy, else a parent's. */
function resolveDependency(
  packages: Lock,
  from: string,
  name: string,
): string | undefined {
  let scope = from;
  for (;;) {
    const key = `${scope}${scope ? '/' : ''}${MODULES}${name}`;
    if (packages[key]) return key;
    if (!scope) return undefined;
    const cut = scope.lastIndexOf(`/${MODULES}`);
    scope = cut === -1 ? '' : scope.slice(0, cut);
  }
}

/** Lock keys of every package the notices cover, sorted. */
function coveredKeys(packages: Lock): string[] {
  const keys = new Set(
    Object.entries(packages)
      .filter(([key, pkg]) => key !== '' && !pkg.dev)
      .map(([key]) => key),
  );
  const pending = BUNDLED_AT_BUILD.map((name) => `${MODULES}${name}`);
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (keys.has(key)) continue;
    if (!packages[key]) throw new Error(`${key} is not in package-lock.json`);
    keys.add(key);
    const { dependencies = {}, optionalDependencies = {} } = packages[key];
    for (const dep of Object.keys({
      ...dependencies,
      ...optionalDependencies,
    })) {
      const resolved = resolveDependency(packages, key, dep);
      if (resolved) pending.push(resolved);
    }
  }
  return [...keys].sort();
}

function section(key: string, pkg: LockPackage): string | undefined {
  const dir = path.join(ROOT, key);
  // Optional platform builds (sharp, onnxruntime) are installed only where
  // they run; the notices cover what this tree holds.
  if (!fs.existsSync(path.join(dir, 'package.json'))) return undefined;
  const name = key.slice(key.lastIndexOf(MODULES) + MODULES.length);
  const texts = fs
    .readdirSync(dir)
    .filter(
      (file) =>
        LICENCE_FILE.test(file) && fs.statSync(path.join(dir, file)).isFile(),
    )
    .sort()
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8').trim());
  return [
    RULE,
    `${name}  (${pkg.license ?? 'licence not declared'})`,
    RULE,
    ...(texts.length > 0
      ? texts
      : ['(the package ships no licence file; its declared licence is above)']),
  ].join('\n\n');
}

/**
 * The whole notices file: the icons, the weather credit, then every covered
 * package with its licence files. Deterministic for one installed tree.
 */
export function buildNotices(): string {
  const packages = readLock();
  const sections = coveredKeys(packages)
    .map((key) => section(key, packages[key]))
    .filter((s) => s !== undefined);
  return (
    [HEADER, ICON_CREDITS, WEATHER_CREDIT, ...sections].join('\n\n') + '\n'
  );
}

/** The packages CLIENT_MODULES copies from (`@scope/name` or `name`). */
export function clientModulePackages(): string[] {
  const names = CLIENT_MODULES.map(({ from }) =>
    from
      .split('/')
      .slice(0, from.startsWith('@') ? 2 : 1)
      .join('/'),
  );
  return [...new Set(names)];
}

/** Writes NOTICES_FILE, leaving an identical one (and its variants' freshness) alone. */
export function writeNotices(): { bytes: number; written: boolean } {
  const text = buildNotices();
  const current = fs.existsSync(NOTICES_FILE)
    ? fs.readFileSync(NOTICES_FILE, 'utf8')
    : undefined;
  if (current !== text) fs.writeFileSync(NOTICES_FILE, text);
  return { bytes: Buffer.byteLength(text), written: current !== text };
}
