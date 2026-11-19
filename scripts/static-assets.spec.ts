import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { buildPageModules, precompress } from './static-assets';

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
      outdir: at('js', 'gen'),
      legacyDir: at('js'),
      parkDir: at('parked'),
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'closet-pages-'));
    mkdirSync(at('sources'), { recursive: true });
    writeFileSync(at('sources', 'outbox.ts'), 'export const y = 1;\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves only the new output after a module is renamed', () => {
    source('old-name');
    build();
    // A variant the precompress step wrote beside it.
    writeFileSync(at('js', 'gen', 'old-name.js.br'), 'x');
    rmSync(at('sources', 'page', 'old-name.ts'));
    source('new-name');

    build();

    expect(readdirSync(at('js', 'gen')).sort()).toEqual([
      'new-name.js',
      'outbox.js',
    ]);
  });

  it('moves an untracked copy from before public/js/gen/ out of public/ and keeps a tracked one', () => {
    source('converted');
    source('plain');
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(at('js'), { recursive: true });
    writeFileSync(at('js', 'converted.js'), 'export const edited = 1;\n');
    writeFileSync(at('js', 'converted.js.br'), 'x');
    writeFileSync(at('js', 'plain.js'), 'export {};\n');
    execFileSync('git', ['add', 'js/plain.js'], { cwd: root });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    build();

    expect(existsSync(at('js', 'converted.js'))).toBe(false);
    expect(existsSync(at('js', 'converted.js.br'))).toBe(false);
    expect(readFileSync(at('parked', 'converted.js'), 'utf8')).toBe(
      'export const edited = 1;\n',
    );
    expect(readFileSync(at('parked', 'converted.js.br'), 'utf8')).toBe('x');
    expect(existsSync(at('js', 'plain.js'))).toBe(true);
    expect(existsSync(at('parked', 'plain.js'))).toBe(false);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
