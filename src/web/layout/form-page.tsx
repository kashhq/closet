import type { Child } from 'hono/jsx';
import { PostForm } from '../form';
import type { ViewContext } from '../view-context';
import { type PageLayout, PageShell } from './page-shell';
import { CancelLink } from './parts';
import { needsNetwork } from '../page-contract';

/**
 * The frame of an add or edit page that is one native post (#411): the
 * garment, capsule and trip forms, "Bought it" and the share confirmation.
 * A preset of `PageShell`: a form is one narrow reading column at every
 * width (`single`), or, with an `aside`, that column beside its subject
 * from lg (`split`, #1069: the garment form's photo), the subject hidden
 * below lg, so a phone sees the form it always did. The app bar marks it a
 * `formPage`, the fields post through one `PostForm`, and Cancel (back past
 * the form) sits beside the submit; from lg that row sticks at the foot of
 * the window while the form runs past it (main.css, `.form-actions`).
 *
 * Disabled offline: the form like every PostForm, and the edit page's
 * Delete, an `hx-delete` outside it, by its own `data-needs-network`. A copy
 * the worker cached, opened without a connection, would otherwise post into
 * the worker's offline page and lose what was typed. guards.conf
 * `@form-page` keeps `CancelLink` here, so a new add or edit page starts
 * from this frame.
 */
export function FormPage(props: {
  ctx: ViewContext;
  title: string;
  /** The page's fixed parent: the back arrow's and Cancel's href. */
  back: string;
  action: string;
  /** Posts a file (PostForm's `multipart`): the share confirmation. */
  multipart?: boolean;
  submitLabel: string;
  /**
   * The submit starts disabled, for the page's script to enable once there
   * is something to post (the share confirmation's photo, read on the device).
   */
  submitDisabled?: boolean;
  /**
   * What the form edits, beside it from lg (the garment's photo); outside
   * the form, so it posts nothing. A form without a subject (trip, capsule,
   * "Bought it") passes none.
   */
  aside?: Child;
  /** Above the form: an intro line, the garment form's draft queue. */
  intro?: Child;
  /** The edit page's Delete (an `hx-delete`, confirmed first). */
  remove?: { url: string; confirm: string; label: string };
  /** Below the form, outside it: the garment form's own forms. */
  after?: Child;
  children: Child;
}) {
  const { ctx, title, back, remove } = props;
  const frame: PageLayout = props.aside
    ? { layout: 'split', aside: props.aside, subjectBelowLg: 'hidden' }
    : { layout: 'single', width: 'narrow' };
  return (
    <PageShell
      ctx={ctx}
      name="form"
      {...frame}
      bar={{ title, back, formPage: true }}
    >
      {props.intro}
      <PostForm
        action={props.action}
        multipart={props.multipart}
        class="flex flex-col gap-4"
      >
        {props.children}
        <div class="form-actions flex gap-2 mt-2">
          <CancelLink href={back} class="flex-1" />
          <button
            type="submit"
            class="btn btn-primary flex-1"
            disabled={props.submitDisabled}
          >
            {props.submitLabel}
          </button>
        </div>
      </PostForm>
      {props.after}
      {remove && (
        <button
          type="button"
          class="btn btn-error btn-outline btn-sm w-full mt-8"
          hx-delete={remove.url}
          hx-confirm={remove.confirm}
          {...needsNetwork()}
        >
          {remove.label}
        </button>
      )}
    </PageShell>
  );
}
