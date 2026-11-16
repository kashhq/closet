import {
  type TOptional,
  type TArray,
  type TInteger,
  Type,
} from '@sinclair/typebox';
import { RowId } from './schemas';

/**
 * A checklist's post: the capsule picker, the garment page's capsule
 * toggles, the trip's packing list and extras. A checkbox list posts only
 * what is checked, so each list also posts `shown`, every id it listed.
 * Shown and unchecked is what leaves (`unchecked`); an id the list never
 * showed (a page not scrolled to, a row added meanwhile elsewhere) is left
 * alone. Nothing checked posts no field at all, so the body may be empty.
 * Each listed row carries `ShownId` beside its checkbox; guards.conf
 * `@checklist-shown` keeps `name="shown"` in this module.
 *
 * The checked field keeps each list's own name (`ids`, `capsuleIds`,
 * `packed`): cached pages post it.
 */

type CheckedIds = TOptional<TArray<TInteger>>;

export function checklistBody<Field extends string>(
  checked: Field,
  maxItems: number,
) {
  const ids: CheckedIds = Type.Optional(Type.Array(RowId, { maxItems }));
  // A computed key widens to `string`; this names it back.
  // eslint-disable-next-line closet/no-forged-copy -- Field names a property of the schema, never copy
  const properties = { [checked]: ids, shown: ids } as Record<
    Field | 'shown',
    CheckedIds
  >;
  return Type.Union([Type.Object(properties), Type.Null()]);
}

/**
 * The ids that were shown and are not checked: what leaves. Never one that
 * is checked, so a writer's rule for an id in both lists is never reached
 * from a post.
 */
export function unchecked(
  shown: readonly number[] | undefined,
  checked: readonly number[] | undefined,
): number[] {
  const kept = new Set(checked);
  return (shown ?? []).filter((id) => !kept.has(id));
}

/** The hidden input a listed row posts beside its checkbox: it was shown. */
export function ShownId(props: { id: number | string }) {
  return <input type="hidden" name="shown" value={String(props.id)} />;
}
