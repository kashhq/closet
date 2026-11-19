import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findStaleVariants } from '../src/static-assets';
import {
  buildPageModules,
  precompress,
  watchPageModules,
} from './static-assets';

describe('precompress', () => {
  let root: string;
  const path = (name: string) => join(root, name);
  // Compressible text well over the 1 KB threshold.
  const text = 'body { color: oklch(50% 0.1 30); }\n'.repeat(100);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'closet-precompress-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes brotli and gzip beside a text file that decode to it', () => {
    writeFileSync(path('bundle.css'), text);
    expect(precompress(root)).toMatchObject({ written: 2, removed: 0 });
    expect(
      brotliDecompressSync(readFileSync(path('bundle.css.br'))).toString(),
    ).toBe(text);
    expect(gunzipSync(readFileSync(path('bundle.css.gz'))).toString()).toBe(
      text,
    );
  });

  it('skips small files, images and maps', () => {
    writeFileSync(path('small.js'), 'console.log(1);');
    writeFileSync(path('icon.png'), text);
    writeFileSync(path('app.js.map'), text);
    expect(precompress(root).written).toBe(0);
    expect(existsSync(path('small.js.br'))).toBe(false);
    expect(existsSync(path('icon.png.br'))).toBe(false);
    expect(existsSync(path('app.js.map.br'))).toBe(false);
  });

  it('keeps current variants and rewrites stale ones', async () => {
    writeFileSync(path('bundle.css'), text);
    precompress(root);
    expect(precompress(root)).toMatchObject({ written: 0, current: 2 });

    // A lone `npm run generate:tailwind`: the source moves past its variants.
    const changed = text.replace(/50%/g, '60%');
    writeFileSync(path('bundle.css'), changed);
    const later = statSync(path('bundle.css.br')).mtimeMs / 1000 + 10;
    utimesSync(path('bundle.css'), later, later);
    expect((await findStaleVariants(root)).stale).toHaveLength(2);

    expect(precompress(root)).toMatchObject({ written: 2, current: 0 });
    expect(
      brotliDecompressSync(readFileSync(path('bundle.css.br'))).toString(),
    ).toBe(changed);
    expect(await findStaleVariants(root)).toEqual({ stale: [], current: 2 });
  });

  it('removes variants whose source is gone or no longer eligible', () => {
    writeFileSync(path('gone.js.br'), 'x');
    writeFileSync(path('small.js'), 'console.log(1);');
    writeFileSync(path('small.js.gz'), 'x');
    expect(precompress(root)).toMatchObject({ written: 0, removed: 2 });
    expect(existsSync(path('gone.js.br'))).toBe(false);
    expect(existsSync(path('small.js.gz'))).toBe(false);
  });
});

describe('buildPageModules', () => {
  let root: string;
  const at = (...parts: string[]) => join(root, ...parts);
  const source = (name: string) => {
    mkdirSync(at('sources', 'page'), { recursive: true });
    writeFileSync(at('sources', 'page', `${name}.ts`), 'export const x = 1;\n');
  };
  const build = () =>
    buildPageModules({
      sources: at('sources'),
      outdir: at('js'),
      manifest: at('cache', 'page-modules.json'),
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'closet-pages-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(at('sources'), { recursive: true });
    writeFileSync(at('sources', 'outbox.ts'), 'export const y = 1;\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes the output of a renamed module and keeps plain-JS files it never built', () => {
    source('old-name');
    mkdirSync(at('js'), { recursive: true });
    writeFileSync(at('js', 'plain.js'), 'export {};\n');
    expect(build().removed).toEqual([]);
    expect(existsSync(at('js', 'old-name.js'))).toBe(true);

    rmSync(at('sources', 'page', 'old-name.ts'));
    source('new-name');
    const { removed } = build();

    expect(removed).toEqual(['old-name.js']);
    expect(existsSync(at('js', 'old-name.js'))).toBe(false);
    expect(existsSync(at('js', 'new-name.js'))).toBe(true);
    expect(existsSync(at('js', 'plain.js'))).toBe(true);
  });

  it('keeps a tracked file, though an earlier run built that name', () => {
    source('mod');
    build();
    execFileSync('git', ['add', '-f', 'js/mod.js'], { cwd: root });
    rmSync(at('sources', 'page', 'mod.ts'));

    expect(build().removed).toEqual([]);
    expect(existsSync(at('js', 'mod.js'))).toBe(true);
  });

  it('keeps a file whose content changed since the build', () => {
    source('mod');
    build();
    writeFileSync(at('js', 'mod.js'), 'export const edited = 1;\n');
    rmSync(at('sources', 'page', 'mod.ts'));

    expect(build().removed).toEqual([]);
    expect(readFileSync(at('js', 'mod.js'), 'utf8')).toContain('edited');
  });

  it('removes nothing outside a repository and keeps the file listed', () => {
    source('mod');
    build();
    rmSync(at('.git'), { recursive: true });
    rmSync(at('sources', 'page', 'mod.ts'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(build().removed).toEqual([]);
    expect(existsSync(at('js', 'mod.js'))).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(readFileSync(at('cache', 'page-modules.json'), 'utf8')).toContain(
      'mod.js',
    );

    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(build().removed).toEqual(['mod.js']);
    warn.mockRestore();
  });

  it('reports the outputs an old name-only list left, deleting none', () => {
    source('keep');
    mkdirSync(at('js'), { recursive: true });
    writeFileSync(at('js', 'gone.js'), 'export {};\n');
    mkdirSync(at('cache'), { recursive: true });
    writeFileSync(at('cache', 'page-modules.json'), '["gone.js"]');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(build().removed).toEqual([]);
    expect(existsSync(at('js', 'gone.js'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone.js'));
    warn.mockRestore();
  });

  it('records a watcher rebuild, so a later rename still removes its output', async () => {
    source('mod');
    build();
    const watcher = await watchPageModules({
      sources: at('sources'),
      outdir: at('js'),
      manifest: at('cache', 'page-modules.json'),
    });
    try {
      writeFileSync(at('sources', 'page', 'mod.ts'), 'export const x = 2;\n');
      await watcher.rebuild();
    } finally {
      await watcher.dispose();
    }
    expect(readFileSync(at('js', 'mod.js'), 'utf8')).toContain('2');

    rmSync(at('sources', 'page', 'mod.ts'));
    expect(build().removed).toEqual(['mod.js']);
    expect(existsSync(at('js', 'mod.js'))).toBe(false);
  });
});
