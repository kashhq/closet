import type { RequestSubject } from '../../wardrobe/agent-requests';
import { type IsoDate, todayIn } from '../../calendar-date';
import { PROFILE_PATH } from '../auth/urls';
import { Card } from '../card';
import { relativeDay } from '../date-labels';
import { t } from '../i18n';
import { PageShell } from '../layout/page-shell';
import { EmptyState } from '../layout/parts';
import { tripUrl } from '../trips/urls';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { garmentUrl, needUrl } from '../wardrobe/urls';
import {
  AnswerView,
  GotItForm,
  NoAgentLine,
  RequestStatusLine,
  WithdrawForm,
} from './parts';
import type { AgentRequestRow, SubjectView } from './queries';
import { olderRequestsUrl, REQUESTS_PATH, requestUrl } from './urls';

/**
 * "Ask your agent"'s pages (#1286, plan section 3.6): GET /requests (the
 * Profile row's, Today's "N more"), every request newest first, and GET
 * /requests/:id, one request with its subject linked, where it stands, the
 * answer with its agent, and Withdraw (open, claimed) or Got it (answered,
 * not seen yet). The asker's alone: anyone else's id is the unknown id's
 * 404 (request-actions.ts).
 */

/** Whether a request still waits on an agent: the no-agent line's case. */
const waits = (row: AgentRequestRow) =>
  row.status === 'open' || row.status === 'claimed';

export function RequestsPage(props: {
  ctx: ViewContext;
  rows: AgentRequestRow[];
  /** The next page's keyset, when there is one. */
  before: number | undefined;
  connected: boolean;
  timeZone: string;
  now: Date;
}) {
  const { ctx, rows } = props;
  const today = todayIn(props.timeZone, props.now);
  return (
    <PageShell
      ctx={ctx}
      name="requests"
      bar={{ title: t('requests.TITLE'), back: PROFILE_PATH }}
      body={{ gap: 3 }}
    >
      {!props.connected && rows.some(waits) && <NoAgentLine />}
      {rows.length === 0 ? (
        <EmptyState message={t('requests.EMPTY')}>{null}</EmptyState>
      ) : (
        <ul class="flex flex-col gap-2" data-requests="">
          {rows.map((row) => (
            <li>
              <Card
                as="a"
                variant="content"
                class="hover:bg-base-200 transition-colors"
                bodyClass="p-3 gap-1"
                href={requestUrl(row.id)}
                data-request={String(row.id)}
              >
                <p class="text-sm font-medium line-clamp-2 break-words">
                  {row.body}
                </p>
                <RequestStatusLine
                  status={row.status}
                  claimedBy={row.claimedBy}
                />
                <p class="text-xs text-muted">
                  {t('requests.ASKED', {
                    day: askedOn(row, props.timeZone, today),
                  })}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {props.before !== undefined && (
        <a href={olderRequestsUrl(props.before)} class="btn btn-ghost btn-sm">
          {t('requests.OLDER')}
        </a>
      )}
    </PageShell>
  );
}

export function RequestPage(props: {
  ctx: ViewContext;
  row: AgentRequestRow;
  connected: boolean;
  timeZone: string;
  now: Date;
}) {
  const { ctx, row } = props;
  const today = todayIn(props.timeZone, props.now);
  return (
    <PageShell
      ctx={ctx}
      name="request"
      bar={{ title: t('requests.ONE_TITLE'), back: REQUESTS_PATH }}
      body={{ gap: 4 }}
    >
      <Card
        as="article"
        variant="content"
        bodyClass="p-4 gap-3"
        data-request={String(row.id)}
        data-status={row.status}
      >
        <p class="whitespace-pre-line break-words">{row.body}</p>
        {row.subject && row.subjectView && (
          <SubjectLink subject={row.subject} view={row.subjectView} />
        )}
        <p class="text-xs text-muted">
          {t('requests.ASKED', { day: askedOn(row, props.timeZone, today) })}
        </p>
        {row.status === 'answered' && row.answer !== null ? (
          <AnswerView answer={row.answer} answeredBy={row.answeredBy} />
        ) : (
          <RequestStatusLine status={row.status} claimedBy={row.claimedBy} />
        )}
        {!props.connected && waits(row) && <NoAgentLine />}
        {waits(row) && <WithdrawForm id={row.id} />}
        {row.status === 'answered' && row.answerSeenAt === null && (
          <GotItForm id={row.id} returnTo={requestUrl(row.id)} />
        )}
      </Card>
    </PageShell>
  );
}

/** "About: Navy chinos", linked: a shared garment through its wardrobe's `?ownerId=`. */
function SubjectLink(props: { subject: RequestSubject; view: SubjectView }) {
  const { subject, view } = props;
  const name = view.name ?? (view.category ? categoryLabel(view.category) : '');
  return (
    <p class="text-sm" data-request-subject={subject.kind}>
      {t('requests.ABOUT')}{' '}
      <a href={subjectHref(subject, view)} class="link">
        {name}
      </a>
    </p>
  );
}

function subjectHref(subject: RequestSubject, view: SubjectView): string {
  switch (subject.kind) {
    case 'garment':
      return garmentUrl(subject.id, view.ownerId ?? undefined);
    case 'trip':
      return tripUrl(subject.id);
    case 'need':
      return needUrl(subject.id, undefined);
  }
}

/** The day it was asked, in the household's zone: "today", "yesterday", "Tue, Sep 29". */
function askedOn(row: AgentRequestRow, timeZone: string, today: IsoDate) {
  return relativeDay(todayIn(timeZone, row.createdAt), today);
}
