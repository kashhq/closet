import { RuleTester, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { resolve } from 'node:path';
import plugin from './web-imports.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The rules resolve specifiers on disk, so the cases name real files under src/web.
const web = (path: string) =>
  resolve(import.meta.dirname, '../../src/web', path);
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, sourceType: 'module' },
});

const rule = (name: keyof typeof plugin.rules) =>
  plugin.rules[name] as unknown as Rule.RuleModule;

tester.run('no-view-import', rule('no-view-import'), {
  valid: [
    {
      filename: web('outfits/api-routes.ts'),
      code: "import { HttpError } from '../errors';",
    },
    {
      filename: web('outfits/api-routes.ts'),
      code: "import type { X } from './routes';",
    },
    {
      filename: web('outfits/api-routes.ts'),
      code: "import { x } from 'node:path';",
    },
  ],
  invalid: [
    {
      filename: web('outfits/api-routes.ts'),
      code: "import { page } from './routes';",
      errors: [{ messageId: 'view' }],
    },
    {
      filename: web('outfits/api-routes.ts'),
      code: "import { page } from './routes.tsx';",
      errors: [{ messageId: 'view' }],
    },
    {
      filename: web('outfits/api-routes.ts'),
      code: "import { page } from './routes.js';",
      errors: [{ messageId: 'view' }],
    },
  ],
});

tester.run('no-foreign-page-import', rule('no-foreign-page-import'), {
  valid: [
    {
      filename: web('outfits/api-routes.ts'),
      code: "import { r } from './routes';",
    },
    {
      filename: web('plugin.ts'),
      code: "import { r } from './outfits/routes';",
    },
    {
      filename: web('trips/queries.ts'),
      code: "import type { R } from '../outfits/routes';",
    },
    {
      filename: web('trips/queries.ts'),
      code: "import { HttpError } from '../errors';",
    },
  ],
  invalid: [
    {
      filename: web('trips/queries.ts'),
      code: "import { r } from '../outfits/routes';",
      errors: [{ messageId: 'page' }],
    },
    {
      filename: web('trips/queries.ts'),
      code: "import { r } from '../outfits/routes.tsx';",
      errors: [{ messageId: 'page' }],
    },
    {
      filename: web('trips/queries.ts'),
      code: "export { r } from '../outfits/routes.js';",
      errors: [{ messageId: 'page' }],
    },
  ],
});
