import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { LOGIN_PATH } from './login-path';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { requestOrigin } from '../security/origin';
import { ACCOUNT_LIMIT, SIGN_IN_LIMIT } from '../security/rate-limit';
import { viewContext } from '../view-context';
import { parseRefusal } from '../sharing/pages';
import { sharesOf } from '../sharing/queries';
import { SHARE_ERROR_PARAM } from '../sharing/urls';
import { brandSizesOf, findMeasurements } from '../sizes/queries';
import { findWeatherSettings } from '../weather/queries';
import { deleteAccount } from './account';
import { InlineErrors } from './form';
import { LOGOUT_PATH } from './logout';
import {
  checkSignIn,
  failedSignInFor,
  type SignInLimits,
  signInGuards,
} from './sign-in';
import { PROFILE_PATH, revokeNotice, SIGN_OUT_EVERYWHERE_PATH } from './urls';
import { loginUrl, REGISTER_PATH, signInReturnTo } from './return-to';
import {
  ChangePasswordPage,
  DeleteAccountPage,
  LoginPage,
  LogoutPage,
  ProfilePage,
  REGISTER_FIELDS,
  RegisterPage,
  SignOutEverywherePage,
  UPDATE_EMAIL_FIELDS,
  UpdateEmailPage,
} from './pages';
import { hashPassword, setPassword, verifyPassword } from './passwords';
import { listTokens } from './personal-tokens';
import {
  endOtherSessions,
  insertUser,
  normalizeEmail,
  updateEmail,
} from './queries';
import { sessionUserId } from './require-session';
import { findWeekTemplate } from '../week-plan/template';
import {
  endSession,
  sessionAccount,
  setSessionCookie,
  startSession,
} from './session';
import {
  ChangePasswordBody,
  SignOutEverywhereBody,
  DeleteAccountBody,
  type FieldErrors,
  hasErrors,
  LoginBody,
  RegisterBody,
  UpdateEmailBody,
  UpdateEmailFields,
  validateEmailChange,
  validatePasswordChange,
  validateRegistration,
} from './validation';

// Navigation state: one-shot flags and a refusal code, each shown or not;
// no value is a 400.
const ProfileQuery = Type.Object({
  passwordChanged: Type.Optional(Type.String()),
  signedOutEverywhere: Type.Optional(Type.String()),
  // Profile › Devices' revoke redirect (1: signed out, 0: nothing to sign
  // out); anything else shows nothing.
  deviceRevoked: Type.Optional(Type.String()),
  // The week template's saved toast (#16, src/web/week-plan).
  weekSaved: Type.Optional(Type.String()),
  // Why an invite could not be accepted (Sharing, src/web/sharing).
  [SHARE_ERROR_PARAM]: Type.Optional(Type.String()),
});

// The login and registration pages' URL state: the page to return to after
// signing in (return-to.ts). Unknown, so a repeated parameter is the `/`
// fallback, never a 400.
const SignInQuery = Type.Object({ returnTo: Type.Optional(Type.Unknown()) });

/**
 * The sign-in pages carry their returnTo, which may hold an invite token:
 * `secretPath` keeps it out of the access line, and every render of them is
 * `no-store`, so neither the HTTP cache nor the service worker's page cache
 * keeps the token (#661).
 */
const SIGN_IN_PAGE = { public: true, secretPath: true } as const;

function renderSignInPage(
  reply: FastifyReply,
  page: JSX.Element,
  options?: { status: number },
) {
  reply.header('Cache-Control', 'no-store');
  return renderPage(reply, page, options);
}

/** The sign-in log line's note when it replaced another account's session. */
const replacedNote = (replaced: number | undefined) =>
  replaced === undefined
    ? ''
    : `, replacing user ${replaced}'s session: Clear-Site-Data sent`;

/**
 * /auth: sign in and out, registration, and the account pages (profile,
 * email, password, deletion). Sign-in, registration and logout are public;
 * the account pages need a session like every route. Every form is a native
 * POST (see form.tsx); a refusal re-renders its page with a 4xx.
 */
export const authRoutes: FastifyPluginCallbackTypebox<
  WebOptions & SignInLimits
