import { isPushServiceEndpoint } from './endpoint';
import webpush from 'web-push';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { Metrics, PushEnding } from '../../metrics/metrics';
import type { PushPayload } from './payload';
import {
  deleteDeviceById,
  type DeviceRow,
  devicesOf,
  devicesOfUsers,
  type UserDeviceRow,
} from './queries';

/** VAPID identity (PUBLIC_VAPID_KEY, PRIVATE_VAPID_KEY, SITE_URL as subject). */
export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

interface SendOptions {
  /**
   * How long the push service keeps the message for a device that is off
   * (Web Push TTL). Past it the message is dropped: a reminder about today
   * must not arrive tomorrow.
   */
  ttlSeconds: number;
}

/** What happened to one send, per device. */
export interface SendReport {
  devices: number;
  delivered: number;
  /** Devices the push service reported gone (404/410), now deleted. */
  pruned: number;
  failed: number;
}

export interface PushSender {
  /**
   * Sends the payload to every device of the user. Never throws for a
   * device: each failure is logged with the device id and counted.
   */
  sendToUser(
    userId: number,
    payload: PushPayload,
    options: SendOptions,
  ): Promise<SendReport>;
  /**
   * Several messages, each to some of its user's devices: every user's
   * devices read in one statement (devicesOfUsers), then the messages sent
   * together, so a job's batch (the minute's reminders, the re-plan's swap
   * notices) pays one round trip, not one per person (#173). The reports
   * are in the messages' order. Throws only when that read fails.
   */
  sendEach(
    messages: readonly DeviceMessage[],
    options?: SendEachOptions,
  ): Promise<SendReport[]>;
}

interface SendEachOptions {
  /**
   * Called as each message's sends finish, before the batch's last one does:
   * a caller that gives up on the batch (shutdown) knows which messages
   * went and which did not (the reminders release the claims of the rest).
   */
  onReport?: (index: number, report: SendReport) => void;
}

/** One message of a batch (PushSender.sendEach). */
export interface DeviceMessage {
  userId: number;
  /**
   * Which of the user's devices it goes to: these ids (a reminder goes to
   * the devices that claimed it; ids that are not the user's are ignored),
   * every one with the morning reminder on (the re-plan's swap notice,
   * src/web/week-plan/replan.ts), or every one taking Muse's rounds
   * (finish_round, #337).
   */
  devices: readonly number[] | 'morning-reminder' | 'muse-rounds';
  payload: PushPayload;
  options: SendOptions;
}

/** A message's devices among the batch's rows (week-plan.spec.ts's recording sender chooses the same way). */
export function chosenDevices(
  rows: readonly UserDeviceRow[],
  { userId, devices }: DeviceMessage,
): DeviceRow[] {
  return rows.filter((row) => row.userId === userId && isChosen(row, devices));
}

/** A user's device the message is for: by its setting, or by id. */
function isChosen(
  row: UserDeviceRow,
  devices: DeviceMessage['devices'],
): boolean {
  if (devices === 'morning-reminder') return row.morningReminder;
  if (devices === 'muse-rounds') return row.museRounds;
  return devices.includes(row.id);
}

