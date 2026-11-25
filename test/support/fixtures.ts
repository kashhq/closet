import { expect, test as base } from '@playwright/test';

// What the init script below prefixes a violation it reports with.
const CSP_VIOLATION = '[csp-violation]';

/**
 * Every spec's `test`: the scenario fails if the app raises a native dialog
 * (alert, confirm, prompt; the app asks through its own sheet,
 * public/js/confirm-sheet.js, #686: the browser's box is the server host's
 * unstyled title) or if any page of its context breaks the CSP (#672: the
 * policy allows no inline script, src/web/security/csp.ts). A violation is
 * caught twice over: the document's `securitypolicyviolation` event, which
 * every engine fires and the init script logs, and the engine's own console
 * line. Specs import `test` and `expect` from here, never from
 * @playwright/test; a context a spec makes itself (`browser.newContext()`)
 * is its own to watch.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    const violations: string[] = [];
    await context.addInitScript((prefix: string) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(
          `${prefix} ${event.effectiveDirective} blocked ${event.blockedURI || 'inline'} at ${event.sourceFile}:${event.lineNumber}`,
        );
      });
    }, CSP_VIOLATION);
    context.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (
        text.startsWith(CSP_VIOLATION) ||
        /Content[- ]Security[- ]Policy/i.test(text)
      ) {
        violations.push(text);
      }
    });
    await use(context);
    expect(violations, 'CSP violations in the console').toEqual([]);
  },
  page: async ({ page }, use) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await use(page);
    expect(dialogs, 'native dialogs the app raised').toEqual([]);
  },
});

export { expect };
