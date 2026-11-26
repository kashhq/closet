/* eslint-disable no-restricted-syntax -- the cases are the planted violations the rules must refuse */
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The real flat config, so a selector or regex edit in eslint.config.mjs is
// what fails here. Only no-restricted-syntax messages are read. The file
// path must be one the TypeScript project service knows; its text is replaced.
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

const restricted = async (code: string, file: string) => {
  const [result] = await eslint.lintText(code, {
    filePath: resolve(root, file),
  });
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message);
};

const lint = (code: string) => restricted(code, 'src/web/errors.tsx');

describe('flat theme: shadow classes', () => {
  it.each([
    'shadow',
    'shadow-md',
    'hover:shadow-lg',
    '!shadow-md',
    'md:!shadow-md',
    'shadow-md!',
    'shadow!',
    'p-2 !drop-shadow-lg',
  ])('refuses %s', async (cls) => {
    const messages = await lint(`export const c = '${cls}';`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('The theme is flat');
  });

  it.each(['p-2 shadowless', 'dropdown-content !shadow-md', 'alert shadow-md'])(
    'lets %s through',
    async (cls) => {
      expect(await lint(`export const c = '${cls}';`)).toEqual([]);
    },
  );
});

// closet/no-forged-copy (scripts/lint/forged-copy.mjs, #1100) judges the type
// an assertion makes, so each spelling below is one case. The file must be one
// the project service knows and the rule covers (not i18n.ts, errors.tsx or a
// spec); its text is replaced.
describe('forged copy', () => {
  const forged = async (body: string) => {
    const [result] = await eslint.lintText(
      `import * as i18n from './i18n';\nimport { t, type Translated } from './i18n';\n${body}\n`,
      { filePath: resolve(root, 'src/web/date-labels.ts') },
    );
    return result.messages.filter((m) => m.ruleId === 'closet/no-forged-copy')
      .length;
  };

  it.each([
    "export const a = 'English' as Translated;",
    "export const a = <Translated>'English';",
    "export const a = 'English' as i18n.Translated;",
    "type Copy = Translated;\nexport const a = 'English' as Copy;",
    "export const a = 'English' as never;",
    "export const a = 'English' as any;",
    "export const a = 'English' as unknown as Translated;",
    "export const a = 'English' as Translated | undefined;",
    "export const a = ['English'] as Translated[];",
    "export const a = { message: 'English' } as { message: Translated };",
    'export const a = ((s: string) => s) as (s: string) => Translated;',
    'export const a = new Map() as Map<string, Translated>;',
    'export function as<T>(x: unknown): T {\n  return x as T;\n}',
    'export function as<T extends string>(x: string): T {\n  return x as T;\n}',
    'export function as<T>(x: unknown) {\n  return <T>x;\n}',
    'export const a = (s: string): s is Translated => s.length > 0;',
  ])('refuses %s', async (body) => {
    expect(await forged(body)).toBe(1);
  });

  it.each([
    "export const a = t('ABOUT_TITLE') as string;",
    "export const a = [t('ABOUT_TITLE')] as const;",
    "export const a = 'English' as unknown;",
    "export const a = 'English' as const;",
    "export const a = ['English'] as string[];",
    "export const a = [t('ABOUT_TITLE'), 0].filter((s) => s !== 0);",
  ])('lets %s through', async (body) => {
    expect(await forged(body)).toBe(0);
  });
});

// A file whose program lacks src/web/i18n.ts (the service worker's project,
// views/assets/tsconfig.json) cannot name the brand: brandOf has none, and the
// rule must still judge what needs no brand (any, never, an unconstrained
// type parameter) and not throw (#1108).
describe('forged copy without the brand in the program', () => {
  const forgedHere = async (body: string) => {
    const [result] = await eslint.lintText(`${body}\n`, {
      filePath: resolve(root, 'views/assets/expiration-rows.ts'),
    });
    expect(result.messages.filter((m) => m.fatal)).toEqual([]);
    return result.messages.filter((m) => m.ruleId === 'closet/no-forged-copy')
      .length;
  };

  it.each([
    "export const a = 'English' as never;",
    "export const a = 'English' as any;",
    'export function as<T>(x: unknown): T {\n  return x as T;\n}',
  ])('refuses %s', async (body) => {
    expect(await forgedHere(body)).toBe(1);
  });

  it.each([
    "export const a = 'English' as unknown;",
    "export const a = ['English'] as string[];",
    "export const a = 'English' as const;",
  ])('lets %s through', async (body) => {
    expect(await forgedHere(body)).toBe(0);
  });
});

// closet/no-hidden-control (scripts/lint/hidden-control.mjs, #674) reads every
// class a control's JSX can produce, so a computed `class={...}` is judged as
// a literal one (#1067's clear chip slipped past the grep it replaced). The
// file must be a .tsx under src/web the project service knows; its text is
// replaced.
describe('hidden controls', () => {
  const hidden = async (body: string) => {
    const [result] = await eslint.lintText(`${body}\n`, {
      filePath: resolve(root, 'src/web/form-field.tsx'),
    });
    return result.messages.filter(
      (m) => m.ruleId === 'closet/no-hidden-control',
    ).length;
  };

  it.each([
    'export const a = <input type="radio" class="btn hidden" />;',
    'export const a = <select class="hidden" />;',
    'export const a = (on: boolean) => <input class={on ? "btn" : "btn hidden"} />;',
    'export const a = (on: boolean) => <input class={`btn ${on ? "" : "hidden"}`} />;',
    'export const a = (x: string) => <textarea class={`hidden ${x}`} />;',
    'export const a = (on: boolean) => <input class={on && "hidden"} />;',
    'export const a = (x: string) => <input class={"btn " + "hidden " + x} />;',
    'const CHIP = "btn hidden";\nexport const a = <input class={CHIP} />;',
    'export const a = (x: string) => <input class={[x, "hidden"].join(" ")} />;',
  ])('refuses %s', async (body) => {
    expect(await hidden(body)).toBe(1);
  });

  it.each([
    'export const a = <input type="hidden" name="x" value="" />;',
    'export const a = <input class="lg:hidden btn" />;',
    'export const a = <input class="btn hidden-x" />;',
    'export const a = (x: string) => <input class={`hidden${x}`} />;',
    'export const a = <div class="hidden" />;',
    'export const a = (x: string) => <input class={x === "hidden" ? "btn" : "btn-sm"} />;',
  ])('lets %s through', async (body) => {
    expect(await hidden(body)).toBe(0);
  });
});
