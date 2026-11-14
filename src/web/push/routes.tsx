import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Db } from '../../db/client';
import { loginRequired, sessionUserId } from '../auth/require-session';
import { endSession, sessionStamp } from '../auth/session';
import { profileSection } from '../auth/urls';
import { t } from '../i18n';
import type { Logger } from '../../logger';
import { renderFragment } from '../render';
import { HttpError } from '../errors';
import { isReminderChoice, type ReminderKind } from '../../push/reminders';
import { isPushServiceEndpoint } from './endpoint';
import {
  deleteDevice,
  findReminderSettings,
  saveReminderSettings,
  upsertDevice,
} from './queries';
import type { PushSender, VapidConfig } from './sender';
import {
  PUSH_SETTINGS_ID,
  ReminderSettingsForm,
  ReminderStatus,
  TestResult,
} from './settings';

/**
 * The browser's PushSubscription.toJSON(), as public/js/push.js posts it.
 * Stored as sent and later handed to web-push, so it is held to its real
 * shape here: an https endpoint (every push service is one) and the RFC 8291
 * keys in base64url (browsers write them unpadded), a 65-byte P-256 point
 * and a 16-byte secret. Anything else is a 400. `expirationTime` and unknown
 * properties are stripped.
 */
const Endpoint = Type.String({
  format: 'uri',
  pattern: '^https://',
  maxLength: 2048,
});
const SubscribeBody = Type.Object({
  endpoint: Endpoint,
  keys: Type.Object({
    p256dh: Type.String({ pattern: '^[A-Za-z0-9_-]{87}=?$' }),
    auth: Type.String({ pattern: '^[A-Za-z0-9_-]{22}(==)?$' }),
  }),
});
const UnsubscribeBody = Type.Object({ endpoint: Endpoint });

// This device's reminders (#15): the endpoint names the device; a time is
// read only with its toggle on, and must be one of the choices (else 400:
// the form offers nothing else).
const RemindersFormBody = Type.Object({ endpoint: Endpoint });
const RemindersBody = Type.Object({
  endpoint: Endpoint,
  morningOn: Type.Optional(Type.Literal('1')),
  morning: Type.Optional(Type.Integer()),
  eveningOn: Type.Optional(Type.Literal('1')),
  evening: Type.Optional(Type.Integer()),
  // Muse's rounds (#337): a toggle, no time.
  museRoundsOn: Type.Optional(Type.Literal('1')),
});

function reminderTime(
  kind: ReminderKind,
  on: '1' | undefined,
  minute: number | undefined,
): number | null {
  if (on === undefined) return null;
  if (minute === undefined || !isReminderChoice(kind, minute)) {
    throw new HttpError(400, `body/${kind} must be one of the reminder times`);
  }
  return minute;
}

// Stored for telling devices apart; the header is the client's to fill.
const USER_AGENT_LIMIT = 512;
// A test that has not arrived in ten minutes is no longer a useful answer.
const TEST_TTL_SECONDS = 600;

export interface PushRouteOptions {
  db: Db;
  logger: Logger;
  appName: string;
  vapid: VapidConfig;
  sender: PushSender;
}

/**
 * /push: Web Push subscriptions of the signed-in user's browsers, each
 * device's reminders (#15) and the test send on the profile page
 * (src/web/push/settings.tsx). Registered only
 * when PWA_ENABLED (there is no service worker to receive anything
 * otherwise). Every route needs a session; the writes are fetches and htmx
 * posts, so a signed-out caller gets a 401, and the same-origin check
 * (CSRF) applies as everywhere.
 */
