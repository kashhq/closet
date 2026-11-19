import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import {
  type BuildContext,
  type BuildOptions,
  buildSync,
  context,
} from 'esbuild';
import {
  isFreshVariant,
  PRECOMPRESSED_EXTENSIONS,
  PUBLIC_DIR,
  variantSource,
} from '../src/static-assets';
import { IMPORT_MAP_NAMES } from '../src/web/layout/import-map';

// Build steps for what src/static-assets.ts serves from public/. Run by
// scripts/generate-static-assets.ts (`npm run generate:modules`,
// `npm run generate:pages`, `npm run generate:precompress`) and, so the integration tier serves
// public/ as the build leaves it, by the integration project's globalSetup
// (test/support/static-assets-setup.ts).

const NODE_MODULES = path.join(PUBLIC_DIR, '..', 'node_modules');
const MODULES_DIR = path.join(PUBLIC_DIR, 'modules');

/**
 * The client libraries the pages load from /modules/ (the layout's script
 * tag and importmap, src/web/layout/layout.tsx), as installed: copied into
 * public/modules/ so they are served, cached and precompressed like every
 * other static file. A library that ships no minified ES module is built
 * into public/vendor/ instead (`npm run generate:vendor`). Every one is
 * precached (scripts/generate-sw.ts refuses a build that lacks one).
 */
export const CLIENT_MODULES: readonly { from: string; to: string }[] = [
  { from: 'htmx.org/dist/htmx.min.js', to: 'htmx.min.js' },
  {
    from: 'workbox-window/build/workbox-window.prod.mjs',
    to: 'workbox-window.prod.mjs',
  },
  {
    from: 'workbox-window/build/workbox-window.prod.mjs.map',
    to: 'workbox-window.prod.mjs.map',
  },
  {
    from: '@khmyznikov/pwa-install/dist/pwa-install.bundle.js',
    to: 'pwa-install.bundle.js',
  },
  {
    from: '@khmyznikov/pwa-install/dist/pwa-install.bundle.js.map',
    to: 'pwa-install.bundle.js.map',
  },
  {
    from: 'pulltorefreshjs/dist/index.esm.js',
    to: 'pulltorefresh/index.esm.js',
  },
];

/**
 * Makes public/modules/ hold exactly CLIENT_MODULES. A file whose bytes are
 * already current is left alone, so its mtime (and its precompressed
 * variants' freshness) survives a repeat run; anything else there goes.
 */
export function syncClientModules(): { copied: string[]; removed: string[] } {
  const wanted = new Set(CLIENT_MODULES.map((m) => m.to));
  const copied: string[] = [];
  for (const { from, to } of CLIENT_MODULES) {
    const source = fs.readFileSync(path.join(NODE_MODULES, from));
    const target = path.join(MODULES_DIR, to);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(source)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    copied.push(to);
  }
  const removed = listFiles(MODULES_DIR)
    .map((file) => path.relative(MODULES_DIR, file))
    .filter((file) => !wanted.has(variantSource(file) ?? file));
  for (const file of removed) fs.rmSync(path.join(MODULES_DIR, file));
  return { copied, removed };
}

const PAGE_SOURCES = path.join(PUBLIC_DIR, '..', 'views', 'assets');
/**
 * The page modules' output, public/js/gen/ (ignored by git), served as
 * /js/gen/<name>.js (pageModuleUrl, src/web/layout/import-map.ts). Nothing
 * but this build writes there, so whatever it did not output this run is
 * stale by definition: no list of what earlier runs built is kept. Kept out
 * of public/js/ itself, which holds the tracked plain-JS modules
 * (scripts/ci/plain_js.conf).
 */
export const PAGE_OUT = path.join(PUBLIC_DIR, 'js', 'gen');

/**
 * The page's TypeScript modules (src/web/shell/AGENTS.md, Client modules):
 * views/assets/outbox.ts and every views/assets/page/<name>.ts, each to
 * PAGE_OUT/<name>.js. Each is one ES module: what it imports by a relative
 * path (the shared rules in src/) is bundled in, what it imports by an
 * importmap name stays a bare import the browser resolves, so a module
 * several import (toast, single-flight) is one instance per document.
 */
