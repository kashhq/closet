import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  appliesAtDesktop,
  desktopClassifier,
  isCounted,
  judge,
  mediaPreludes,
  readConf,
  readIndex,
} from './lg-check';

describe('appliesAtDesktop (the compiled @media, not the class name)', () => {
  it.each([
    '(width >= 64rem)',
    '(width >= 80rem)',
    '(min-width: 1024px)',
    '(min-width: 64em)',
    'not (width < 64rem)',
    'not all and (max-width: 64rem)',
    '(min-width: calc(100vw))',
    '(min-width: 64rem) and (hover: hover)',
    '(width >= 64rem), print',
  ])('counts %s', (query) => expect(appliesAtDesktop(query)).toBe(true));

  it.each([
    '(width >= 40rem)',
    '(width >= 48rem)',
    '(min-width: 40rem)',
    '(width < 64rem)',
    '(max-width: 1100px) and (min-width: 640px)',
    '(width >= 40rem) and (width < 64rem)',
    'not (width >= 64rem)',
    '(hover: hover) and (pointer: fine)',
    '(prefers-reduced-motion: no-preference)',
    'print',
  ])('ignores %s', (query) => expect(appliesAtDesktop(query)).toBe(false));

  it('reads every @media of a stylesheet and none of its @container queries', () => {
    const css =
      '@container (width >= 64rem) { a {} } @media (width >= 64rem) { b {} } @media print { c {} }';
    expect(mediaPreludes(css)).toEqual(['(width >= 64rem)', 'print']);
  });
});

describe('the classifier, compiled with views/assets/main.css', () => {
  let isDesktop: (candidate: string) => boolean;
  beforeAll(async () => {
    isDesktop = await desktopClassifier();
  }, 30_000);

  it.each([
    'lg:flex',
    'xl:flex',
    '2xl:flex',
    'min-lg:flex',
    'hover:lg:flex',
    'lg:hover:flex',
    'md:hover:min-[1024px]:flex',
    'min-[64rem]:flex',
    'min-[64em]:flex',
    'min-[calc(100vw)]:flex',
    'not-max-lg:flex',
    'not-max-[1100px]:flex',
    '[@media(min-width:64rem)]:flex',
    '*:lg:flex',
    '**:lg:flex',
    'lg:*:flex',
    'group-hover:lg:flex',
    'lg:target:ring-2',
  ])('counts %s', (candidate) =>
    expect(isDesktop(candidate), candidate).toBe(true),
  );

  it.each([
    'flex',
    'md:flex',
    'sm:flex',
    'min-sm:flex',
    'min-md:flex',
    'hover:focus:flex',
    'group-hover:flex',
    'peer-checked:flex',
    'not-checked:flex',
    'not-hover:flex',
    '[&>:first-child]:flex',
    '[&>*]:flex',
    '*:flex',
    '**:flex',
    'fine:inline',
    'max-lg:flex',
    'max-[1100px]:flex',
    'md:max-lg:flex',
    'min-[48rem]:flex',
    'min-[40rem]:flex',
    'min-[1023px]:flex',
    '@lg:flex',
    '@xl:flex',
    '@min-lg:flex',
    'node:crypto',
    'mailto:x',
    'og:image',
    '4:5',
  ])('ignores %s', (candidate) =>
    expect(isDesktop(candidate), candidate).toBe(false),
  );

  it('judges each candidate alone though Tailwind builds cumulatively', () => {
    expect(isDesktop('lg:block')).toBe(true);
    expect(isDesktop('lg:inline')).toBe(true);
    expect(isDesktop('md:block')).toBe(false);
    expect(isDesktop('lg:flex')).toBe(true);
  });
});

describe('readConf', () => {
  it('parses lines and comments', () => {
    const conf = readConf(
      '# c\nsrc src/web\nexempt a/\nexempt b.tsx # why\n\nknown x.tsx 3\n',
    );
    expect(conf).toEqual({
      src: 'src/web',
      exempt: ['a/', 'b.tsx'],
      known: new Map([['x.tsx', 3]]),
    });
  });

  it('rejects a malformed line', () => {
    expect(() => readConf('known x.tsx many\n')).toThrow(/known/);
  });
});

describe('judge', () => {
  const conf = (known: [string, number][]) => ({
    src: 'src/web',
    exempt: [],
    known: new Map(known),
  });

  it('passes an equal count', () => {
    expect(judge(new Map([['a.tsx', 2]]), conf([['a.tsx', 2]]))).toEqual({
      failures: [],
      lowered: [],
    });
  });

  it('fails growth and a file without a line', () => {
    expect(
      judge(new Map([['a.tsx', 2]]), conf([['a.tsx', 1]])).failures[0],
    ).toContain('only shrinks');
    expect(judge(new Map([['a.tsx', 1]]), conf([])).failures[0]).toContain(
      'no known line',
    );
  });

  it('asks for the number to be lowered, and a cleared file to lose its line', () => {
    expect(
      judge(new Map([['a.tsx', 1]]), conf([['a.tsx', 3]])).lowered[0],
    ).toContain('lower it to 1');
    expect(judge(new Map(), conf([['a.tsx', 1]])).lowered[0]).toContain(
      'delete its known line',
    );
  });
});

describe('isCounted', () => {
  it('skips exempt paths, specs and non-ts files', () => {
    const exempt = ['src/web/layout/', 'src/web/strip/snap-strip.tsx'];
    expect(isCounted('src/web/layout/shell.tsx', exempt)).toBe(false);
    expect(isCounted('src/web/strip/snap-strip.tsx', exempt)).toBe(false);
    expect(isCounted('src/web/layout-extra/page.tsx', exempt)).toBe(true);
    expect(isCounted('src/web/a/page.spec.tsx', [])).toBe(false);
    expect(isCounted('src/web/a/notes.md', [])).toBe(false);
    expect(isCounted('src/web/a/page.ts', [])).toBe(true);
  });
});

describe('readIndex', () => {
  it('reads staged blobs in one batch, not the disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lg-check-'));
    // git exports GIT_INDEX_FILE in pre-commit: the scratch repo must never see the real index.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(k),
      ),
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, env });
    try {
      git('init', '-q');
      writeFileSync(join(dir, 'a.tsx'), 'lg:a\n');
      writeFileSync(join(dir, 'b.tsx'), 'xl:b é\n');
      git('add', 'a.tsx', 'b.tsx');
      writeFileSync(join(dir, 'a.tsx'), 'changed on disk');
      const staged = readIndex(['a.tsx', 'b.tsx'], { cwd: dir, env });
      expect([...staged]).toEqual([
        ['a.tsx', 'lg:a\n'],
        ['b.tsx', 'xl:b é\n'],
      ]);
      expect(() => readIndex(['nope.tsx'], { cwd: dir, env })).toThrow(
        /not in the index/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
