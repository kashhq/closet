import type { Child } from 'hono/jsx';
import { todayIn } from '../../calendar-date';
import { type StringKey, t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { ProfileSection } from '../layout/parts';
import { wardrobeExportPath } from '../page-cache';
import { STYLE_PROFILE_PATH } from '../style/urls';
import {
  PUSH_SETTINGS_ID,
  PushEndpointField,
  PushSettings,
  PushSignedOut,
} from '../push/settings';
import {
  PermissionBadge,
  SharingSection,
  type SharingModel,
} from '../sharing/pages';
import type { ShareView } from '../sharing/queries';
import { SHARING_SECTION_ID } from '../sharing/urls';
import type { BodyMeasurements, BrandSize } from '../sizes/queries';
import { SIZES_SECTION_ID } from '../sizes/urls';
import { SizesSection } from '../sizes/views';
import type { ViewContext } from '../view-context';
import type { TemplateSlot } from '../../wardrobe/week';
import type { WeatherSettings as Settings } from '../weather/queries';
import { WEATHER_SETTINGS_ID, WeatherSettings } from '../weather/settings';
import { WEEK_SETTINGS_ID } from '../week-plan/urls';
import { WeekTemplateSettings } from '../week-plan/views';
import { AccountShell } from './account-shell';
import {
  ErrorAlert,
  Field,
  Fieldset,
  PostForm,
  SubmitButton,
  UsernameTwin,
} from './form';
import { SignOutForm } from './logout';
import { RETURN_TO_PARAM } from './return-to';
import {
  DEVICE_IDLE_DAYS,
  idleExpired,
  type TokenListing,
} from './personal-tokens';
import {
  ACCOUNT_SECTION_ID,
  AGENT_ACCESS_SECTION_ID,
  DEVICES_PATH,
  DEVICES_SECTION_ID,
  EXPORT_SECTION_ID,
  profileSection,
  SIGN_OUT_EVERYWHERE_PATH,
  SIGN_OUT_SECTION_ID,
  STYLE_SECTION_ID,
  TOKENS_PATH,
} from './urls';
import type {
  ChangePasswordBody,
  FieldErrors,
  RegisterBody,
  UpdateEmailBody,
} from './validation';

/** The pages under /auth. Each takes the page context and what to show. */

/** Where the account's own forms go back to: Profile › Account. */
const ACCOUNT_SECTION_PATH = profileSection(ACCOUNT_SECTION_ID);

/** "Sign out": the logout page's title, Profile's section and its index entry. */
const SIGN_OUT_KEY = 'profile.SIGN_OUT' satisfies StringKey;

/** Sign out everywhere: its page's title, legend and button, Profile's link. */
const SIGN_OUT_EVERYWHERE_KEY =
  'profile.SIGN_OUT_EVERYWHERE' satisfies StringKey;

/**
 * After a new password: what it ended, and who still has the wardrobe. The
 * password deleted every unanswered invite, but accepted shares stay (#668),
 * so they are named here for the owner to revoke any they do not know.
 */
function PasswordChangedNotice(props: { shares: ShareView[] }) {
  return (
    <div role="status" class="alert alert-success flex-col items-start">
      <span>{t('PASSWORD_CHANGED')}</span>
      {props.shares.length > 0 && (
        <>
          <span>{t('PASSWORD_CHANGED_SHARES')}</span>
          <ul class="flex flex-col gap-1">
            {props.shares.map((share) => (
              <li class="flex items-center gap-2 break-all">
                {share.grantee?.email}
                <PermissionBadge permission={share.permission} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function LoginPage(props: {
  ctx: ViewContext;
  /** A refused sign-in: the address is kept, the password never is. */
  failed?: { email: string };
  /** Where signing in lands, already through signInReturnTo. */
  returnTo: string;
}) {
  const { ctx } = props;
  return (
    <AccountShell
      ctx={ctx}
      title={t('LOGIN_TITLE')}
      preview={{
        ogTitle: t('LOGIN_OG_TITLE', { appName: ctx.appName }),
        description: t('LOGIN_OG_DESC', { appName: ctx.appName }),
      }}
      returnTo={props.returnTo}
    >
      {/* Signed out only: a signed-in visitor opening this page keeps
          their notifications. */}
      {ctx.pwaEnabled && !ctx.user && <PushSignedOut />}
      {props.failed && <ErrorAlert message={t('LOGIN_FAILED')} />}
      <PostForm action="/auth/login" endsSession>
        <ReturnToField returnTo={props.returnTo} />
        <SignedOutFrame>
          <Fieldset legend={t('LOGIN')} bare>
            <Field
              id="email"
              label={t('EMAIL')}
              type="email"
              autocomplete="username"
              value={props.failed?.email}
            />
            <Field
              id="password"
              label={t('PASSWORD')}
              type="password"
              autocomplete="current-password"
            />
            <SubmitButton label={t('LOGIN')} />
          </Fieldset>
        </SignedOutFrame>
      </PostForm>
    </AccountShell>
  );
}

/** The sign-in forms' card: the frame their `bare` Fieldset leaves to it. */
function SignedOutFrame(props: { children: Child }) {
  return (
    <div class="card card-border bg-base-200 w-xs p-4">{props.children}</div>
  );
}

/**
 * The page sign-in lands on, posted with the form (return-to.ts): in the
 * body, never the action URL, so an invite token stays out of the access
 * line. Absent for Today, the default.
 */
function ReturnToField(props: { returnTo: string }) {
  return props.returnTo === '/' ? null : (
    <input type="hidden" name={RETURN_TO_PARAM} value={props.returnTo} />
  );
}

/** GET /auth/logout: what a signed-in visitor sees behind an old sign-out link. */
export function LogoutPage(props: { ctx: ViewContext }) {
  return (
    <AccountShell ctx={props.ctx} title={t(SIGN_OUT_KEY)}>
      <p class="text-lg">
        {t('LOGOUT_PROMPT', { appName: props.ctx.appName })}
      </p>
      <SignOutForm />
    </AccountShell>
  );
}

export interface RegisterFormState {
  /** What was typed: the address only, passwords are never echoed. */
  input?: Pick<Partial<RegisterBody>, 'email'>;
  errors?: FieldErrors<keyof RegisterBody>;
}

export const REGISTER_FIELDS = [
  'email',
  'password',
  'confirmPassword',
] as const;

/** The registration fieldset; POST /auth/validate/register refills its messages. */
function RegisterFields({ input = {}, errors = {} }: RegisterFormState) {
  return (
    <Fieldset legend={t('REGISTER')} validateUrl="/auth/validate/register" bare>
      <Field
        id="email"
        label={t('EMAIL')}
        type="email"
        autocomplete="username"
        value={input.email}
        errors={errors.email}
      />
      <Field
        id="password"
        label={t('PASSWORD')}
        type="password"
        autocomplete="new-password"
        errors={errors.password}
        minlength={8}
      />
      <Field
        id="confirmPassword"
        label={t('CONFIRM_PASSWORD')}
        type="password"
        autocomplete="new-password"
        errors={errors.confirmPassword}
      />
      <SubmitButton label={t('REGISTER')} />
    </Fieldset>
  );
}

export function RegisterPage(
  props: { ctx: ViewContext; returnTo: string } & RegisterFormState,
) {
  const { ctx } = props;
  return (
    <AccountShell
      ctx={ctx}
      title={t('REGISTER')}
      preview={{
        ogTitle: t('REGISTER_OG_TITLE', { appName: ctx.appName }),
        description: t('REGISTER_OG_DESC', { appName: ctx.appName }),
      }}
      returnTo={props.returnTo}
    >
      <PostForm action="/auth/register" endsSession>
        <ReturnToField returnTo={props.returnTo} />
        <SignedOutFrame>
          <RegisterFields input={props.input} errors={props.errors} />
        </SignedOutFrame>
      </PostForm>
    </AccountShell>
  );
}

export interface ProfileProps {
  ctx: ViewContext;
  passwordChanged: boolean;
  /** Sign out everywhere's redirect (#700). */
  signedOutEverywhere: boolean;
  /** The week template section (#16): the stored slots, and whether it was just saved. */
  week: { slots: readonly TemplateSlot[]; saved: boolean };
  /** The weather section's state; absent with WEATHER_ENABLED=false. */
  weather?: { settings: Settings; timeZone: string; now: Date };
  /** The Sharing section: this user's shares and invites. */
  sharing: SharingModel;
  /** Agent access: the `mcp` tokens in force. */
  tokens: TokenListing[];
  /**
   * Devices (#189): the `device` tokens in force, the household's timezone
   * for their days, the instant their idle expiry is judged at (#705), and
   * the revoke redirect's notice.
   */
  devices: {
    tokens: TokenListing[];
    timeZone: string;
    now: Date;
    notice?: 'revoked' | 'revoke-gone';
  };
  /** Sizes (#24): the measurements and the brand notes. */
  sizes: { measurements: BodyMeasurements; brands: BrandSize[] };
}

/**
 * The one-shot notices of Profile's redirects, above the sections: a new
 * password, Sign out everywhere (#700), a device revoked (the last one's
 * revoke hides its section, so it cannot sit there).
 */
function ProfileNotices(props: ProfileProps) {
  return (
    <>
      {props.passwordChanged && (
        <PasswordChangedNotice
          shares={props.sharing.outbound.filter((share) => share.acceptedAt)}
        />
      )}
      {props.signedOutEverywhere && (
        <div role="status" class="alert alert-success">
          <span>{t('profile.SIGNED_OUT_EVERYWHERE')}</span>
        </div>
      )}
      {props.devices.notice && (
        <div role="status" class="alert alert-success">
          <span>
            {t(
              props.devices.notice === 'revoked'
                ? 'devices.REVOKED'
                : 'devices.ALREADY_REVOKED',
            )}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Profile, the avatar's page (docs/plans/2026-09-26-redesign.md, "The app
 * bar"): every setting of the signed-in user's own, in sections, in the
 * plan's order. Each section is an anchor that pages and redirects link to
 * (`/auth/profile#weather`); the jump links at the top reach them on a
 * phone. Editors too large for a section keep their own page, linked from
 * it (the style profile, agent access, the account's forms), with a back
 * arrow to their section.
 */
export function ProfilePage(props: ProfileProps) {
  const { ctx } = props;
  // Web Push needs the service worker, which only PWA_ENABLED serves.
  const sections: { id: string; label: string }[] = [
    { id: ACCOUNT_SECTION_ID, label: t('profile.ACCOUNT') },
    { id: SHARING_SECTION_ID, label: t('WARDROBE_SHARING') },
    ...(ctx.pwaEnabled
      ? [{ id: PUSH_SETTINGS_ID, label: t('PUSH_HEADING') }]
      : []),
    ...(props.weather
      ? [{ id: WEATHER_SETTINGS_ID, label: t('weather.SETTINGS_HEADING') }]
      : []),
    { id: WEEK_SETTINGS_ID, label: t('weekPlan.template.HEADING') },
    { id: STYLE_SECTION_ID, label: t('style.TITLE') },
    { id: SIZES_SECTION_ID, label: t('sizes.TITLE') },
    { id: EXPORT_SECTION_ID, label: t('profile.EXPORT') },
    { id: AGENT_ACCESS_SECTION_ID, label: t('agentAccess.TITLE') },
    ...(props.devices.tokens.length > 0
      ? [{ id: DEVICES_SECTION_ID, label: t('devices.TITLE') }]
      : []),
    { id: SIGN_OUT_SECTION_ID, label: t(SIGN_OUT_KEY) },
  ];
  return (
    <Layout ctx={ctx} title={t('PROFILE')}>
      <AppBar ctx={ctx} title={t('PROFILE')} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-4">
        <ProfileNotices {...props} />
        <nav
          aria-label={t('profile.SECTIONS')}
          class="flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
        >
          {sections.map((section) => (
            <a
              href={`#${section.id}`}
              class="btn btn-sm btn-ghost border-base-300 shrink-0"
            >
              {section.label}
            </a>
          ))}
        </nav>
        <AccountSection ctx={ctx} />
        <SharingSection {...props.sharing} />
        {ctx.pwaEnabled && <PushSettings />}
        {props.weather && <WeatherSettings {...props.weather} />}
        <WeekTemplateSettings {...props.week} />
        <ProfileSection id={STYLE_SECTION_ID} heading={t('style.TITLE')}>
          <p class="text-sm text-muted">{t('profile.STYLE_HINT')}</p>
          <a href={STYLE_PROFILE_PATH} class="btn btn-sm self-start">
            {t('profile.EDIT_STYLE')}
          </a>
        </ProfileSection>
        <SizesSection {...props.sizes} />
        <ExportSection />
        <AgentAccessSection tokens={props.tokens} />
        {props.devices.tokens.length > 0 && (
          <DevicesSection {...props.devices} />
        )}
        <ProfileSection id={SIGN_OUT_SECTION_ID} heading={t(SIGN_OUT_KEY)}>
          <p class="text-sm text-muted">{t('profile.SIGN_OUT_HINT')}</p>
          <SignOutForm />
          <p class="text-sm text-muted">
            {t('profile.SIGN_OUT_EVERYWHERE_LINK_HINT')}
          </p>
          <a href={SIGN_OUT_EVERYWHERE_PATH} class="btn btn-sm self-start">
            {t(SIGN_OUT_EVERYWHERE_KEY)}
          </a>
        </ProfileSection>
        <a href="/about" class="link link-hover text-sm self-center">
          {t('ABOUT_TITLE')}
        </a>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * Profile › Export (#200): the requester's own wardrobe as a file. Plain
 * downloads: not boosted (htmx would fetch the file as a page) and never
 * the service worker's (bypassesWorker). Default-size buttons: 44 px on a
 * phone from the theme's touch sizing (views/assets/main.css).
 */
function ExportSection() {
  return (
    <ProfileSection id={EXPORT_SECTION_ID} heading={t('profile.EXPORT')}>
      <p class="text-sm text-muted">{t('profile.EXPORT_HINT')}</p>
      <div class="flex flex-wrap gap-2">
        <a
          href={wardrobeExportPath('csv')}
          download=""
          hx-boost="false"
          class="btn flex-1"
          data-export="csv"
        >
          {t('profile.EXPORT_CSV')}
        </a>
        <a
          href={wardrobeExportPath('json')}
          download=""
          hx-boost="false"
          class="btn flex-1"
          data-export="json"
        >
          {t('profile.EXPORT_JSON')}
        </a>
      </div>
    </ProfileSection>
  );
}

/** Profile › Account: who is signed in, and the account's own forms. */
function AccountSection({ ctx }: { ctx: ViewContext }) {
  return (
    <ProfileSection id={ACCOUNT_SECTION_ID} heading={t('profile.ACCOUNT')}>
      <p class="text-sm break-all">
        {t('profile.SIGNED_IN_AS', { email: ctx.user?.email ?? '' })}
      </p>
      <ul class="menu menu-sm bg-base-100 rounded-box w-full p-1">
        <li>
          <a href="/auth/update-email">{t('UPDATE_EMAIL')}</a>
        </li>
        <li>
          <a href="/auth/change-password">{t('CHANGE_PASSWORD')}</a>
        </li>
        <li>
          <a href="/auth/delete-account" class="text-error">
            {t('DELETE_ACCOUNT')}
          </a>
        </li>
      </ul>
    </ProfileSection>
  );
}

/**
 * Profile › Agent access: the tokens in force by name; creating and
 * revoking stay on their page (TOKENS_PATH), where a new token is shown
 * once in the answer to its password-checked form.
 */
function AgentAccessSection(props: { tokens: TokenListing[] }) {
  return (
    <ProfileSection
      id={AGENT_ACCESS_SECTION_ID}
      heading={t('agentAccess.TITLE')}
    >
      {props.tokens.length === 0 ? (
        <p class="text-sm text-muted">{t('agentAccess.NONE')}</p>
      ) : (
        <ul class="text-sm flex flex-col gap-1">
          {props.tokens.map((token) => (
            <li class="flex items-center gap-2 min-w-0">
              <span class="truncate">{token.name}</span>
              <code class="text-xs text-muted">{token.prefix}…</code>
            </li>
          ))}
        </ul>
      )}
      <a href={TOKENS_PATH} class="btn btn-sm self-start">
        {t('agentAccess.MANAGE')}
      </a>
    </ProfileSection>
  );
}

/**
 * Profile › Devices (#189): the native clients signed in, by the name they
 * gave and their last use, each revocable here without the password
 * (revoking only narrows access). Shown only while there is one: nothing on
 * the web mints a device token. Never the token or its prefix.
 */
function DevicesSection(props: {
  tokens: TokenListing[];
  timeZone: string;
  now: Date;
}) {
  const deviceUse = (device: TokenListing) => {
    if (idleExpired(device, props.now)) {
      return t('devices.IDLE_SIGNED_OUT', { days: DEVICE_IDLE_DAYS });
    }
    return device.lastUsedAt
      ? t('devices.LAST_USED', {
          day: todayIn(props.timeZone, device.lastUsedAt),
        })
      : t('devices.NEVER_USED');
  };
  return (
    <ProfileSection id={DEVICES_SECTION_ID} heading={t('devices.TITLE')}>
      <p class="text-sm text-muted">
        {t('devices.INTRO', { days: DEVICE_IDLE_DAYS })}
      </p>
      <ul class="divide-y divide-base-300">
        {props.tokens.map((device) => (
          <li class="py-2 flex items-center justify-between gap-2">
            <div class="flex flex-col min-w-0">
              <span class="truncate">{device.name}</span>
              <span class="text-xs text-muted">{deviceUse(device)}</span>
            </div>
            <PostForm
              action={`${DEVICES_PATH}/${device.id}/revoke`}
              confirm={t('devices.REVOKE_CONFIRM', { name: device.name })}
            >
              <button type="submit" class="btn btn-ghost btn-sm text-error">
                {t('devices.REVOKE')}
              </button>
            </PostForm>
          </li>
        ))}
      </ul>
    </ProfileSection>
  );
}

export interface UpdateEmailFormState {
  /** What was typed: the addresses only, the password is never echoed. */
  input?: Pick<Partial<UpdateEmailBody>, 'email' | 'confirmEmail'>;
  errors?: FieldErrors<keyof UpdateEmailBody>;
}

// The inline check's slots. Not the password's: only the submission checks
// it, and its message stays until the next one.
export const UPDATE_EMAIL_FIELDS = ['email', 'confirmEmail'] as const;

/** The email fieldset; POST /auth/validate/update-email refills its messages. */
function UpdateEmailFields({ input = {}, errors = {} }: UpdateEmailFormState) {
  return (
    <Fieldset
      legend={t('UPDATE_EMAIL')}
      validateUrl="/auth/validate/update-email"
    >
      <Field
        id="email"
        label={t('NEW_EMAIL')}
        type="email"
        autocomplete="username"
        value={input.email}
        errors={errors.email}
      />
      <Field
        id="confirmEmail"
        label={t('CONFIRM_EMAIL')}
        type="email"
        autocomplete="username"
        value={input.confirmEmail}
        errors={errors.confirmEmail}
      />
      <Field
        id="currentPassword"
        label={t('CURRENT_PASSWORD')}
        type="password"
        autocomplete="current-password"
        errors={errors.currentPassword}
      />
      <SubmitButton label={t('UPDATE')} />
    </Fieldset>
  );
}

export function UpdateEmailPage(
  props: { ctx: ViewContext } & UpdateEmailFormState,
) {
  return (
    <AccountShell
      ctx={props.ctx}
      title={t('UPDATE_EMAIL')}
      back={ACCOUNT_SECTION_PATH}
    >
      <PostForm action="/auth/update-email">
        <UpdateEmailFields input={props.input} errors={props.errors} />
      </PostForm>
    </AccountShell>
  );
}

/** Passwords are never echoed back into this page. */
export function ChangePasswordPage(props: {
  ctx: ViewContext;
  errors?: FieldErrors<keyof ChangePasswordBody>;
}) {
  const errors = props.errors ?? {};
  return (
    <AccountShell
      ctx={props.ctx}
      title={t('CHANGE_PASSWORD')}
      back={ACCOUNT_SECTION_PATH}
    >
      <PostForm action="/auth/change-password">
        <Fieldset legend={t('CHANGE_PASSWORD')}>
          <UsernameTwin email={props.ctx.user?.email} />
          <Field
            id="currentPassword"
            label={t('CURRENT_PASSWORD')}
            type="password"
            autocomplete="current-password"
            errors={errors.currentPassword}
          />
          <Field
            id="newPassword"
            label={t('NEW_PASSWORD')}
            type="password"
            autocomplete="new-password"
            errors={errors.newPassword}
            minlength={8}
          />
          <Field
            id="confirmPassword"
            label={t('CONFIRM_PASSWORD')}
            type="password"
            autocomplete="new-password"
            errors={errors.confirmPassword}
          />
          {/* Keeps this device's notifications through the change; every
              other device's go with its session. */}
          {props.ctx.pwaEnabled && <PushEndpointField />}
          <SubmitButton label={t('CHANGE_PASSWORD')} />
        </Fieldset>
      </PostForm>
    </AccountShell>
  );
}

/**
 * Sign out everywhere (#700), behind the current password (step-up rule).
 * Not an `endsSession` form: this device stays signed in with a new cookie,
 * so the worker keeps its session caches, as after a new password.
 */
export function SignOutEverywherePage(props: {
  ctx: ViewContext;
  wrongPassword?: boolean;
}) {
  return (
    <AccountShell
      ctx={props.ctx}
      title={t(SIGN_OUT_EVERYWHERE_KEY)}
      back={profileSection(SIGN_OUT_SECTION_ID)}
    >
      <p class="text-sm text-muted">{t('profile.SIGN_OUT_EVERYWHERE_HINT')}</p>
      <PostForm action={SIGN_OUT_EVERYWHERE_PATH}>
        <Fieldset legend={t(SIGN_OUT_EVERYWHERE_KEY)}>
          <UsernameTwin email={props.ctx.user?.email} />
          <Field
            id="currentPassword"
            label={t('CURRENT_PASSWORD')}
            type="password"
            autocomplete="current-password"
            errors={
              props.wrongPassword ? [t('WRONG_CURRENT_PASSWORD')] : undefined
            }
          />
          {/* Keeps this device's notifications; every other device's go. */}
          {props.ctx.pwaEnabled && <PushEndpointField />}
          <SubmitButton label={t(SIGN_OUT_EVERYWHERE_KEY)} />
        </Fieldset>
      </PostForm>
    </AccountShell>
  );
}

export function DeleteAccountPage(props: {
  ctx: ViewContext;
  failed?: boolean;
}) {
  return (
    <AccountShell
      ctx={props.ctx}
      title={t('DELETE_ACCOUNT')}
      back={ACCOUNT_SECTION_PATH}
    >
      {props.failed && <ErrorAlert message={t('DELETE_ACCOUNT_FAILED')} />}
      <p class="text-sm text-muted">{t('DELETE_ACCOUNT_WARNING')}</p>
      <PostForm
        action="/auth/delete-account"
        confirm={t('DELETE_ACCOUNT_CONFIRMATION')}
        endsSession
      >
        <Fieldset legend={t('DELETE_ACCOUNT')}>
          <Field
            id="email"
            label={t('EMAIL')}
            type="email"
            autocomplete="username"
          />
          <Field
            id="password"
            label={t('PASSWORD')}
            type="password"
            autocomplete="current-password"
          />
          <SubmitButton label={t('DELETE_ACCOUNT')} variant="error" />
        </Fieldset>
      </PostForm>
    </AccountShell>
  );
}
