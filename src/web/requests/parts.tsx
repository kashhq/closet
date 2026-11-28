import type { RequestStatus } from '../../wardrobe/agent-requests';
import { AgentBadge } from '../agent-badge';
import { TOKENS_PATH } from '../auth/urls';
import { PostForm } from '../form';
import { t } from '../i18n';
import type { AgentLabel } from '../write-origin';
import { requestUrl } from './urls';

/**
 * The pieces Today's card and the requests pages share (#1286, plan
 * section 3.6): where a request stands, the no-agent line, and the asker's
 * two moves. Withdraw and Got it act on a row the page may hold stale, so
 * they stay `data-needs-network` (PostForm's default), never queued.
 */

/**
 * "Waiting for your agent", "<agent> is on it" (the token's badge), or
 * "Withdrawn"; an answered request shows its answer instead (AnswerView).
 */
export function RequestStatusLine(props: {
  status: RequestStatus;
  claimedBy: AgentLabel | null;
}) {
  switch (props.status) {
    case 'open':
      return (
        <p class="text-sm text-muted" data-request-status="open">
          {t('requests.status.OPEN')}
        </p>
      );
    case 'claimed':
      return (
        <p
          class="flex items-center gap-1 text-sm text-muted min-w-0"
          data-request-status="claimed"
        >
          {props.claimedBy ? (
            <>
              <AgentBadge agent={props.claimedBy} />
              <span>{t('requests.status.CLAIMED')}</span>
            </>
          ) : (
            t('requests.status.CLAIMED_UNNAMED')
          )}
        </p>
      );
    case 'answered':
      return (
        <p class="text-sm text-muted" data-request-status="answered">
          {t('requests.status.ANSWERED')}
        </p>
      );
    case 'withdrawn':
      return (
        <p class="text-sm text-muted" data-request-status="withdrawn">
          {t('requests.status.WITHDRAWN')}
        </p>
      );
  }
}

/** The agent's answer, shown as it wrote it (escaped), with who answered. */
export function AnswerView(props: {
  answer: string;
  answeredBy: AgentLabel | null;
  /** Today's card clamps it; the request's page shows it whole. */
  clamp?: boolean;
}) {
  return (
    <div class="flex flex-col gap-1" data-request-answer="">
      <AgentBadge agent={props.answeredBy} />
      <p
        class={`text-sm whitespace-pre-line break-words${props.clamp ? ' line-clamp-4' : ''}`}
      >
        {props.answer}
      </p>
    </div>
  );
}

/** Said while a request waits and no agent token is in force: it waits for one. */
export function NoAgentLine() {
  return (
    <p class="text-sm text-muted" role="note" data-no-agent="">
      {t('requests.NO_AGENT')}{' '}
      <a href={TOKENS_PATH} class="link">
        {t('requests.CONNECT_AGENT')}
      </a>
    </p>
  );
}

/** Got it: the answer read; back to `returnTo` (Today, or the request's page). */
export function GotItForm(props: { id: number; returnTo: string }) {
  return (
    <PostForm action={requestUrl(props.id, '/seen')} class="self-start">
      <input type="hidden" name="returnTo" value={props.returnTo} />
      <button type="submit" class="btn btn-primary btn-sm">
        {t('requests.GOT_IT')}
      </button>
    </PostForm>
  );
}

/** Withdraw: the request taken back, asked first (it cannot be undone). */
export function WithdrawForm(props: { id: number }) {
  return (
    <PostForm
      action={requestUrl(props.id, '/withdraw')}
      confirm={t('requests.WITHDRAW_CONFIRM')}
      class="self-start"
    >
      <button type="submit" class="btn btn-outline btn-sm">
        {t('requests.WITHDRAW')}
      </button>
    </PostForm>
  );
}
