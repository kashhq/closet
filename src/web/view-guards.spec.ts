import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../project-root';

// guards.conf's [web-views] section judges one module per rule (the kit has
// no "any .tsx" predicate), so a view file without its line is unguarded.
const conf = readFileSync(join(PROJECT_ROOT, 'scripts/ci/guards.conf'), 'utf8');
const ruled = (id: string) => conf.includes(`\n@${id} `);

function viewModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return viewModules(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.spec.tsx')
      ? [relative(join(PROJECT_ROOT, 'src/web'), path).replace(/\.tsx$/, '')]
      : [];
  });
}

describe('guards.conf [web-views]', () => {
  const modules = viewModules(join(PROJECT_ROOT, 'src/web'));

  it('has a @view line for every view module but errors.tsx', () => {
    const missing = modules
      .filter((m) => m !== 'errors' && !ruled(`view.${m.replaceAll('/', '.')}`))
      .map((m) => `@view.${m.replaceAll('/', '.')}`);
    expect(missing).toEqual([]);
  });

  it("has a @page line for every feature's page and routes module", () => {
    const missing = modules
      .filter((m) => /(^|\/)(routes|[^/]+-routes|[^/]+-page)$/.test(m))
      .filter((m) => m.split('/').length > 1 && !m.startsWith('layout/'))
      .filter((m) => !ruled(`page.${m.replaceAll('/', '.')}`))
      .map((m) => `@page.${m.replaceAll('/', '.')}`);
    expect(missing).toEqual([]);
  });
});
