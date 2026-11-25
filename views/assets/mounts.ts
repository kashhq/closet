/**
 * The engine of page-mount.ts (views/assets/page/page-mount.ts), apart from
 * its table so a browser spec can drive it with a table of its own
 * (`page-mount.browser.spec.ts`): the page build bundles every `page/*.ts`,
 * and the real table imports the importmap's bare names.
 *
 * Every element marked `data-page-module` is mounted once: on the document
 * already parsed when this runs (a module script runs after parsing), then
 * within every `htmx:load`, which htmx fires on what a swap, a boosted
 * navigation or a history restore inserted, and once on the body at its
 * start. A mounted element is remembered (a WeakSet, so a removed one is
 * forgotten with it), so the body's `htmx:load`, an ancestor's, or a
 * subtree loaded twice mounts nothing again; an element htmx puts in an
 * old one's place is a new element and mounts afresh.
 */

import { PAGE_MODULE, type PageModule } from '../../src/web/page-contract';

/** Sets up one marked element; a rejection is logged, never thrown. */
export type Mount = (element: HTMLElement) => unknown;

export type MountTable = Readonly<Record<PageModule, Mount>>;

const MARKED = `[${PAGE_MODULE}]`;

export function watchMounts(table: MountTable): void {
  const mounted = new WeakSet<Element>();

  const mount = (element: HTMLElement) => {
    if (mounted.has(element)) return;
    mounted.add(element);
    const name = element.getAttribute(PAGE_MODULE) as PageModule;
    const run = Object.hasOwn(table, name) ? table[name] : undefined;
    if (!run) {
      // A page from another build than this document's scripts (the update
      // toast's reload heals it), or a typo the contract's type let through.
      console.warn(`[page-mount] no module named "${name}"`);
      return;
    }
    Promise.resolve()
      .then(() => run(element))
      .catch((error: unknown) => {
        console.error(`[page-mount] ${name} failed to mount`, error);
      });
  };

  const mountWithin = (root: Element) => {
    if (root instanceof HTMLElement && root.matches(MARKED)) mount(root);
    for (const element of root.querySelectorAll<HTMLElement>(MARKED)) {
      mount(element);
    }
  };

  document.addEventListener('htmx:load', (event) => {
    if (event.target instanceof Element) mountWithin(event.target);
  });
  mountWithin(document.documentElement);
}