// The push service no longer knows the subscription: the browser dropped it,
// the user revoked permission, or it expired. It will never work again.
const GONE_STATUSES = new Set([404, 410]);
// A socket timeout per request, so one unresponsive push service cannot hold
// the test route (or a reminder run) open.
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The one way to send a Web Push message (web-push, RFC 8291 aes128gcm, the
 * encoding every current browser accepts). The VAPID details are checked
 * here, at boot, so a malformed key fails the start rather than every send
 * (the https SITE_URL subject is loadConfig's rule); they are passed per request, never set globally.
 *
 * Endpoints are capability URLs: logs name a device by its row id, never
 * by endpoint (a WebPushError carries the endpoint; it is not logged whole).
 * A failed send's error goes to the error tracker through the metrics; the
 * tracker sends an error's name, message and stack, never its other
 * properties (the endpoint, the push service's headers).
 */
export function createPushSender(options: {
  db: Db;
  logger: Logger;
  vapid: VapidConfig;
  /** Every device's outcome, as push_sends_total{outcome}; a failure's error to the error tracker. */
  metrics: Metrics;
}): PushSender {
  const { db, logger, vapid, metrics } = options;
  webpush.getVapidHeaders(
    new URL(vapid.subject).origin,
    vapid.subject,
    vapid.publicKey,
    vapid.privateKey,
    'aes128gcm',
  );

  async function deliver(
    userId: number,
    device: DeviceRow,
    body: string,
    { ttlSeconds }: SendOptions,
  ): Promise<PushEnding> {
    // Never connect to an endpoint outside the push services (SSRF), even one
    // stored before subscribe checked it: drop the row instead.
    if (!isPushServiceEndpoint(device.pushEndpoint)) {
      await deleteDeviceById(db, device.id);
      logger.warn(
        `Push device ${device.id} of user ${userId} is not on a push service; removed unsent`,
      );
      return { outcome: 'pruned' };
    }
    try {
      await webpush.sendNotification(
        {
          endpoint: device.pushEndpoint,
          keys: { p256dh: device.keyP256dh, auth: device.keyAuth },
        },
        body,
        {
          vapidDetails: vapid,
          TTL: ttlSeconds,
          contentEncoding: 'aes128gcm',
          timeout: REQUEST_TIMEOUT_MS,
        },
      );
      return { outcome: 'delivered' };
    } catch (error) {
      if (
        error instanceof webpush.WebPushError &&
        GONE_STATUSES.has(error.statusCode)
      ) {
        await deleteDeviceById(db, device.id);
        logger.info(
          `Push device ${device.id} of user ${userId} is gone (${error.statusCode}); removed`,
        );
        return { outcome: 'pruned' };
      }
      // The push service's answer (its body) is not logged: upstream text.
      // errorFields keeps the HTTP status and drops the endpoint.
      logger.warn(
        { err: error },
        `Push to device ${device.id} of user ${userId} failed`,
      );
      return { outcome: 'failed', error };
    }
  }

  async function send(
    userId: number,
    devices: DeviceRow[],
    payload: PushPayload,
    sendOptions: SendOptions,
  ): Promise<SendReport> {
    const body = JSON.stringify(payload);
    const settled = await Promise.allSettled(
      devices.map((device) => deliver(userId, device, body, sendOptions)),
    );
    const report: SendReport = {
      devices: devices.length,
      delivered: 0,
      pruned: 0,
      failed: 0,
    };
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        report[result.value.outcome] += 1;
        metrics.countPushSend(result.value);
        return;
      }
      // Only the prune can get here (a database error deleting the row).
      report.failed += 1;
      metrics.countPushSend({ outcome: 'failed', error: result.reason });
      logger.error(
        { err: result.reason },
        `Push to device ${devices[index].id} of user ${userId}: could not remove the gone device`,
      );
    });
    logger.info(
      `Push "${payload.tag ?? payload.title}" to user ${userId}: ${report.delivered}/${report.devices} delivered, ${report.pruned} removed, ${report.failed} failed`,
    );
    return report;
  }

  return {
    async sendToUser(userId, payload, sendOptions) {
      return send(userId, await devicesOf(db, userId), payload, sendOptions);
    },
    async sendEach(messages, { onReport } = {}) {
      if (messages.length === 0) return [];
      const rows = await devicesOfUsers(
        db,
        messages.map((message) => message.userId),
      );
      return Promise.all(
        messages.map(async (message, index) => {
          const report = await send(
            message.userId,
            chosenDevices(rows, message),
            message.payload,
            message.options,
          );
          onReport?.(index, report);
          return report;
        }),
      );
    },
  };
}
