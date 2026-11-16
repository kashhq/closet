import type { Child } from 'hono/jsx';
import { PostForm } from '../form';
import type { ViewContext } from '../view-context';
import { PageShell } from './page-shell';
import { CancelLink } from './parts';

/**
 * The frame of an add or edit page that is one native post (#411): the
 * garment, capsule and trip forms, "Bought it" and the share confirmation.
 * A preset of `PageShell` (narrow, `single`). The app bar marks it a `formPage`, the fields post through one
 * `PostForm`, and Cancel (back past the form) sits beside the submit.
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
  /** Above the form: an intro line, the garment form's draft queue. */
  intro?: Child;
  /** The edit page's Delete (an `hx-delete`, confirmed first). */
  remove?: { url: string; confirm: string; label: string };
  /** Below the form, outside it: the garment form's own forms. */
  after?: Child;
  children: Child;
}) {
  const { ctx, title, back, remove } = props;
  return (
    <PageShell ctx={ctx} title={title} bar={{ title, back, formPage: true }}>
      {props.intro}
      <PostForm
        action={props.action}
        multipart={props.multipart}
        class="flex flex-col gap-4"
      >
        {props.children}
        <div class="flex gap-2 mt-2">
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
          data-needs-network=""
        >
          {remove.label}
        </button>
      )}
    </PageShell>
  );
}