export function pageModuleEntries(
  sources: string = PAGE_SOURCES,
): Record<string, string> {
  const page = path.join(sources, 'page');
  const entries: Record<string, string> = {
    outbox: path.join(sources, 'outbox.ts'),
  };
  for (const file of fs.readdirSync(page).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    entries[path.basename(file, '.ts')] = path.join(page, file);
  }
  return entries;
}

function pageBuildOptions(sources: string, outdir: string): BuildOptions {
  return {
    entryPoints: pageModuleEntries(sources),
    outdir,
    bundle: true,
    minify: true,
    format: 'esm',
    external: IMPORT_MAP_NAMES,
  };
}

// Where the page modules were built before public/js/gen/ (#1177).
const PAGE_LEGACY_DIR = path.join(PUBLIC_DIR, 'js');
// Outside public/, so a moved file is neither served nor copied into the image.
const LEGACY_PARK_DIR = path.join(
  NODE_MODULES,
  '.cache',
  'closet',
  'legacy-js',
);

/**
 * Moves the untracked `<name>.js` copies the builds before public/js/gen/
 * left in public/js/ for each page module name (with their .br/.gz) to
 * `parkDir`: no longer ignored and never referenced, but a checkout's
 * leftovers would still be copied into the image (the Dockerfile's
 * `COPY public`). They are moved, never deleted: an untracked file of that
 * name may be a developer's uncommitted edit (#1181), and an older parked
 * copy is overwritten. A tracked file (a plain-JS module) is never touched.
 * Without git to ask (the image build has no .git), nothing is moved.
 */
