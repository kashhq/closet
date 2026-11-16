import type { Child } from 'hono/jsx';
import { t } from '../i18n';
import { SheetBackdrop } from './parts';

/**
 * Where a sheet sits, by what it holds (docs/plans/2026-11-16-desktop-layout.md
 * §3.3). Below lg every kind is the bottom sheet; from lg:
 *  - `choice`: centred, daisyUI's modal width (a question and its answers:
 *    the confirmation, a Plan sheet, Styling's Save, the bulk verbs).
 *  - `form`: a full-height panel at the right edge, `max-w-md` (fields to
 *    fill or pick: the photo sheet, bulk "Set…", the Wardrobe's filters
 *    until D9 docks them).
 *  - `menu`: hung under the control that opened it (CSS anchor positioning,
 *    main.css; centred where a browser has none): the Wardrobe's Add.
 * D9 adds `filters`, docked in a `facets` page's aside rather than modal;
 * main.css finds every kind by `dialog[data-sheet=<kind>]`.
 */
export type SheetKind = 'choice' | 'form' | 'menu';

// Whole class names, so Tailwind finds them. The dialog is daisyUI's
// `modal`, the box its `modal-box`: guards.conf `@sheet` keeps both here.
const DIALOG_CLASS: Readonly<Record<SheetKind, string>> = {
  choice: 'modal modal-bottom lg:modal-middle',
  form: 'modal modal-bottom lg:modal-end',
  menu: 'modal modal-bottom lg:modal-middle',
};
const BOX_CLASS: Readonly<Record<SheetKind, string>> = {
  choice: '',
  form: ' lg:w-full lg:max-w-md',
  menu: '',
};

/**
 * The box's flow, by name: absent, its children flow as blocks (daisyUI's
 * padding); a `gap` stacks them in a column that far apart. A stacked
 * choice or form leaves 2rem below its last row, a menu its rows' own
 * padding. The block sheets (the filters, the bulk verbs and "Set…") kept
 * daisyUI's 1.5rem: the phone was held unchanged when the sheets moved here
 * (#1062), so evening these out is a deliberate phone change of its own.
 */
export type SheetGap = 3 | 4;

const GAP_CLASS: Readonly<Record<SheetGap, string>> = {
  3: ' flex flex-col gap-3',
  4: ' flex flex-col gap-4',
};

function boxClass(kind: SheetKind, gap: SheetGap | undefined): string {
  const flow = gap === undefined ? '' : GAP_CLASS[gap];
  const foot = gap !== undefined && kind !== 'menu' ? ' pb-8' : '';
  return `modal-box group/sheet${flow}${foot}${BOX_CLASS[kind]}`;
}

export interface SheetProps {
  id: string;
  kind: SheetKind;
  /** The id of the sheet's heading (or, for the confirmation, its question): its accessible name. */
  labelledBy: string;
  gap?: SheetGap;
  /**
   * The tap-outside close's name (SheetBackdrop): `close` on a sheet that
   * shows or offers, `cancel` on one that asks for a choice.
   */
  dismiss: 'close' | 'cancel';
  children: Child;
}

/**
 * Every app sheet's `<dialog>` and box (#1062): a page brings the content,
 * never a modal class. Opened by a control carrying `sheetOpener(id)`;
 * public/js/confirm-sheet.js owns the behaviour every sheet shares
 * (`openSheet`: Tab cycles inside, a menu's trigger is its anchor, and the
 * trigger takes focus back on close). Escape, the first focus (an `autofocus` control, else the first
 * one) and the inert page behind are `showModal()`'s; the page's scroll is
 * locked by daisyUI's `modal[open]` rule. The box is `group/sheet`, for
 * content that reacts to something in it (the add sheet's "Uploading…").
 * The photo viewer, the mask editor and a selfie's dialog are not sheets:
 * centred or full-screen on the phone too (guards.conf `known`).
 */
export function Sheet(props: SheetProps) {
  return (
    <dialog
      id={props.id}
      class={DIALOG_CLASS[props.kind]}
      data-sheet={props.kind}
      aria-labelledby={props.labelledBy}
    >
      <div class={boxClass(props.kind, props.gap)}>{props.children}</div>
      <SheetBackdrop
        label={t(props.dismiss === 'close' ? 'CLOSE' : 'CANCEL')}
      />
    </dialog>
  );
}

/**
 * What a control that opens sheet `id` carries: confirm-sheet.js's click
 * listener opens it with the control as its trigger. Spread it on a
 * `<button type="button">`; an inline `onclick` beside it runs first (the
 * calendar's opener checks its occasion before the sheet shows).
 */
export function sheetOpener(id: string) {
  return { 'data-sheet-open': id, 'aria-haspopup': 'dialog' } as const;
}

/** A sheet's own Cancel, beside its action: closes it, nothing posted. */
export function SheetCancel(props: { size?: 'sm' }) {
  return (
    <button
      type="button"
      class={props.size === 'sm' ? 'btn btn-ghost btn-sm' : 'btn btn-ghost'}
      onclick="this.closest('dialog').close()"
    >
      {t('CANCEL')}
    </button>
  );
}