export const pushRoutes: FastifyPluginCallbackTypebox<PushRouteOptions> = (
  app,
  { db, logger, appName, vapid, sender },
  done,
) => {
  // Read by push.js before subscribing and by the service worker when the
  // browser renews a subscription (pushsubscriptionchange).
  app.get('/push/vapid-public-key', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-cache')
      .type('text/plain; charset=utf-8')
      .send(vapid.publicKey),
  );

  app.post(
    '/push/subscribe',
    { schema: { body: SubscribeBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      // The server will POST to this URL: only known push services (SSRF).
      if (!isPushServiceEndpoint(request.body.endpoint)) {
        logger.warn(
          `User ${userId} sent a subscription outside the push services`,
        );
        throw new HttpError(400);
      }
      const deviceId = await upsertDevice(
        db,
        userId,
        sessionStamp(request),
        request.body,
        request.headers['user-agent']?.slice(0, USER_AGENT_LIMIT),
      );
      // The password changed, or Sign out everywhere ran, after the session
      // gate let this request in (#512, #700): answered as the gate answers an ended session's fetch.
      if (deviceId === undefined) {
        logger.info(
          `User ${userId}'s push subscription refused: the session ended under it`,
        );
        endSession(reply);
        return loginRequired(reply);
      }
      logger.info(`User ${userId} confirmed push device ${deviceId}`);
      return reply.status(204).send();
    },
  );

  // 204 whether or not there was a row: the browser has dropped the
  // subscription either way, and another user's row is not this one's to
  // report on.
  app.post(
    '/push/unsubscribe',
    { schema: { body: UnsubscribeBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      if (await deleteDevice(db, userId, request.body.endpoint)) {
        logger.info(`User ${userId} turned off push on a device`);
      }
      return reply.status(204).send();
    },
  );

  // The profile's reminders for the device the browser names (push.js,
  // once its state is on). A POST though it reads: the endpoint is a
  // capability URL, which must never sit in a URL the request log names.
  // Always a 200 fragment: an endpoint that is not the caller's device
  // says to turn notifications on.
  app.post(
    '/push/reminders/form',
    { schema: { body: RemindersFormBody } },
    async (request, reply) => {
      const { endpoint } = request.body;
      const settings = await findReminderSettings(
        db,
        sessionUserId(request),
        endpoint,
      );
      return renderFragment(
        reply,
        <ReminderSettingsForm endpoint={endpoint} settings={settings} />,
      );
    },
  );

  // Every change of the reminders form (an AutosaveForm): both times saved,
  // stamped now (a time already past today first sends tomorrow, which the
  // status line says only when a time changed). Answers only the form's
  // status line (ReminderStatus): the controls stay the person's.
  app.post(
    '/push/reminders',
    { schema: { body: RemindersBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { endpoint } = request.body;
      const settings = {
        morning: reminderTime(
          'morning',
          request.body.morningOn,
          request.body.morning,
        ),
        evening: reminderTime(
          'evening',
          request.body.eveningOn,
          request.body.evening,
        ),
        museRounds: request.body.museRoundsOn === '1',
      };
      const saved = await saveReminderSettings(
        db,
        userId,
        endpoint,
        settings,
        new Date(),
      );
      if (!saved) {
        logger.info(`User ${userId} set reminders on a device not theirs`);
        return renderFragment(reply, <ReminderStatus saved={false} />);
      }
      const time = (minute: number | null) =>
        minute === null ? 'off' : String(minute);
      logger.info(
        `User ${userId} set reminders on push device ${saved.deviceId}: morning ${time(settings.morning)}, evening ${time(settings.evening)} (minutes after midnight), Muse's rounds ${settings.museRounds ? 'on' : 'off'}`,
      );
      return renderFragment(
        reply,
        <ReminderStatus saved timesChanged={saved.timesChanged} />,
      );
    },
  );

  // An htmx button: always a 200 fragment saying what happened (htmx swaps
  // no 4xx), sent to the caller's own devices only.
  app.post('/push/test', async (request, reply) => {
    const userId = sessionUserId(request);
    const report = await sender.sendToUser(
      userId,
      {
        title: t('PUSH_TEST_TITLE', { appName }),
        body: t('PUSH_TEST_BODY'),
        url: profileSection(PUSH_SETTINGS_ID),
        tag: 'push-test',
      },
      { ttlSeconds: TEST_TTL_SECONDS },
    );
    return renderFragment(reply, <TestResult report={report} />);
  });

  done();
};