function parkLegacyCopies(names: string[], dir: string, parkDir: string): void {
  const candidates = names
    .map((name) => `${name}.js`)
    .filter((file) => fs.existsSync(path.join(dir, file)));
  if (candidates.length === 0) return;
  let tracked: Set<string>;
  try {
    const listed = execFileSync('git', ['ls-files', '-z', '--', '.'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    tracked = new Set(listed.split('\0').filter(Boolean));
  } catch {
    return;
  }
  for (const file of candidates) {
    if (tracked.has(file)) continue;
    fs.mkdirSync(parkDir, { recursive: true });
    for (const variant of [file, `${file}.br`, `${file}.gz`]) {
      const from = path.join(dir, variant);
      if (fs.existsSync(from)) {
        fs.renameSync(from, path.join(parkDir, variant));
      }
    }
    console.log(
      `page modules: moved ${path.relative(process.cwd(), path.join(dir, file))}, an untracked copy from before public/js/gen/, to ${path.relative(process.cwd(), path.join(parkDir, file))}`,
    );
  }
}

/**
 * Makes `outdir` hold exactly this build of pageModuleEntries (minified, as
 * the worker is), like syncClientModules: an output whose bytes are already
 * current is left alone, so its mtime (and its precompressed variants'
 * freshness) survives a repeat run, and every other file there goes, a
 * renamed or deleted module's output with it. Returns the names written and
 * removed.
 */
export function buildPageModules(
  where: {
    sources?: string;
    outdir?: string;
    legacyDir?: string;
    parkDir?: string;
  } = {},
): { written: string[]; removed: string[] } {
  const {
    sources = PAGE_SOURCES,
    outdir = PAGE_OUT,
    legacyDir = PAGE_LEGACY_DIR,
    parkDir = LEGACY_PARK_DIR,
  } = where;
  parkLegacyCopies(Object.keys(pageModuleEntries(sources)), legacyDir, parkDir);
  const result = buildSync({
    ...pageBuildOptions(sources, outdir),
    logLevel: 'warning',
    write: false,
  });
  fs.mkdirSync(outdir, { recursive: true });
  const built = new Set<string>();
  const written: string[] = [];
  for (const output of result.outputFiles) {
    const name = path.relative(outdir, output.path);
    built.add(name);
    const bytes = Buffer.from(output.contents);
    if (
      fs.existsSync(output.path) &&
      fs.readFileSync(output.path).equals(bytes)
    ) {
      continue;
    }
    fs.writeFileSync(output.path, bytes);
    written.push(name);
  }
  // A current output's variants stay for precompress to judge.
  const removed = listFiles(outdir)
    .map((file) => path.relative(outdir, file))
    .filter((file) => !built.has(variantSource(file) ?? file));
  for (const file of removed) fs.rmSync(path.join(outdir, file));
  return { written, removed };
}

/**
 * Rebuilds the page modules into the same directory on every change to
 * their sources, for `npm run start:dev` (which builds once first). The
 * entry list is read at start: a new or renamed page module needs a restart,
 * whose first build removes the old output. Returns the watching context;
 * the process runs until it is stopped.
 */
export async function watchPageModules(
  where: { sources?: string; outdir?: string } = {},
): Promise<BuildContext> {
  const { sources = PAGE_SOURCES, outdir = PAGE_OUT } = where;
  const watcher = await context({
    ...pageBuildOptions(sources, outdir),
    logLevel: 'info',
  });
  await watcher.watch();
  return watcher;
}

// Text formats worth compressing; images, fonts (woff2 is brotli already)
// and source maps (fetched only by open devtools) are not.
const COMPRESSIBLE = new Set(['.css', '.js', '.mjs', '.svg', '.txt', '.json']);
// @fastify/compress's own threshold: below it a response is sent as is.
const MIN_BYTES = 1024;

const ENCODERS: Record<
  (typeof PRECOMPRESSED_EXTENSIONS)[number],
  (data: Buffer) => Buffer
> = {
  '.br': (data) =>
    zlib.brotliCompressSync(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]:
          zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
  '.gz': (data) =>
    zlib.gzipSync(data, { level: zlib.constants.Z_BEST_COMPRESSION }),
};

export interface PrecompressResult {
  written: number;
  current: number;
  removed: number;
  /** Source bytes, and what brotli brought them to, over the files written. */
  bytes: number;
  brotliBytes: number;
}

/**
 * Writes a `.br` (brotli 11) and a `.gz` (gzip 9) beside every compressible
 * file of MIN_BYTES or more under `root`, and deletes every variant with no
 * eligible source. A variant already current (isFreshVariant) is kept; one
 * that would not be smaller than its source is not written. Must run after
 * every step that writes into public/.
 */
export function precompress(root: string = PUBLIC_DIR): PrecompressResult {
  const result: PrecompressResult = {
    written: 0,
    current: 0,
    removed: 0,
    bytes: 0,
    brotliBytes: 0,
  };
  const files = listFiles(root);
  const sources = files.filter(
    (file) =>
      !variantSource(file) &&
      COMPRESSIBLE.has(path.extname(file)) &&
      fs.statSync(file).size >= MIN_BYTES,
  );
  const kept = new Set<string>();
  for (const source of sources) refreshVariants(source, result, kept);
  for (const file of files) {
    if (variantSource(file) && !kept.has(file)) {
      fs.rmSync(file);
      result.removed += 1;
    }
  }
  return result;
}

/** Brings one source's variants up to date, adding them to `kept`. */
function refreshVariants(
  source: string,
  result: PrecompressResult,
  kept: Set<string>,
): void {
  const sourceStat = fs.statSync(source);
  let data: Buffer | undefined;
  for (const ext of PRECOMPRESSED_EXTENSIONS) {
    const variant = source + ext;
    const variantStat = fs.statSync(variant, { throwIfNoEntry: false });
    if (variantStat && isFreshVariant(variantStat, sourceStat)) {
      kept.add(variant);
      result.current += 1;
      continue;
    }
    data ??= fs.readFileSync(source);
    const encoded = ENCODERS[ext](data);
    if (encoded.length >= data.length) continue;
    fs.writeFileSync(variant, encoded);
    // Dated just past its source, not now: a source dated ahead of the
    // clock (copied in from elsewhere) would otherwise outdate its variant
    // for good. The extra millisecond absorbs utimes's float seconds.
    const stamp = (Math.ceil(sourceStat.mtimeMs) + 1) / 1000;
    fs.utimesSync(variant, stamp, stamp);
    kept.add(variant);
    result.written += 1;
    if (ext === '.br') {
      result.bytes += data.length;
      result.brotliBytes += encoded.length;
    }
  }
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}
