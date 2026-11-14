import {
  DEFAULT_REMINDER_TIMES,
  formatMinuteOfDay,
  type ReminderKind,
  reminderChoices,
} from '../../push/reminders';
import { AutosaveForm } from '../autosave';
import { t } from '../i18n';
import { ProfileSection } from '../layout/parts';
import type { ReminderSettings } from './queries';
import type { SendReport } from './sender';

/** Where the reminders' fragment goes; push.js loads it once the device is on. */
const REMINDERS_ID = 'push-reminders';

/**
 * The profile page's notification controls. Whether this browser can and
 * does receive notifications is only known in the browser, so every state's
 * text is rendered here, hidden, and the <push-settings> element
 * (public/js/push.js) shows the one that applies. The permission prompt
 * only ever comes from the enable button: browsers penalize prompts without
 * a gesture and iOS refuses them.
 *
 * States (data-show): checking (before the script runs), on, off, blocked
 * (permission denied), unsupported, install (iOS/iPadOS outside the
 * installed app, where there is no push at all), error.
 */
/** The Profile's notifications section: its anchor. */
export const PUSH_SETTINGS_ID = 'notifications';

export function PushSettings() {
  return (
    <ProfileSection id={PUSH_SETTINGS_ID} heading={t('PUSH_HEADING')}>
      <push-settings class="flex flex-col gap-2">
        <p data-show="checking">{t('PUSH_CHECKING')}</p>
        <p data-show="on" hidden>
          {t('PUSH_STATE_ON')}
        </p>
        <p data-show="off" hidden>
          {t('PUSH_STATE_OFF')}
        </p>
        <p data-show="blocked" hidden>
          {t('PUSH_STATE_BLOCKED')}
        </p>
        <p data-show="unsupported" hidden>
          {t('PUSH_STATE_UNSUPPORTED')}
        </p>
        <p data-show="install" hidden>
          {t('PUSH_STATE_INSTALL')}
        </p>
        <p data-show="error" class="text-error" role="alert" hidden>
          {t('PUSH_STATE_ERROR')}
        </p>
        <button
          type="button"
          class="btn btn-primary"
          data-show="off error"
          data-action="enable"
          hidden
        >
          {t('PUSH_ENABLE')}
        </button>
        <button
          type="button"
          class="btn"
          data-show="on"
          data-action="disable"
          hidden
        >
          {t('PUSH_DISABLE')}
        </button>
        {/* This device's reminders: only the browser knows which device it
              is (its subscription's endpoint), so push.js asks for them once
              the state is on (POST /push/reminders/form) and they replace
              this slot. */}
        <div id={REMINDERS_ID} data-show="on" hidden></div>
      </push-settings>
      {/* Sends to all of the user's devices, not only this one, so it is
            there whatever this browser's state; the answer says how many. */}
      <button
        type="button"
        class="btn btn-outline"
        hx-post="/push/test"
        hx-target="#push-test-result"
        hx-swap="innerHTML"
      >
        {t('PUSH_SEND_TEST')}
      </button>
      <div id="push-test-result" aria-live="polite"></div>
    </ProfileSection>
  );
}

/**
 * The change-password form's field naming this device's push subscription
 * (ChangePasswordBody): a new password revokes every other device's
 * subscription (revokeDevicesStatement) and keeps this one's, reminders and all.
 * Only the browser knows its endpoint, so <push-endpoint> (public/js/
 * push.js) fills the hidden input. Left empty (no subscription, or a submit
 * before the script ran), this device's row goes with the others and the
 * next signed-in page sends the subscription again, without its reminders.
 */
export const PUSH_ENDPOINT_FIELD = 'pushEndpoint';

export function PushEndpointField() {
  return (
    <push-endpoint>
      <input type="hidden" name={PUSH_ENDPOINT_FIELD} value="" />
    </push-endpoint>
  );
}

/**
 * On the login page shown signed out: tells push.js this browser has no
 * session, so it drops its push subscription (a signed-out device receives
 * nobody's notifications). The sign-out button's POST drops it in the
 * service worker; this covers a session that ended away from the device (a
 * password changed elsewhere, `user:set-password`, a rotated secret,
 * expiry), which the device finds on its next request: the session resolver
 * clears the cookie and the gate sends it here. An element rather than a
 * script, so it also acts when a boosted tap lands here (htmx swaps the
 * body; a custom element upgrades wherever it arrives).
 */
export function PushSignedOut() {
  return <push-signed-out hidden></push-signed-out>;
}

/**
 * POST /push/test's answer, swapped under the button: what the send
 * reached, or `rate-limited` past PUSH_TEST_LIMIT (nothing was sent).
 */
