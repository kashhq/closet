// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import base, {
  sonarjsRules,
  sonarjsTestRules,
} from './devkit/lint/eslint.base.mjs';
import webImports from './scripts/lint/web-imports.mjs';

// esquery regexes (no `/` inside) for the theme rule in no-restricted-syntax.
const PALETTE_CLASS =
  '/\\b(?:(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d{2,3}|(?:bg|text|border|fill|stroke)-(?:white|black))\\b/';
// A shadow class on anything but a floating layer: a dropdown, a toast (an
// alert) or a sheet (modal-box). The theme is flat (#727); a card is `Card`.
// The lookahead lets a string naming one of those through. A class token is
// `shadow` bare or `shadow-*`, with an optional `inset-`, `text-` or `drop-`
// (a drop shadow is a shadow too) and any variant prefix (`hover:`).
const SHADOW_CLASS =
  '/^(?![^]*(?:dropdown-content|\\balert\\b|modal-box))[^]*(?:^|[\\s:])(?:(?:inset|text|drop)-)?shadow(?:-\\S+)?(?=\\s|$)/';
const FLAT_THEME =
  'The theme is flat (views/assets/AGENTS.md, Cards): no shadow outside a dropdown, a toast or a sheet. A card is src/web/card.tsx (#727).';
const RETIRED_CHIP_CLASS = '/\\bchip-\\d\\b/';
const INLINE_COLOUR =
  '/#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\\(/';
const THEME_TOKENS_ONLY =
  'Colours come from the daisyUI theme tokens in views/assets/main.css (bg-base-200, text-error), never a palette class or an inline colour (#81).';
// text-base-content/0 to /69; \x2F is the slash, which an esquery regex
// cannot hold.
const FAINT_TEXT_CLASS = '/\\btext-base-content\\x2F(?:\\d|[1-6]\\d)\\b/';
const MUTED_TEXT =
  'Muted text is text-muted (WCAG AA on every base in both themes); a decorative graphic that carries no information is text-faint (views/assets/main.css, #88).';

// no-restricted-syntax entries every file obeys, then the HttpError copy
// rule, which specs are exempt from (their fixtures carry arbitrary messages).
const RESTRICTED_SYNTAX = [
  {
    selector:
      "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.callee.property.name='toISOString']",
    message:
      "A UTC date is not the household's day: use todayIn(APP_TIMEZONE, now) (AGENTS.md, Gotchas).",
  },
  {
    selector: "CallExpression[callee.property.name='toLocaleDateString']",
    message:
      'A day from an instant comes from todayIn(APP_TIMEZONE, now) (AGENTS.md, Gotchas).',
  },
  // Colour comes from the two daisyUI themes in views/assets/main.css
  // (#81): semantic tokens only (bg-base-200, text-error), so both
  // schemes and every contrast figure hold. A Tailwind palette class
  // or a colour in a style attribute is the same in light and dark.
  // The retired calendar chips (chip-0..5) cycled hues per entry.
  ...[PALETTE_CLASS, RETIRED_CHIP_CLASS].flatMap((pattern) => [
    {
      selector: `Literal[value=${pattern}]`,
      message: THEME_TOKENS_ONLY,
    },
    {
      selector: `TemplateElement[value.raw=${pattern}]`,
      message: THEME_TOKENS_ONLY,
    },
  ]),
  {
    selector: `Literal[value=${SHADOW_CLASS}]`,
    message: FLAT_THEME,
  },
  {
    selector: `TemplateElement[value.raw=${SHADOW_CLASS}]`,
    message: FLAT_THEME,
  },
  // Below /70 the base content fails AA on some base (#88): muted
  // text is the one text-muted tone, faint the decorative graphics.
  {
    selector: `Literal[value=${FAINT_TEXT_CLASS}]`,
    message: MUTED_TEXT,
  },
  {
    selector: `TemplateElement[value.raw=${FAINT_TEXT_CLASS}]`,
    message: MUTED_TEXT,
  },
  {
    selector: `JSXAttribute[name.name='style'] Literal[value=${INLINE_COLOUR}]`,
    message: THEME_TOKENS_ONLY,
  },
  {
    selector: `JSXAttribute[name.name='style'] TemplateElement[value.raw=${INLINE_COLOUR}]`,
    message: THEME_TOKENS_ONLY,
  },
];

const HTTP_ERROR_COPY = [
  // An HttpError's message is shown to the person (or the agent), so it
  // is copy: a `t('refusal.*')` key in src/i18n/en/lang.json (#734),
  // never an English literal. Omit it for the status text.
  ...['Literal', 'TemplateLiteral'].map((type) => ({
    selector: `NewExpression[callee.name='HttpError'][arguments.1.type='${type}']`,
    message:
      "An HttpError's message is copy: t('refusal.*') from src/i18n/en/lang.json, not a literal (#734).",
  })),
];

const HONO_RAW_HTML_PATHS = [
  {
    name: 'hono/html',
    message:
      'Use dangerouslySetInnerHTML, the one raw-HTML escape hatch (AGENTS.md, Web layer).',
  },
  {
    name: 'hono/utils/html',
    message:
      'Use dangerouslySetInnerHTML, the one raw-HTML escape hatch (AGENTS.md, Web layer).',
  },
];

// Bare spellings of the Node builtins that `node:*` also covers.
const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'crypto',
  'child_process',
  'os',
  'http',
  'https',
  'net',
];
const NO_IO =
  'The pure layers do no I/O and read no clock, environment or crypto: the caller passes it in (docs/web-layer.md).';

