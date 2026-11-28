import type { Queryable } from '../../db/client';
import type { Logger } from '../../logger';
import { t } from '../i18n';
import type { PushSender } from '../push/sender';
import { agentName } from '../write-origin';
import { requestOf } from './queries';
import { requestUrl } from './urls';

/** A day: past it, Today's card says the answer. */
const ANSWER_TTL_SECONDS = 24 * 60 * 60;
/** Characters of the request's first line the lock screen shows. */
const BODY_MAX = 80;

/**
 * The body is the asker's own question, its first line only, never the
 * answer: a lock screen is read over a shoulder, and an answer can carry
 * more than the asker meant to show (a garment, a trip, a budget). The
 * question says which request it is; the page behind the tap says the rest.
 */
function firstLine(body: string): string {
  const line = body.trim().split(/\r?\n/, 1)[0].trim();
  const points = [...line];
  return points.length > BODY_MAX
    ? `${points
        .slice(0, BODY_MAX - 1)
        .join('')
        .trimEnd()}…`
    : line;
}

/**
 * The asker's one notification for an answered request (#1288), after the
 * answer's commit (never inside its transaction), to their devices taking
 * the agent's rounds: the title names the token that answered ("Your agent"
 * once it is gone), tagged `agent-request-<id>` so a repeat replaces an
 * unread one, kept a day, opening the request. A failed send is logged and
 * never undoes the answer. How many devices it reached; none without
 * PWA_ENABLED. Called by answer_agent_request (src/web/mcp/tools/requests.ts),
 * the only agent that answers.
 */
export async function notifyRequestAnswered(
  deps: { db: Queryable; push: PushSender | undefined; logger: Logger },
  ownerId: number,
  id: number,
): Promise<number> {
  if (!deps.push) return 0;
  try {
    const request = await requestOf(deps.db, ownerId, id);
    if (!request) return 0;
    const [report] = await deps.push.sendEach([
      {
        userId: ownerId,
        devices: 'agent-rounds',
        payload: {
          title:
            request.answeredBy?.kind === 'token'
              ? t('requests.push.TITLE', {
                  agent: agentName(request.answeredBy),
                })
              : t('requests.push.TITLE_UNNAMED'),
          body: firstLine(request.body),
          url: requestUrl(id),
          tag: `agent-request-${id}`,
        },
        options: { ttlSeconds: ANSWER_TTL_SECONDS },
      },
    ]);
    return report.delivered;
  } catch (error) {
    deps.logger.error(
      { err: error },
      `Request ${id} of user ${ownerId}: notification not sent`,
    );
    return 0;
  }
}