> = (
  app,
  { config, db, tokens, photos, logger, weather, signInLimits },
  done,
) => {
  // DISABLE_REGISTRATION: every registration route sends the visitor to the
  // login page. onRequest, so a closed registration never reads a body.
  // A returnTo in the query goes along (the invite's register link); a
  // post's is in its body, unread at onRequest.
  const registrationOpen = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (!config.registrationDisabled) return;
    const query = request.query as Record<string, unknown> | undefined;
    return reply.redirect(loginUrl(query?.returnTo), 302);
  };

  app.get(
    LOGIN_PATH,
    { config: SIGN_IN_PAGE, schema: { querystring: SignInQuery } },
    async (request, reply) =>
      renderSignInPage(
        reply,
        <LoginPage
          ctx={viewContext(reply)}
          returnTo={signInReturnTo(request.query.returnTo)}
        />,
      ),
  );

  app.post(
    '/auth/login',
    {
      config: { public: true },
      // SIGN_IN_LIMIT and SIGN_IN_ACCOUNT_LIMIT, each one budget with the
      // API's device sign-in (sign-in.ts).
      ...signInGuards(signInLimits, logger),
      schema: { body: LoginBody },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const returnTo = signInReturnTo(request.body.returnTo);
      // One message for an unknown email and a wrong password, at one cost.
      const check = await checkSignIn(db, email, password);
      if (!check.ok) {
        logger.warn(`Failed login for ${failedSignInFor(check)}`);
        return renderSignInPage(
          reply,
          <LoginPage
            ctx={viewContext(reply)}
            failed={{ email }}
            returnTo={returnTo}
          />,
          { status: 401 },
        );
      }
      const { account } = check;
      const replaced = startSession(
        request,
        reply,
        account.id,
        tokens.issue(account),
      );
      logger.info(`User ${account.id} signed in${replacedNote(replaced)}`);
      // Never logged: the target can be an invite page, its token the path.
      return reply.redirect(returnTo, 302);
    },
  );

  // Only a same-origin POST signs out (the same-origin hook refuses any
  // other), so a cross-site link or image cannot. The service worker never
  // relays it (#542); the sign-out form tells it to drop its session caches
  // as the post leaves (data-ends-session). Public: a stale tab signing out
  // again still gets the cookie cleared and lands on the login page.
  app.post(LOGOUT_PATH, { config: { public: true } }, async (req, reply) => {
    if (req.auth) logger.info(`User ${req.auth.user.id} signed out`);
    endSession(reply);
    return reply.redirect(LOGIN_PATH, 303);
  });

  // Pages cached by the installed app before logout became a POST still
  // link here: ask with a one-button form instead of signing out on a GET.
  app.get(LOGOUT_PATH, { config: { public: true } }, async (req, reply) =>
    req.auth
      ? renderPage(reply, <LogoutPage ctx={viewContext(reply)} />)
      : reply.redirect(LOGIN_PATH, 302),
  );

  app.get(
    REGISTER_PATH,
    {
      config: SIGN_IN_PAGE,
      onRequest: registrationOpen,
      schema: { querystring: SignInQuery },
    },
    async (request, reply) =>
      renderSignInPage(
        reply,
        <RegisterPage
          ctx={viewContext(reply)}
          returnTo={signInReturnTo(request.query.returnTo)}
        />,
      ),
  );

  app.post(
    REGISTER_PATH,
    {
      config: { public: true, rateLimit: SIGN_IN_LIMIT },
      onRequest: registrationOpen,
      schema: { body: RegisterBody },
    },
    async (request, reply) => {
      const body = request.body;
      const email = normalizeEmail(body.email);
      const returnTo = signInReturnTo(body.returnTo);
      const refuse = (errors: ReturnType<typeof validateRegistration>) =>
        renderSignInPage(
          reply,
          <RegisterPage
            ctx={viewContext(reply)}
            input={{ email: body.email }}
            errors={errors}
            returnTo={returnTo}
          />,
          { status: 400 },
        );

      const errors = validateRegistration(body);
      if (hasErrors(errors)) return refuse(errors);

      // The insert is the check: no row back means the address is taken,
      // however recently (insertUser). The hash comes first, so a taken
      // address costs what a free one does.
      const account = await insertUser(
        db,
        email,
        await hashPassword(body.password),
      );
      if (!account) {
        logger.info('Registration refused: the email is taken');
        return refuse({ email: [t('EMAIL_IN_USE')] });
      }
      const replaced = startSession(
        request,
        reply,
        account.id,
        tokens.issue(account),
      );
      logger.info(`User ${account.id} registered${replacedNote(replaced)}`);
      return reply.redirect(returnTo, 302);
    },
  );

  // Inline validation while the form is filled in: the message slots, swapped
  // out of band. A 200 whatever it finds: a field's message is the answer,
  // not a failure of the request (so not the error handler's toast, #642).
  app.post(
    '/auth/validate/register',
    {
      config: { public: true },
      onRequest: registrationOpen,
      schema: { body: RegisterBody },
    },
    async (request, reply) =>
      renderFragment(
        reply,
        <InlineErrors
          fields={REGISTER_FIELDS}
          errors={validateRegistration(request.body)}
        />,
      ),
  );

  // Profile: the signed-in user's own settings, whoever asks; no route
  // here reads another user's.
  app.get(
    PROFILE_PATH,
    { schema: { querystring: ProfileQuery } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const { query } = request;
      const [slots, weatherSettings, shares, tokenList, measurements, brands] =
        await Promise.all([
          findWeekTemplate(db, id),
          weather && findWeatherSettings(db, id),
          sharesOf(db, id),
          // Both kinds in one statement: Agent Access and Devices split it.
          listTokens(db, id),
          findMeasurements(db, id),
          brandSizesOf(db, id),
        ]);
      return renderPage(
        reply,
        <ProfilePage
          ctx={viewContext(reply)}
          passwordChanged={query.passwordChanged === '1'}
          signedOutEverywhere={query.signedOutEverywhere === '1'}
          week={{ slots, saved: query.weekSaved === '1' }}
          weather={
            weatherSettings && {
              settings: weatherSettings,
              timeZone: config.timeZone,
              now: new Date(),
            }
          }
          sharing={{
            ...shares,
            origin: requestOrigin(request),
            refusal: parseRefusal(query[SHARE_ERROR_PARAM]),
          }}
          tokens={tokenList.filter((token) => token.kind === 'mcp')}
          devices={{
            tokens: tokenList.filter((token) => token.kind === 'device'),
            timeZone: config.timeZone,
            now: new Date(),
            notice: revokeNotice(query.deviceRevoked),
          }}
          sizes={{ measurements, brands }}
        />,
      );
    },
  );

  app.get('/auth/update-email', async (_request, reply) =>
    renderPage(reply, <UpdateEmailPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/validate/update-email',
    { schema: { body: UpdateEmailFields } },
    async (request, reply) =>
      renderFragment(
        reply,
        <InlineErrors
          fields={UPDATE_EMAIL_FIELDS}
          errors={validateEmailChange(request.body)}
        />,
      ),
  );

  app.post(
    '/auth/update-email',
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: UpdateEmailBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const body = request.body;
      const email = normalizeEmail(body.email);
      const refuse = (errors: FieldErrors<keyof UpdateEmailBody>) =>
        renderPage(
          reply,
          <UpdateEmailPage
            ctx={viewContext(reply)}
            input={{ email: body.email, confirmEmail: body.confirmEmail }}
            errors={errors}
          />,
          { status: 400 },
        );

      const errors = validateEmailChange(body);
      if (hasErrors(errors)) return refuse(errors);

      // The password before the clash check: whether an address is taken is
      // only answered to someone who proved they own this account.
      const { password } = sessionAccount(request);
      if (!(await verifyPassword(body.currentPassword, password))) {
        logger.info(
          `Email change refused for user ${id}: wrong current password`,
        );
        return refuse({ currentPassword: [t('WRONG_CURRENT_PASSWORD')] });
      }

      // The update is the clash check (updateEmail): false when another
      // account has the address.
      if (!(await updateEmail(db, id, email))) {
        logger.info(`Email change refused for user ${id}: the email is taken`);
        return refuse({ email: [t('EMAIL_IN_USE')] });
      }
      logger.info(`User ${id} changed their email`);
      return reply.redirect(PROFILE_PATH, 302);
    },
  );

  app.get('/auth/change-password', async (_request, reply) =>
    renderPage(reply, <ChangePasswordPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/change-password',
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: ChangePasswordBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const body = request.body;
      const refuse = (errors: ReturnType<typeof validatePasswordChange>) =>
        renderPage(
          reply,
          <ChangePasswordPage ctx={viewContext(reply)} errors={errors} />,
          { status: 400 },
        );

      const errors = validatePasswordChange(body);
      if (hasErrors(errors)) return refuse(errors);

      const { password } = sessionAccount(request);
      if (!(await verifyPassword(body.currentPassword, password))) {
        logger.info(
          `Password change refused for user ${id}: wrong current password`,
        );
        return refuse({ currentPassword: [t('WRONG_CURRENT_PASSWORD')] });
      }
      // The new hash changes the fingerprint in every token, this session's
      // included: replace this one so the user stays signed in here. Its
      // push subscription, named by the form, stays too.
      const {
        account: updated,
        revokedTokens,
        revokedDevices,
        revokedInvites,
      } = await setPassword(db, id, body.newPassword, {
        endpoint: body.pushEndpoint || undefined,
      });
      setSessionCookie(reply, tokens.issue(updated));
      logger.info(
        `Password changed for user ${id}: other sessions, ${revokedTokens.mcp} MCP tokens, ${revokedTokens.device} device tokens, ${revokedDevices} other push devices and ${revokedInvites} unanswered invites revoked`,
      );
      return reply.redirect(`${PROFILE_PATH}?passwordChanged=1`, 302);
    },
  );

  app.get(SIGN_OUT_EVERYWHERE_PATH, async (_request, reply) =>
    renderPage(reply, <SignOutEverywherePage ctx={viewContext(reply)} />),
  );

  // Sign out everywhere (#700): every other session, device token and push
  // subscription ends (endOtherSessions); this one continues on a cookie
  // issued from the bump's own row. Behind the password (step-up rule).
  app.post(
    SIGN_OUT_EVERYWHERE_PATH,
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: SignOutEverywhereBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const { password } = sessionAccount(request);
      if (!(await verifyPassword(request.body.currentPassword, password))) {
        logger.info(
          `Sign out everywhere refused for user ${id}: wrong current password`,
        );
        return renderPage(
          reply,
          <SignOutEverywherePage ctx={viewContext(reply)} wrongPassword />,
          { status: 400 },
        );
      }
      const {
        account: bumped,
        revokedTokens,
        revokedDevices,
      } = await endOtherSessions(db, id, {
        endpoint: request.body.pushEndpoint || undefined,
      });
      setSessionCookie(reply, tokens.issue(bumped));
      logger.info(
        `User ${id} signed out everywhere: sessions before version ${bumped.sessionVersion}, ${revokedTokens.device} device tokens and ${revokedDevices} other push devices revoked`,
      );
      return reply.redirect(`${PROFILE_PATH}?signedOutEverywhere=1`, 302);
    },
  );

  app.get('/auth/delete-account', async (_request, reply) =>
    renderPage(reply, <DeleteAccountPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/delete-account',
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: DeleteAccountBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const account = sessionAccount(request);
      // The credentials must be this account's own, not any account's.
      const passwordMatches = await verifyPassword(
        request.body.password,
        account.password,
      );
      const emailMatches =
        account.email != null &&
        normalizeEmail(account.email) === normalizeEmail(request.body.email);
      if (!passwordMatches || !emailMatches) {
        logger.warn(
          `Account deletion refused for user ${id}: wrong credentials`,
        );
        return renderPage(
          reply,
          <DeleteAccountPage ctx={viewContext(reply)} failed />,
          { status: 401 },
        );
      }

      await deleteAccount({ db, photos, logger }, id);
      endSession(reply);
      return reply.redirect('/', 302);
    },
  );

  done();
};