export default tseslint.config(
  {
    // The cutout-children are stand-in model processes (plain .mjs, outside
    // the TypeScript project): lint:check never covered them, and devkit's
    // changed-lint failed to parse one whenever it changed.
    ignores: [
      'eslint.config.mjs',
      'scripts/lint/web-imports.mjs',
      './test/support/legacy-migrations/**/*',
      './test/fixtures/cutout-children/*.mjs',
    ],
  },
  // devkit's base first (devkit/lint/README.md): no-console, no-eval, no-implied-eval and the
  // innerHTML / outerHTML / insertAdjacentHTML sinks. Later layers relax it per glob.
  ...base,
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // Turns off the stylistic rules prettier owns; prettier itself runs as format:check (Makefile ci-lint).
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // My custom rules
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-unsafe-optional-chaining': 'off',
      complexity: ['warn', { max: 10 }],
      'max-depth': ['warn', { max: 3 }],
      // One assertion style: `<T>value` does not parse in .tsx files, so
      // `as` everywhere.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as' },
      ],
      // "Today" and every day from an instant come from todayIn() at
      // APP_TIMEZONE (src/calendar-date.ts; t.today() in the
      // integration specs, householdToday() in Playwright's). A UTC date is
      // tomorrow every evening in New York: main went red at 00:01 UTC.
      'no-restricted-syntax': [
        'error',
        ...RESTRICTED_SYNTAX,
        ...HTTP_ERROR_COPY,
      ],
      // hono/jsx escapes every text child and attribute value. The one way to
      // emit markup as-is is `dangerouslySetInnerHTML` (greppable, reviewed
      // per use; see AGENTS.md, Web layer). hono's `raw()` would be a second,
      // quieter hatch.
      'no-restricted-imports': [
        'error',
        {
          paths: HONO_RAW_HTML_PATHS,
        },
      ],
    },
  },

  // The pure layers (docs/web-layer.md, Code no feature owns): rules over
  // plain values, no HTTP, no database, no I/O, so they run in a unit test
  // without a mock and any feature can import them. They sit below
  // src/web/ and src/db/; a dependency pointing up is a layering bug, so
  // the shared type or helper moves down (src/calendar-date.ts) or the code
  // is made generic over the caller's type (InsightGarment<Photo>). Specs
  // are exempt: they build fixtures. A flat-config rule replaces the earlier
  // block's, so the hono paths are repeated from the shared const.
  {
    files: ['src/wardrobe/**/*.ts', 'src/weather/**/*.ts', 'src/push/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...HONO_RAW_HTML_PATHS,
            {
              name: 'drizzle-orm',
              message: 'The pure layers hold no queries (src/db/AGENTS.md).',
            },
            ...NODE_BUILTINS.map((name) => ({
              name,
              message: NO_IO,
            })),
          ],
          patterns: [
            {
              group: ['**/web', '**/web/**'],
              message:
                'The pure layers sit below src/web/: move the shared code down to src/ or make it generic over the caller type (docs/web-layer.md).',
            },
            {
              group: ['**/db', '**/db/**', 'drizzle-orm/*'],
              message:
                'The pure layers hold no queries: the caller reads rows and passes plain values (docs/web-layer.md).',
            },
            { group: ['node:*'], message: NO_IO },
          ],
        },
      ],
    },
  },
  // The web layer's import direction (#718, docs/web-layer.md, Code no feature owns): no
  // intra-web layers, but a feature never draws another feature's page or routes module, and the
  // API and agent surfaces never import a view. Resolved on disk by scripts/lint/web-imports.mjs
  // (direct imports only). Specs build fixtures and are exempt.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.spec.{ts,tsx}'],
    plugins: { closet: webImports },
    rules: { 'closet/no-foreign-page-import': 'error' },
  },
  {
    files: [
      'src/web/**/api-routes.ts',
      'src/web/**/*-resource.ts',
      'src/web/**/*-api-input.ts',
      'src/web/api/**/*.ts',
      'src/web/sync/**/*.ts',
      'src/web/mcp/**/*.ts',
    ],
    ignores: ['**/*.spec.ts'],
    plugins: { closet: webImports },
    rules: { 'closet/no-view-import': 'error' },
  },
  // devkit's sonarjs rule maps (devkit/lint/README.md "sonarjs"). The plugin must be registered
  // in the same files scope as its rules, so it is registered here for every linted file.
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { sonarjs },
    rules: sonarjsRules,
  },
  {
    files: ['**/*.spec.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX] },
  },
  // Repeated literals in specs (titles, fixture ids, expected text) are the readable form.
  {
    files: ['test/**/*.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: sonarjsTestRules,
  },
  {
    // The base's no-console holds app code to its module's pino logger
    // (src/logger.ts; a CLI's result goes to process.stdout.write, a fatal
    // before the configuration loads to createBootLogger()). scripts/ and
    // test/ are tooling: the console is their interface.
    files: ['scripts/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    rules: { 'no-console': 'off' },
  },
  {
    // The integration project shares each worker's module graph across spec
    // files (vitest.config.mts, isolate: false). A module mock outlives its
    // file and never reaches a module an earlier file already loaded, so it
    // would pass or fail by which files share the worker. Pass a stand-in
    // through createTestApp's options instead (AppOptions in src/app.ts).
    // A flat-config rule replaces the earlier block's, so the base's HTML
    // sinks are carried over before the vi bans.
    files: ['test/integration/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        ...base[0].rules['no-restricted-properties'],
        ...['mock', 'doMock', 'unmock', 'doUnmock', 'resetModules'].map(
          (property) => ({
            object: 'vi',
            property,
            message:
              'Integration specs share a module graph per worker (vitest.config.mts): pass a stand-in through createTestApp options.',
          }),
        ),
      ],
    },
  },
);
