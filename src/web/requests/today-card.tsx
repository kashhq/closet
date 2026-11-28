import { Card } from '../card';
import { t } from '../i18n';
import { TODAY_PATH } from '../today/urls';
import { AnswerView, GotItForm, NoAgentLine, RequestStatusLine } from './parts';
import type { TodayRequest, TodayRequests } from './queries';
import { REQUESTS_PATH, requestUrl } from './urls';

/**
 * Today's requests card (#1286, plan section 3.6): one row per request
 * that is open, claimed, or answered but not seen yet, newest first, at
 * most TODAY_REQUESTS, then "N more" to the list. A withdrawn or seen one
 * has left Today. Nothing while there are none: the Ask button beside it
 * is how one starts.
 */
export function TodayRequestsCard({ requests }: { requests: TodayRequests }) {
  const { shown, count, waiting, connected } = requests;
  if (shown.length === 0) return null;
  return (
    <Card
      as="section"
      variant="content"
      bodyClass="p-3 gap-3"
      aria-labelledby="today-requests-title"
      data-today-requests={String(count)}
    >
      <h2 id="today-requests-title" class="text-sm font-semibold">
        {t('requests.TODAY_TITLE')}
      </h2>
      <ul class="flex flex-col gap-3 divide-y divide-base-300">
        {shown.map((request) => (
          <TodayRequestRow request={request} />
        ))}
      </ul>
      {!connected && waiting && <NoAgentLine />}
      {count > shown.length && (
        <a href={REQUESTS_PATH} class="link text-sm self-start">
          {t('requests.MORE', { count: count - shown.length })}
        </a>
      )}
    </Card>
  );
}

function TodayRequestRow({ request }: { request: TodayRequest }) {
  return (
    <li
      class="flex flex-col gap-2 pb-3 last:pb-0"
      data-request={String(request.id)}
    >
      <a
        href={requestUrl(request.id)}
        class="text-sm font-medium line-clamp-2 break-words"
      >
        {request.body}
      </a>
      {request.status === 'answered' && request.answer !== null ? (
        <>
          <AnswerView
            answer={request.answer}
            answeredBy={request.answeredBy}
            clamp
          />
          <GotItForm id={request.id} returnTo={TODAY_PATH} />
        </>
      ) : (
        <RequestStatusLine
          status={request.status}
          claimedBy={request.claimedBy}
        />
      )}
    </li>
  );
}
