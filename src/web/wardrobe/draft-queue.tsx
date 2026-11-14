import { PostForm } from '../form';
import { imageUrl } from '../files/image-url';
import type { WaitingDraft } from '../files/pending-photos';
import { pendingPhotoRef } from '../files/queries';
import { t } from '../i18n';
import { DRAFT_DISCARD_PATH, draftUrl, idListValue, wardrobeUrl } from './urls';

/**
 * The draft queue (#200): a library pick of several photos is a batch of
 * drafts (pending photos, src/web/files/pending-photos.ts), each opened in
 * turn on the new garment form (GET /wardrobe/new?photo=). Saving one
 * (POST /wardrobe) and Skip both move to the next after it in picked
 * order, wrapping round, so a skipped draft comes back once the rest are
 * done; Discard drops it and moves on the same way. After the last, select
 * mode opens with the garments the batch saved checked (batchDoneUrl).
 */
export interface DraftQueue {
  /** The draft on the form. */
  current: string;
  /** The batch's drafts still waiting, the current one included, in picked order. */
  waiting: readonly WaitingDraft[];
  /** The garments the batch saved so far (navigation state, readIdList). */
  saved: readonly number[];
  /** The photos the upload could not read (the first draft only). */
  leftOut: readonly string[];
}

/**
 * The draft that comes after `position` in picked order, wrapping round to
 * the first, never `except` (Skip's target, and Discard's once the current
 * one is gone); undefined when nothing else waits.
 */
export function nextDraft(
  waiting: readonly WaitingDraft[],
  position: number,
  except?: string,
): string | undefined {
  const others = waiting.filter((draft) => draft.fileName !== except);
  return (others.find((draft) => draft.position > position) ?? others[0])
    ?.fileName;
}

/**
 * Above a draft's form: how many wait, their thumbs (each opens that
 * draft; the current one marked), Skip and Discard, and what the upload
 * left out. Discard is its own form, outside the garment form (forms do
 * not nest).
 */
export function DraftQueueSection(props: {
  queue: DraftQueue;
  viewOwner: number | undefined;
}) {
  const { queue, viewOwner } = props;
  const { current, waiting, saved } = queue;
  const position =
    waiting.find((draft) => draft.fileName === current)?.position ?? 0;
  const skipTo = nextDraft(waiting, position, current);
  return (
    <section
      id="draft-queue"
      aria-labelledby="draft-queue-title"
      class="mb-4 flex flex-col gap-3 rounded-box bg-base-200 p-3"
    >
      <div>
        <h2 id="draft-queue-title" class="font-semibold">
          {waiting.length === 1
            ? t('drafts.QUEUE_TITLE_ONE')
            : t('drafts.QUEUE_TITLE', { count: waiting.length })}
        </h2>
        <p class="text-sm text-muted">{t('drafts.QUEUE_HINT')}</p>
      </div>
      {queue.leftOut.length > 0 && (
        <p role="status" class="alert alert-warning alert-soft text-sm">
          {t('drafts.LEFT_OUT', { names: queue.leftOut.join(', ') })}
        </p>
      )}
      {waiting.length > 1 && (
        <ul
          aria-label={t('drafts.QUEUE_LABEL')}
          class="flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
        >
          {waiting.map((draft) => {
            const isCurrent = draft.fileName === current;
            return (
              <li class="shrink-0">
                <a
                  href={draftUrl(viewOwner, draft.fileName, saved)}
                  aria-label={t('drafts.THUMB', {
                    position: draft.position + 1,
                  })}
                  aria-current={isCurrent ? 'step' : undefined}
                  class={`block rounded-box ${isCurrent ? 'ring-2 ring-primary' : ''}`}
                >
                  <img
                    src={imageUrl(pendingPhotoRef(draft.fileName), 'thumb')}
                    alt=""
                    width="48"
                    height="48"
                    loading="lazy"
                    class="size-12 object-contain rounded-box bg-base-100"
                  />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <div class="flex gap-2">
        {skipTo && (
          <a
            href={draftUrl(viewOwner, skipTo, saved)}
            class="btn flex-1"
            data-draft-skip=""
          >
            {t('drafts.SKIP')}
          </a>
        )}
        <PostForm
          action={wardrobeUrl(viewOwner, {}, DRAFT_DISCARD_PATH)}
          class="flex-1"
        >
          <input type="hidden" name="photo" value={current} />
          <input type="hidden" name="saved" value={idListValue(saved)} />
          <button type="submit" class="btn btn-ghost w-full">
            {t('drafts.DISCARD')}
          </button>
        </PostForm>
      </div>
    </section>
  );
}
