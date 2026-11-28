import {
  REQUEST_BODY_MAX,
  type RequestSubject,
  type RequestSubjectKind,
} from '../../wardrobe/agent-requests';
import { requestTarget } from '../../offline-writes';
import { PostForm } from '../form';
import { FormField } from '../form-field';
import { t, type StringKey } from '../i18n';
import { Sheet, SheetCancel, sheetOpener } from '../layout/sheet';
import { OutboxPending, outboxRegion } from '../outbox';
import { REQUESTS_PATH } from './urls';

/**
 * "Ask your agent" (#1286; docs/plans/2026-11-27-mcp-oauth.md sections 3.3
 * and 3.4): one sheet, its opener and its "Waiting to sync", placed on
 * Today (no subject), a wishlist need's card, a trip's page and a garment's
 * page (own or shared). A `PostForm` to POST /requests holding the text and
 * the hidden subject; a send lands on the request's page.
 *
 * Queued offline (the outbox's `request` kind, src/web/shell/outbox.md):
 * the region is named by its subject (`requestTarget`), and the outbox
 * mints the form's `clientId` at every tap, which completes the record's
 * key (`request:garment:41:<clientId>`) and makes the replay idempotent;
 * any copy of the page finds its queued asks by the region's part. Static
 * markup (no client id, no day, no token state), so a stale-while-revalidate page that
 * holds it (the Wishlist) stays byte for byte the same; whether an agent is
 * connected is said where the request lands and on Today, never here.
 */

/** The text box's example, by what the request is about. */
const PLACEHOLDER: Record<RequestSubjectKind | 'none', StringKey> = {
  none: 'requests.PLACEHOLDER_TODAY',
  garment: 'requests.PLACEHOLDER_GARMENT',
  trip: 'requests.PLACEHOLDER_TRIP',
  need: 'requests.PLACEHOLDER_NEED',
};

function sheetId(subject: RequestSubject | null): string {
  return subject ? `ask-agent-${subject.kind}-${subject.id}` : 'ask-agent';
}

export function AskAgent(props: {
  subject: RequestSubject | null;
  /** What the outbox's notices name the ask by: the subject's name, or Today. */
  label: string;
  /** Classes beside the region's own (its place in the caller's layout). */
  class?: string;
}) {
  const { subject } = props;
  const id = sheetId(subject);
  const titleId = `${id}-title`;
  const fieldId = `${id}-body`;
  return (
    <div
      {...outboxRegion(requestTarget(subject), props.label)}
      class={`flex flex-wrap items-center gap-2 ${props.class ?? ''}`}
      data-ask-agent={subject?.kind ?? 'today'}
    >
      <button type="button" class="btn btn-outline btn-sm" {...sheetOpener(id)}>
        {t('requests.ASK')}
      </button>
      <OutboxPending />
      <Sheet id={id} kind="form" labelledBy={titleId} gap={4} dismiss="close">
        <h2 id={titleId} class="font-semibold text-lg">
          {t('requests.ASK')}
        </h2>
        <PostForm
          action={REQUESTS_PATH}
          offlineQueue="request"
          class="flex flex-col gap-4"
        >
          <input type="hidden" name="clientId" value="" />
          {subject && (
            <>
              <input type="hidden" name="subjectKind" value={subject.kind} />
              <input
                type="hidden"
                name="subjectId"
                value={String(subject.id)}
              />
            </>
          )}
          <FormField id={fieldId} label={t('requests.BODY_LABEL')}>
            <textarea
              id={fieldId}
              name="body"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={REQUEST_BODY_MAX}
              required
              placeholder={t(PLACEHOLDER[subject?.kind ?? 'none'])}
            ></textarea>
          </FormField>
          <p class="text-sm text-muted">{t('requests.SHEET_HINT')}</p>
          <div class="modal-action mt-0">
            <SheetCancel />
            <button type="submit" class="btn btn-primary">
              {t('requests.SEND')}
            </button>
          </div>
        </PostForm>
      </Sheet>
    </div>
  );
}
