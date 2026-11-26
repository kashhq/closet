import { cardClass } from '../card';
import { queuedTarget } from '../../offline-writes';
import { PostForm } from '../form';
import { t } from '../i18n';
import { PageShell } from '../layout/page-shell';
import {
  EmptyState,
  GarmentThumb,
  SavedToast,
  StripFlags,
} from '../layout/parts';
import type { SharedWardrobe } from '../sharing/access';
import { OutboxPending, outboxRegion } from '../outbox';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { LAUNDRY_PATH } from '../wardrobe/urls';
import {
  WardrobeAddSheet,
  type WardrobeHeaderProps,
  wardrobeBar,
} from '../wardrobe/wardrobe-header';
import type { LaundryItem } from './queries';

/** The one-shot flag POST /laundry's redirect carries. */
const LAUNDRY_FLAGS = ['washed'] as const;

/** The hamper's form: Mark washed, in the page's action bar, submits it. */
const LAUNDRY_FORM_ID = 'laundry-form';

/**
 * GET /laundry, the Wardrobe's Laundry tab: the signed-in user's own hamper
 * as one native form (PostForm; the answer is this page again): what needs
 * a wash, checked, then what was worn but is not due yet (jeans after one
 * wear), unchecked. "Mark washed" posts the checked ones to POST /laundry,
 * which washes every copy today. Offline it queues (#178): each checked row
 * is its own record, replayed through the garment's Washed, so laundry day
 * in a basement saves without a signal. Always the user's own wardrobe, so the
 * header is theirs (a shared one's closet is a switch away).
 */
export function LaundryPage(props: {
  ctx: ViewContext;
  items: LaundryItem[];
  /** The wardrobes shared with the user: the header's switcher. */
  sharedWardrobes: SharedWardrobe[];
  /** After POST /laundry: how many were washed (the toast). */
  washed: number | undefined;
}) {
  const { ctx, items } = props;
  const due = items.filter((item) => item.dirty > 0);
  const worn = items.filter((item) => item.dirty === 0);
  // Back from Mark washed (#679): focus starts where the tap left it, on
  // the button, or on the way on once the hamper is empty.
  const landed = props.washed !== undefined;
  const header: WardrobeHeaderProps = {
    ctx,
    tab: 'laundry',
    viewOwner: undefined,
    sharedWardrobes: props.sharedWardrobes,
    canEdit: true,
  };
  return (
    <PageShell
      ctx={ctx}
      name="laundry"
      title={t('wear.LAUNDRY')}
      bar={wardrobeBar(header)}
      actionBar={
        items.length > 0
          ? {
              children: (
                <button
                  type="submit"
                  form={LAUNDRY_FORM_ID}
                  id="laundry-mark-washed"
                  class="btn btn-primary btn-sm"
                  autofocus={landed}
                >
                  {t('wear.MARK_WASHED')}
                </button>
              ),
            }
          : undefined
      }
      overlays={
        <>
          <WardrobeAddSheet {...header} />
          {props.washed !== undefined && (
            <>
              <SavedToast
                id="laundry-toast"
                text={t('wear.LAUNDRY_WASHED', { count: props.washed })}
              />
              <StripFlags names={LAUNDRY_FLAGS} />
            </>
          )}
        </>
      }
    >
      {items.length === 0 ? (
        <EmptyState message={t('wear.LAUNDRY_EMPTY')}>
          <a href="/wardrobe" class="btn btn-sm" autofocus={landed}>
            {t('WARDROBE')}
          </a>
        </EmptyState>
      ) : (
        <PostForm
          id={LAUNDRY_FORM_ID}
          action={LAUNDRY_PATH}
          class="flex flex-col gap-6"
          offlineQueue="wash"
        >
          {due.length > 0 && (
            <LaundryGroup title={t('wear.LAUNDRY_DUE')} items={due} />
          )}
          {worn.length > 0 && (
            <LaundryGroup title={t('wear.LAUNDRY_WORN')} items={worn} />
          )}
        </PostForm>
      )}
    </PageShell>
  );
}

function LaundryGroup(props: { title: string; items: LaundryItem[] }) {
  return (
    <section>
      <h2 class="text-sm text-muted mb-2">{props.title}</h2>
      <ul class="flex flex-col gap-2">
        {props.items.map((item) => (
          <li>
            <LaundryRow item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A checkbox row: the whole row is its label; due garments start checked. */
function LaundryRow({ item }: { item: LaundryItem }) {
  const name = item.name ?? categoryLabel(item.category);
  return (
    <label
      class={cardClass(
        'content',
        'flex-row items-center gap-3 p-2 cursor-pointer has-[:checked]:ring-2 has-[:checked]:ring-primary',
      )}
      {...outboxRegion(queuedTarget('wash', item.id), name)}
    >
      <input
        type="checkbox"
        name="ids"
        value={String(item.id)}
        checked={item.dirty > 0}
        class="checkbox checkbox-primary checkbox-sm"
        aria-label={name}
      />
      <GarmentThumb garment={item} class="rounded-box" />
      <span class="flex flex-col min-w-0">
        <span class="font-medium truncate">{name}</span>
        <span class="text-xs text-muted">{washLabel(item)}</span>
        <OutboxPending />
      </span>
    </label>
  );
}

function washLabel(item: LaundryItem): string {
  if (item.dirty === 0) return t('wear.NOT_DUE');
  return item.quantity > 1
    ? t('wear.COPIES_NEED_WASH', { dirty: item.dirty, quantity: item.quantity })
    : t('wear.NEEDS_WASH');
}
