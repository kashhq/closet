import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { createGarment } from './support/e2e-data';
import {
  registerElsewhere,
  SAME_ORIGIN,
  signIn,
  submitLogin,
} from './support/e2e-session';

/**
 * Sharing a wardrobe, as the grantee sees it on a phone: the invite opened
 * signed out survives signing in (#661), Accept opens the grantor's
 * wardrobe, and the title's switcher opens it as a boosted swap (the
 * document and the service worker's page stay; the mark below proves it).
 * The share's lifecycle and permissions are
 * test/integration/share-lifecycle.spec.ts. Then the owner's public link to
 * one garment (#669): Share, opened signed out, Stop, and the link is gone
 * (test/integration/share-page.spec.ts holds the rest).
 */

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __sameDocument?: boolean }).__sameDocument = true;
  });
}

async function expectSameDocument(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as Window & { __sameDocument?: boolean }).__sameDocument,
    ),
  ).toBe(true);
}

test('an invite opened signed out is accepted in one pass, the shared wardrobe is a boosted swap, and a public link ends at Stop', async ({
  page,
  browser,
  playwright,
}) => {
  await signIn(page, 'nav-switch-owner');
  const coatId = await createGarment(page, 'Shared coat');
  const invite = await page.request.post('/wardrobe-share/create-invite-link', {
    form: { permission: 'VIEW' },
    headers: { ...SAME_ORIGIN, 'hx-request': 'true' },
  });
  const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    await invite.text(),
  )?.[1];
  expect(token).toBeDefined();

  // The partner already has an account, and opens the link signed out.
  const granteeEmail = await registerElsewhere(
    playwright,
    'nav-switch-grantee',
  );
  const granteeContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const grantee = await granteeContext.newPage();
  const invitePage = `/wardrobe-share/invite/${token}`;
  await grantee.goto(invitePage);
  await grantee.locator('main').getByRole('link', { name: 'Sign in' }).click();
  await submitLogin(grantee, granteeEmail);
  // Back on the invite, signed in: Accept is one tap.
  await expect(grantee).toHaveURL(new RegExp(`${invitePage}$`));
  await grantee.getByRole('button', { name: 'Accept' }).click();
  await expect(grantee).toHaveURL(/\/wardrobe\?ownerId=\d+$/);
  await expect(grantee.getByText('Shared coat')).toBeVisible();

  await grantee.goto('/wardrobe');
  await markDocument(grantee);
  // The switcher is the title's menu (R3, #83).
  await grantee.locator('#title-menu summary').click();
  await grantee
    .locator('#title-menu')
    .getByRole('link', { name: /Can edit|Can view/ })
    .click();

  await expect(grantee).toHaveURL(/\/wardrobe\?ownerId=\d+$/);
  await expect(grantee.getByText('Shared coat')).toBeVisible();
  await expect(
    grantee.getByRole('heading', { level: 1, name: /’s wardrobe$/ }),
  ).toBeVisible();
  await expectSameDocument(grantee);
  await granteeContext.close();

  // The coat's public link (#669): none until Share, gone after Stop.
  await page.goto(`/wardrobe/${coatId}`);
  const panel = page.locator('[data-public-share]');
  await expect(panel).toHaveCount(0);
  // hx-confirm asks in the app's own sheet (public/js/confirm-sheet.js).
  const confirmSheet = page.locator('#confirm-sheet');
  await page.locator('#garment-menu summary').click();
  await page
    .locator('#garment-menu')
    .getByRole('button', { name: 'Share', exact: true })
    .click();
  await confirmSheet.locator('[data-confirm-accept]').click();
  await expect(panel).toBeVisible();
  // The link is on SITE_URL (https in the PWA run): open its path here.
  const link = new URL(await panel.locator('input').inputValue());
  const visitorContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${link.pathname}${link.search}`);
  await expect(visitor.getByText('Shared coat')).toBeVisible();

  await panel.getByRole('button', { name: 'Stop sharing' }).click();
  await confirmSheet.locator('[data-confirm-accept]').click();
  await expect(panel).toHaveCount(0);
  const gone = await visitor.goto(`${link.pathname}${link.search}`);
  expect(gone?.status()).toBe(404);
  await expect(visitor.getByText('Shared coat')).toHaveCount(0);
  await visitorContext.close();
});
