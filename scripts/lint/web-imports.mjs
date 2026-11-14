// Two ESLint rules for src/web's import direction (#718; docs/web-layer.md, Code no feature owns).
// They resolve a relative specifier on disk, because `no-restricted-imports` only sees the
// specifier's text and an import never says `.tsx`. Direct imports only: a view reached through
// a re-export is not followed. Type-only imports are erased at runtime, so they are not judged.
import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const WEB = resolve(ROOT, 'src/web');
const PLUGIN = resolve(WEB, 'plugin.ts');
const SUFFIXES = ['.tsx', '.ts', `${sep}index.tsx`, `${sep}index.ts`];
// A feature's page or routes module: what no other feature may draw.
const PAGE_MODULE = /(^|[\\/])(routes|[^\\/]+-routes|[^\\/]+-page)\.tsx$/;
// Shared view pieces, not a feature's pages (layout/form-page.tsx is FormPage).
const SHARED_DIRS = new Set(['layout']);

// The exact file first (`./x.tsx`), then the ESM spelling of a TypeScript file (`./x.js` for
// x.ts or x.tsx), then the extensionless suffixes.
function resolved(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [base];
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -'.js'.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  candidates.push(...SUFFIXES.map((suffix) => base + suffix));
  return (
    candidates.find((file) => existsSync(file) && statSync(file).isFile()) ??
    null
  );
}

/** `src/web/<feature>/...` -> the feature's directory name; null for the web root and non-web files. */
function featureOf(file) {
  const inside = relative(WEB, file);
  if (inside.startsWith('..')) return null;
  const [first, ...rest] = inside.split(sep);
  return rest.length > 0 ? first : null;
}

function importedModules(node) {
  switch (node.type) {
    case 'ImportDeclaration':
      return node.importKind === 'type' ? [] : [node.source];
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      return node.source && node.exportKind !== 'type' ? [node.source] : [];
    case 'ImportExpression':
      return node.source.type === 'Literal' ? [node.source] : [];
    default:
      return [];
  }
}

function importRule(messages, judge) {
  return {
    meta: { type: 'problem', schema: [], messages },
    create(context) {
      const check = (node) => {
        for (const source of importedModules(node)) {
          const target = resolved(context.filename, String(source.value));
          const messageId = target && judge(context.filename, target);
          if (messageId) context.report({ node: source, messageId });
        }
      };
      return {
        ImportDeclaration: check,
        ExportNamedDeclaration: check,
        ExportAllDeclaration: check,
        ImportExpression: check,
      };
    },
  };
}

export default {
  rules: {
    // The API and agent surfaces take wire schemas and rules from non-view modules, so they
    // never pull a page's markup (and its queries) into the JSON contract.
    'no-view-import': importRule(
      {
        view: "The API and MCP surfaces import no .tsx view: move the schema or rule they need into a non-view module (place-input.ts, outfit-list.ts). errors.tsx is the one exception: HttpError is the web layer's error contract (docs/web-layer.md, Code no feature owns).",
      },
      (_from, target) =>
        target.endsWith('.tsx') && target !== resolve(WEB, 'errors.tsx')
          ? 'view'
          : null,
    ),
    // Features share queries, writers, urls and status basics, never pages: a view imported
    // across features drags its queries along.
    'no-foreign-page-import': importRule(
      {
        page: "A feature's page or routes module is imported only by its own feature and src/web/plugin.ts: move the shared piece to a shared view module (src/web/ root or layout/) (docs/web-layer.md, Code no feature owns).",
      },
      (from, target) => {
        if (!PAGE_MODULE.test(target) || from === PLUGIN) return null;
        const owner = featureOf(target);
        if (owner === null || SHARED_DIRS.has(owner)) return null;
        return featureOf(from) === owner ? null : 'page';
      },
    ),
  },
};
