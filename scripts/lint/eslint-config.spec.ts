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

describe('HttpError message is copy', () => {
  it.each([
    ["new HttpError(404, 'Gone')", 'a literal'],
    ['new HttpError(404, `Gone ${x}`)', 'a template'],
    ["new HttpError(404, 'Gone ' + x)", 'a concatenation'],
    ["new errors.HttpError(404, 'Gone')", 'a namespaced class'],
    [
      "class Gone extends HttpError { constructor() { super(404, 'Gone'); } }",
      'a subclass super call',
    ],
    [
      "class Gone extends HttpError { constructor() { super(404, 'Gone ' + x); } }",
      'a subclass concatenation',
    ],
  ])('refuses %s (%s)', async (code) => {
    const messages = await lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("An HttpError's message is copy");
  });

  it.each([
    "new HttpError(404, t('refusal.GONE'))",
    'new HttpError(404, message)',
    'new HttpError(404)',
    "new errors.HttpError(404, t('refusal.GONE'))",
    "class Gone extends HttpError { constructor() { super(404, t('refusal.GONE')); } }",
    "class Other extends Error { constructor() { super('Gone', 'x'); } }",
  ])('lets %s through', async (code) => {
    expect(await lint(code)).toEqual([]);
  });
});
