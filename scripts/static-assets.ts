import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
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
const PAGE_OUT = path.join(PUBLIC_DIR, 'js');
const PAGE_MANIFEST = path.join(
  PUBLIC_DIR,
  '..',
  'node_modules',
  '.cache',
  'closet',
  'page-modules.json',
);

/**
 * The page's TypeScript modules (src/web/shell/AGENTS.md, Client modules):
 * views/assets/outbox.ts and every views/assets/page/<name>.ts, each to
 * public/js/<name>.js (ignored by git), the URL the layout and the
 * importmap name. Each is one ES module: what it imports by a relative path
 * (the shared rules in src/) is bundled in, what it imports by an importmap
 * name stays a bare import the browser resolves, so a module several import
 * (toast, single-flight) is one instance per document.
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

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * The file names under `dir` that the repository tracks, or undefined when
 * there is no repository or no git binary to ask (a Docker context without
 * .git, a tarball).
 */
function trackedNames(dir: string): Set<string> | undefined {
  try {
    const listed = execFileSync('git', ['ls-files', '-z', '--', '.'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(listed.split('\0').filter(Boolean));
  } catch {
    return undefined;
  }
}

/** `legacy` is a list from before hashes were kept (an array of names). */
function readManifest(manifest: string): {
  legacy: string[];
  recorded: Record<string, string>;
} {
  const parsed: unknown = fs.existsSync(manifest)
    ? JSON.parse(fs.readFileSync(manifest, 'utf8'))
    : {};
  return Array.isArray(parsed)
    ? { legacy: parsed as string[], recorded: {} }
    : { legacy: [], recorded: parsed as Record<string, string> };
}

function writeManifest(manifest: string, built: Map<string, string>): void {
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(
    manifest,
    JSON.stringify(Object.fromEntries([...built].sort())),
  );
}

/**
 * Deletes the outputs the previous run (`manifest`: name to the sha-256 of
 * what that run wrote) built that this one did not, then records this run's.
 * A listed file survives (and leaves the list) when it is tracked now, or its
 * bytes are not the ones recorded: a checkout of a branch where the module is
 * still plain JS puts a tracked file of the same name there, and deleting it
 * would leave the tree dirty. Without git to ask, nothing is deleted and the
 * candidates stay listed for a run that can. A list from before hashes were
 * kept (an array of names) proves nothing about what is on disk, so its
 * surviving names are only reported for the developer to delete. Returns the
 * removed file names.
 */
function removeStaleBuilds(
  outdir: string,
  manifest: string,
  built: Map<string, string>,
): string[] {
  const { legacy, recorded } = readManifest(manifest);
  const previous = Object.entries(recorded).filter(
    ([name]) => !built.has(name),
  );
  const onDisk = (name: string) => fs.existsSync(path.join(outdir, name));
  const unlisted = legacy.filter((name) => !built.has(name) && onDisk(name));
  if (unlisted.length > 0) {
    console.warn(
      `page modules: ${unlisted.join(', ')} in ${outdir} may be stale builds from before content hashes were kept; delete them if untracked`,
    );
  }
  const candidates = previous.filter(([name]) => onDisk(name));
  const tracked =
    candidates.length > 0 ? trackedNames(outdir) : new Set<string>();
  const removed: string[] = [];
  const kept = new Map(built);
  if (tracked) {
    for (const [name, hash] of candidates) {
      const file = path.join(outdir, name);
      if (tracked.has(name) || sha256(fs.readFileSync(file)) !== hash) continue;
      fs.rmSync(file);
      removed.push(name);
    }
  } else {
    console.warn(
      `page modules: git is unavailable for ${outdir}; not removing ${candidates.map(([name]) => name).join(', ')}`,
    );
    for (const [name, hash] of candidates) kept.set(name, hash);
  }
  writeManifest(manifest, kept);
  return removed;
}

/**
 * Bundles pageModuleEntries into public/js/ (minified, as the worker is). A
 * module whose bytes are already current is left alone, so its mtime (and
 * its precompressed variants' freshness) survives a repeat run, as
 * syncClientModules does. A module no longer built (a renamed or deleted
 * source) has its output removed, so no checkout keeps serving it. public/js
 * also holds the tracked plain-JS modules (scripts/ci/plain_js.conf), so what
 * counts as ours is the previous run's list (names and content hashes), kept
 * in `manifest` outside public/ (never served or precached); a file that is
 * tracked or whose content changed since is never removed. Returns the names written and removed.
 */
export function buildPageModules(
  where: { sources?: string; outdir?: string; manifest?: string } = {},
): { written: string[]; removed: string[] } {
  const {
    sources = PAGE_SOURCES,
    outdir = PAGE_OUT,
    manifest = PAGE_MANIFEST,
  } = where;
  const result = buildSync({
    ...pageBuildOptions(sources, outdir),
    logLevel: 'warning',
    write: false,
  });
  const written: string[] = [];
  const built = new Map<string, string>();
  for (const output of result.outputFiles) {
    const bytes = Buffer.from(output.contents);
    built.set(path.basename(output.path), sha256(bytes));
    if (
      fs.existsSync(output.path) &&
      fs.readFileSync(output.path).equals(bytes)
    ) {
      continue;
    }
    fs.mkdirSync(path.dirname(output.path), { recursive: true });
    fs.writeFileSync(output.path, bytes);
    written.push(path.basename(output.path));
  }
  return { written, removed: removeStaleBuilds(outdir, manifest, built) };
}

/**
 * Rebuilds the page modules on every change to their sources, for
 * `npm run start:dev` (which builds once first, so removals are handled
 * there). The entry list is read at start: a new page module needs a restart.
 * Each rebuild records its outputs' hashes in the manifest buildPageModules
 * keeps, so the next `generate:pages` sees the files as built, not edited,
 * and cleans up a renamed module's. Returns the watching context; the
 * process runs until it is stopped.
 */
export async function watchPageModules(
  where: { sources?: string; outdir?: string; manifest?: string } = {},
): Promise<BuildContext> {
  const {
    sources = PAGE_SOURCES,
    outdir = PAGE_OUT,
    manifest = PAGE_MANIFEST,
  } = where;
  const watcher = await context({
    ...pageBuildOptions(sources, outdir),
    logLevel: 'info',
    metafile: true,
    plugins: [
      {
        name: 'record-page-manifest',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0 || !result.metafile) return;
            const recorded = new Map(
              Object.entries(readManifest(manifest).recorded),
            );
            for (const output of Object.keys(result.metafile.outputs)) {
              const file = path.resolve(output);
              recorded.set(path.basename(file), sha256(fs.readFileSync(file)));
            }
            writeManifest(manifest, recorded);
          });
        },
      },
    ],
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
