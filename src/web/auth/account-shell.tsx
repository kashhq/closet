import type { Child } from 'hono/jsx';
import { BrandMark } from '../layout/brand-mark';
import { PageShell } from '../layout/page-shell';
import type { ViewContext } from '../view-context';

/**
 * A one-form page: sign in, register, the account's forms, and Sharing's
 * edit-link step-up (its own module so sharing/pages.tsx, which Profile
 * imports, can use it without an import cycle through auth/pages.tsx). A
 * preset of `PageShell`'s `centred` layout, which also centres it below the
 * app bar while it fits and starts it at the top once it does not.
 */
export function AccountShell(props: {
  ctx: ViewContext;
  /** The app bar's title, the page's h1. */
  title: string;
  /** The back arrow (the account's forms go back to Profile). */
  back?: string;
  /** Sign in and register: where signing in lands (return-to.ts). */
  returnTo?: string;
  /**
   * A public entry page's (sign in, register) link preview: the og tags
   * and the schema.org WebPage, both named by `ogTitle`, which stays meta
   * only: the h1 is `title`.
   */
  preview?: { ogTitle: string; description: string };
  children: Child;
}) {
  const { preview } = props;
  return (
    <PageShell
      ctx={props.ctx}
      name="account"
      layout="centred"
      title={preview?.ogTitle ?? props.title}
      meta={
        preview && {
          ogTitle: preview.ogTitle,
          ogDescription: preview.description,
          webPage: true,
        }
      }
      bar={{
        title: props.title,
        back: props.back,
        returnTo: props.returnTo,
      }}
    >
      {!props.ctx.user && <BrandMark ctx={props.ctx} />}
      {props.children}
    </PageShell>
  );
}
