import type { Child } from 'hono/jsx';
import { t } from './i18n';

/**
 * A post form's labelled field: the garment, capsule, trip, "Bought it",
 * repair, Sizes and link-import forms. A refused post re-renders its page
 * (400) with each field's messages; while a field has any, its control is
 * red, `aria-invalid` and described by them, and they are announced
 * (role="alert"). Those spellings live only here (guards.conf
 * `@field-invalid`): copies of this markup had drifted, half of them red
 * without `aria-invalid`, the others with messages a screen reader never
 * announced. The account forms are not these: their messages sit in slots
 * the inline check refills (src/web/auth/form.tsx).
 */

function hasMessages(messages?: string[]): boolean {
  return (messages?.length ?? 0) > 0;
}

function messagesId(id: string): string {
  return `${id}-messages`;
}

/**
 * A bordered input's `id`, classes and aria, spread onto the control inside
 * a FormField of the same `id` and `messages`. `sizing` is its width
 * ("w-full", "w-28", "join-item flex-1").
 */
export function inputAttributes(
  id: string,
  sizing: string,
  messages?: string[],
) {
  const invalid = hasMessages(messages);
  return {
    id,
    class: `input input-bordered ${sizing}${invalid ? ' input-error' : ''}`,
    'aria-invalid': invalid ? ('true' as const) : undefined,
    'aria-describedby': invalid ? messagesId(id) : undefined,
  };
}

/**
 * The label above the control (`children`, whose id is `id`) and the
 * messages under it. `required` marks the label only (" *"); the control
 * carries its own `required`.
 */
export function FormField(props: {
  id: string;
  label: string;
  required?: boolean;
  messages?: string[];
  /** Classes beside `flex flex-col`: "min-w-0" in a grid cell. */
  class?: string;
  children: Child;
}) {
  const { id } = props;
  return (
    <div class={props.class ? `flex flex-col ${props.class}` : 'flex flex-col'}>
      <label class="label" for={id}>
        <span class="label-text">
          {props.required ? `${props.label} *` : props.label}
        </span>
      </label>
      {props.children}
      <FieldMessages id={id} messages={props.messages} />
    </div>
  );
}

/**
 * A field's messages, under FormField's control or, for a control no
 * `<label for>` can name (the garment form's colour dropdown), under it.
 */
export function FieldMessages(props: { id: string; messages?: string[] }) {
  if (!hasMessages(props.messages)) return null;
  return (
    <div id={messagesId(props.id)}>
      {props.messages?.map((message) => (
        <p class="text-error text-sm mt-1" role="alert">
          {message}
        </p>
      ))}
    </div>
  );
}

/**
 * A labelled row of chips (checkbox or radio inputs styled as buttons):
 * the garment form's properties and the style profile. `hint` is a line
 * between the label and the chips.
 */
export function ChipGroup(props: {
  label: string;
  hint?: string;
  children: Child;
}) {
  return (
    <div role="group" aria-label={props.label} class="flex flex-col">
      <span class="label">
        <span class="label-text">{props.label}</span>
      </span>
      {props.hint && <p class="text-xs text-muted mb-1">{props.hint}</p>}
      <div class="flex flex-wrap gap-2">{props.children}</div>
    </div>
  );
}

/**
 * One choice among `options` as radio chips (real focusable inputs named by
 * `aria-label`), and a clear chip (value '') while something is chosen:
 * radios cannot be unchecked, and a choice must stay settable back to unset.
 * The garment form's properties and the grid's filter sheet.
 */
export function Chips(props: {
  name: string;
  options: readonly (string | number)[];
  selected: string;
  label: (option: string | number) => string;
}) {
  return (
    <>
      {props.selected && (
        <input
          type="radio"
          name={props.name}
          value=""
          class="btn btn-sm btn-ghost rounded-full"
          aria-label={`× ${t('CLEAR_CHOICE')}`}
        />
      )}
      {props.options.map((option) => (
        <input
          type="radio"
          name={props.name}
          value={String(option)}
          class="btn btn-sm rounded-full"
          aria-label={props.label(option)}
          checked={props.selected === String(option)}
        />
      ))}
    </>
  );
}
