import type { Child } from 'hono/jsx';
import { Icon } from '../layout/icon';

/**
 * Building blocks of the account forms (login, registration, email,
 * password, deletion). Every form posts natively (`hx-boost="false"`): a
 * refusal answers 4xx with the page re-rendered as a document of its own,
 * and a real form submission is what makes browsers offer to save or update
 * the password (`PostForm`, src/web/form.tsx, is the one native post). A boosted registration never did, which cost the owner an
 * account generated and forgotten by the browser.
 */

export interface FieldProps {
  /** Also the input's name: browsers and password managers key on both. */
  id: string;
  label: string;
  type: 'email' | 'password' | 'text';
  /** https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill */
  autocomplete: 'username' | 'current-password' | 'new-password';
  value?: string;
  errors?: string[];
  minlength?: number;
}

/**
 * The signed-in account's address beside a current-password field, for
 * password managers to know whose password it is: readonly, never shown,
 * the one hidden control of the step-up forms (closet/no-hidden-control).
 */
export function UsernameTwin(props: { email: string | null | undefined }) {
  return (
    <input
      type="text"
      name="username"
      autocomplete="username"
      value={props.email ?? ''}
      // eslint-disable-next-line closet/no-hidden-control -- a password manager's reading, never a person's control
      class="hidden"
      readonly
    />
  );
}

/** A labelled input with its messages underneath; the input turns red with them. */
export function Field(props: FieldProps) {
  const invalid = (props.errors?.length ?? 0) > 0;
  return (
    <>
      <label class="label" for={props.id}>
        {props.label}
      </label>
      <label class={invalid ? 'input input-error' : 'input'}>
        <input
          id={props.id}
          name={props.id}
          type={props.type}
          value={props.value}
          placeholder={props.label}
          autocomplete={props.autocomplete}
          minlength={props.minlength}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby={`${props.id}-errors`}
          required
        />
      </label>
      <MessageSlot field={props.id} messages={props.errors} />
    </>
  );
}

/**
 * A field's messages, in a slot the inline check can refill: rendered
 * (empty) under every field, and answered by the validate routes with
 * `oob` set, so htmx swaps each slot by id and leaves the inputs and the
 * submit button alone. Replacing those instead raced the user: a check
 * answering between mousedown and click (the click blurs the last input,
 * which triggers it) swapped the button away and the form never submitted.
 */
function MessageSlot(props: {
  field: string;
  messages?: string[];
  oob?: boolean;
}) {
  return (
    <div
      id={`${props.field}-errors`}
      aria-live="polite"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      {props.messages?.map((message) => (
        <p class="text-error">{message}</p>
      ))}
    </div>
  );
}

/**
 * The answer to an inline check: every field's message slot, out of band,
 * so a field that is fine again has its old messages cleared.
 */
export function InlineErrors<Field extends string>(props: {
  fields: readonly Field[];
  errors: Partial<Record<Field, string[]>>;
}) {
  return (
    <>
      {props.fields.map((field) => (
        <MessageSlot field={field} messages={props.errors[field]} oob />
      ))}
    </>
  );
}

/** The one message a refused submission shows above the form. */
export function ErrorAlert({ message }: { message: string }) {
  return (
    <div role="alert" class="alert alert-error mb-4 w-full max-w-xs">
      <Icon
        paths="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
        class="size-6 shrink-0"
        weight="2"
      />
      <span>{message}</span>
    </div>
  );
}

export interface FieldsetProps {
  legend: string;
  /**
   * Inline validation: on every change the fieldset posts the form here;
   * the answer is only FieldErrors slots, swapped out of band (the fieldset
   * itself swaps nothing).
   */
  validateUrl?: string;
  /**
   * No frame of its own: the caller's card is the frame (the sign-in
   * pages' `SignedOutFrame`), since a browser draws a legend straddling a
   * fieldset's border, over the card's edge.
   */
  bare?: boolean;
  children: Child;
}

export function Fieldset(props: FieldsetProps) {
  return (
    <fieldset
      class={
        props.bare
          ? 'fieldset'
          : 'fieldset bg-base-200 border-base-300 rounded-box w-full max-w-xs border p-4'
      }
      hx-post={props.validateUrl}
      hx-trigger={props.validateUrl ? 'change' : undefined}
      hx-swap={props.validateUrl ? 'none' : undefined}
    >
      <legend class="fieldset-legend">{props.legend}</legend>
      {props.children}
    </fieldset>
  );
}

/**
 * Never disabled by the inline check: that check runs on `change`, so it
 * lags the last keystroke, and a button dimmed by a stale answer swallowed
 * the very click that would have re-run it. The server validates the
 * submission anyway.
 */
export function SubmitButton(props: { label: string; variant?: 'error' }) {
  const color = props.variant === 'error' ? 'btn-error' : 'btn-primary';
  return (
    <button type="submit" class={`btn ${color} mt-4`}>
      {props.label}
    </button>
  );
}

/**
 * One token scope checkbox, a toggle as the garment form's booleans are:
 * Agent Access's create form (tokens-page.tsx) and the OAuth consent page
 * (src/web/oauth/consent-page.tsx).
 */
export function ScopeToggle({
  name,
  label,
  hint,
  checked,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
}) {
  return (
    <label class="label cursor-pointer justify-start items-start gap-3 whitespace-normal">
      <input
        type="checkbox"
        name={name}
        value="on"
        class="toggle toggle-sm mt-0.5"
        checked={checked}
      />
      <span class="flex flex-col gap-0.5">
        <span class="label-text">{label}</span>
        <span class="text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}