export function TestResult({
  report,
}: {
  report: SendReport | 'rate-limited';
}) {
  if (report === 'rate-limited') return <p>{t('PUSH_TEST_TOO_SOON')}</p>;
  if (report.devices === 0) return <p>{t('PUSH_TEST_NO_DEVICES')}</p>;
  return (
    <>
      {report.delivered > 0 && (
        <p class="text-success">
          {t('PUSH_TEST_SENT', { count: report.delivered })}
        </p>
      )}
      {report.failed > 0 && (
        <p class="text-error">
          {t('PUSH_TEST_FAILED', { count: report.failed })}
        </p>
      )}
      {report.pruned > 0 && (
        <p>{t('PUSH_TEST_REMOVED', { count: report.pruned })}</p>
      )}
    </>
  );
}

/**
 * This device's reminders (#15): a toggle and a time for each, and Muse's
 * rounds (#337), a toggle; an
 * `AutosaveForm` saved on every change (src/web/autosave.tsx: in order, the
 * whole form each time, answered by the status line alone, ReminderStatus,
 * never the controls). The endpoint names the device: the browser's own
 * subscription, sent by push.js and carried here for the saves; it never
 * reaches a log or a URL. Shown only while notifications are on
 * (data-show, push.js), in the slot push.js loads it into, which keeps its
 * id so a later load replaces it again.
 */
export function ReminderSettingsForm(props: {
  endpoint: string;
  settings: ReminderSettings | undefined;
}) {
  const { endpoint, settings } = props;
  if (!settings) {
    return (
      <p id={REMINDERS_ID} data-show="on" class="text-sm">
        {t('today.reminders.NOT_REGISTERED')}
      </p>
    );
  }
  return (
    <div id={REMINDERS_ID} data-show="on" class="border-t border-base-300 pt-3">
      <AutosaveForm action="/push/reminders" class="flex flex-col gap-3">
        <h3 class="font-semibold text-sm">{t('today.reminders.HEADING')}</h3>
        <input type="hidden" name="endpoint" value={endpoint} />
        <ReminderField
          kind="morning"
          label={t('today.reminders.MORNING')}
          minute={settings.morning}
        />
        <ReminderField
          kind="evening"
          label={t('today.reminders.EVENING')}
          hint={t('today.reminders.EVENING_HINT')}
          minute={settings.evening}
        />
        {/* Muse's rounds (#337): a toggle, no time; off until turned on. */}
        <div class="flex flex-col gap-1" data-muse-rounds="">
          <label class="label cursor-pointer gap-2 text-sm text-base-content">
            <input
              type="checkbox"
              class="toggle toggle-sm toggle-primary"
              name="museRoundsOn"
              value="1"
              checked={settings.museRounds}
            />
            {t('today.reminders.MUSE')}
          </label>
          <p class="text-xs text-muted">{t('today.reminders.MUSE_HINT')}</p>
        </div>
      </AutosaveForm>
    </div>
  );
}

/**
 * POST /push/reminders' answer: the form's status line. "A time already
 * past today starts tomorrow" only when a time changed, never for Muse's
 * toggle alone (#337).
 */
export function ReminderStatus(props: {
  saved: boolean;
  timesChanged?: boolean;
}) {
  if (!props.saved) {
    return (
      <span class="text-error">{t('today.reminders.NOT_REGISTERED')}</span>
    );
  }
  return (
    <span class="text-success">
      {props.timesChanged
        ? t('today.reminders.SAVED_TIMES')
        : t('today.reminders.SAVED')}
    </span>
  );
}

function ReminderField(props: {
  kind: ReminderKind;
  label: string;
  hint?: string;
  /** The saved time; null when off. */
  minute: number | null;
}) {
  const { kind, minute } = props;
  const shown = minute ?? DEFAULT_REMINDER_TIMES[kind];
  return (
    <div class="flex flex-col gap-1" data-reminder={kind}>
      <div class="flex items-center justify-between gap-2">
        <label class="label cursor-pointer gap-2 text-sm text-base-content">
          <input
            type="checkbox"
            class="toggle toggle-sm toggle-primary"
            name={`${kind}On`}
            value="1"
            checked={minute !== null}
          />
          {props.label}
        </label>
        <select
          class="select select-sm w-28"
          name={kind}
          aria-label={`${props.label}: ${t('today.reminders.TIME')}`}
        >
          {reminderChoices(kind).map((choice) => (
            <option value={String(choice)} selected={choice === shown}>
              {formatMinuteOfDay(choice)}
            </option>
          ))}
        </select>
      </div>
      {props.hint && <p class="text-xs text-muted">{props.hint}</p>}
    </div>
  );
}
