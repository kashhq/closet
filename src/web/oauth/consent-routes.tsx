import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  checkSignIn,
  enforceSignInLimits,
  failedSignInFor,
  type SignInLimits,
} from '../auth/sign-in';
import { Email, Password } from '../auth/validation';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { NotServed } from '../refusals';
import { renderPage } from '../render';
import { allowFormTarget } from '../security/csp';
import { enforceLimit, OAUTH_AUTHORIZE_LIMIT } from '../security/rate-limit';
import { type ViewContext, viewContext } from '../view-context';
import {
  checkAuthorizeQuery,
  clientIdUrl,
  type ConsentRequest,
  displayText,
  NAME_MAX,
  redirectMatches,
  redirectWith,
  URL_MAX,
} from './authorize-request';
import { fetchClientMetadata } from './client-metadata';
import { grantConsent } from './codes';
import {
  ConsentErrorPage,
  type ConsentFormState,
  ConsentPage,
} from './consent-page';
import { CONSENT_FIELD_MAX } from './consent-token';
import { AUTHORIZE_PATH } from './discovery';

// Any parameter, repeated or not: the ordered checks judge them, so a
// repeat is the right refusal for its place (authorize-request.ts), never
// the schema's 400 before the redirect URI is even looked at.
const AuthorizeQuery = Type.Record(Type.String(), Type.Unknown());

const ConsentBody = Type.Object({
  consent: Type.String({ maxLength: CONSENT_FIELD_MAX }),
  decision: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
  // Deny sends neither.
  email: Type.Optional(Email),
  password: Type.Optional(Password),
  name: Type.Optional(Type.String({ maxLength: 1024 })),
  writes: Type.Optional(Type.Literal('on')),
  ownWardrobeOnly: Type.Optional(Type.Literal('on')),
});

/**
 * `GET` and `POST /oauth/authorize` (#1290; src/web/oauth/AGENTS.md, plan
 * 4.2 steps 5-7, 4.4): the consent sheet, on SITE_URL (the tailnet) only.
 * The GET proves the request (the client's metadata document, the exact
 * redirect URI, then the rest) and renders the consent page with it signed
 * in one hidden field; the POST trusts that field alone, checks the email
 * and password as sign-in does, writes a one-time code and 303s it to the
 * client. Before the redirect URI is proven nothing points at it; after,
 * only the POST's outcome (a code, or `access_denied`) redirects: a GET
 * refusal is a page with a link the user taps (decisions 2026-11-28).
 *
 * Every answer is `no-store` and `Referrer-Policy: same-origin` (the
 * query carries the challenge and state; `no-referrer` would null the
 * POST's Origin, which the same-origin hook needs). Both are `secretPath`.
 */
export const oauthConsentRoutes: FastifyPluginCallbackTypebox<
  WebOptions & SignInLimits
> = (
  app,
  { config, db, logger, fetcher, consentTokens, signInLimits },
  done,
) => {
  const log = logger.child({ logger: 'OAuth' });
  const { oauth } = config;
  const authorizeLimit = app.createRateLimit(OAUTH_AUTHORIZE_LIMIT);
  const siteHost = new URL(config.siteUrl).host;
  const mcpHost = oauth && new URL(oauth.resource).host;

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  // onSend, after the root's (which sets every response's policy).
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });

  /** OAuth's settings, or the 404 a missing route would be. */
  const servedHere = (request: FastifyRequest) => {
    if (oauth === undefined) {
      throw new NotServed({ logDetail: 'OAuth off (MCP_PUBLIC_URL unset)' });
    }
    // Defence in depth behind the gate, which forwards no /oauth/authorize.
    if (request.host === mcpHost && mcpHost !== siteHost) {
      throw new NotServed({ logDetail: 'the consent asked on the MCP host' });
    }
    return oauth;
  };

  // The page is never the session's: no dock, whoever is signed in here.
  const signedOut = (reply: FastifyReply): ViewContext => ({
    ...viewContext(reply),
    user: undefined,
  });

  const refusal = (reply: FastifyReply, message: string, returnTo?: string) =>
    renderPage(
      reply,
      <ConsentErrorPage
        ctx={signedOut(reply)}
        message={message}
        returnTo={returnTo}
      />,
      { status: 400 },
    );

  const consentPage = (
    reply: FastifyReply,
    request: ConsentRequest,
    field: string,
    form: ConsentFormState,
    status?: { status: number; refusal: 'credentials' | 'full' },
  ) => {
    // The POST's 303 to the client follows this page's form (csp.ts).
    allowFormTarget(reply, new URL(request.redirectUri));
    return renderPage(
      reply,
      <ConsentPage
        ctx={signedOut(reply)}
        request={request}
        field={field}
        form={form}
        refusal={status?.refusal}
      />,
      status && { status: status.status },
    );
  };

  app.get(
    AUTHORIZE_PATH,
    {
      // A HEAD would fetch the client's document for nothing.
      exposeHeadRoute: false,
      config: { public: true, secretPath: true },
      schema: { querystring: AuthorizeQuery },
      // Before anything is read: every request costs an outbound fetch.
      onRequest: (request) =>
        enforceLimit(authorizeLimit, request, { logger: log, who: request.ip }),
    },
    async (request, reply) => {
      const { resource, issuer } = servedHere(request);
      const { query } = request;
      const clientId = clientIdUrl(query.client_id);
      if (clientId === undefined) {
        log.warn('Authorization request refused: no client metadata URL');
        return refusal(reply, t('oauth.CLIENT_UNREADABLE'));
      }
      const client = await fetchClientMetadata(fetcher, clientId, log);
      if (client === undefined) {
        return refusal(reply, t('oauth.CLIENT_UNREADABLE'));
      }
      const redirectUri = query.redirect_uri;
      if (
        typeof redirectUri !== 'string' ||
        redirectUri.length > URL_MAX ||
        !redirectMatches(client.redirectUris, redirectUri)
      ) {
        log.warn(
          `Authorization request from ${clientId.hostname} refused: a redirect_uri its document does not list`,
        );
        return refusal(reply, t('oauth.REDIRECT_UNLISTED'));
      }
      const check = checkAuthorizeQuery(query, client, redirectUri, resource);
      if (!check.ok) {
        log.warn(
          `Authorization request from ${clientId.hostname} refused: ${check.error}`,
        );
        return refusal(
          reply,
          t('oauth.REFUSED', { error: check.error }),
          redirectWith(redirectUri, {
            error: check.error,
            state: check.state,
            iss: issuer,
          }),
        );
      }
      log.info(`Consent page for ${clientId.hostname}`);
      return consentPage(
        reply,
        check.request,
        consentTokens.sign(check.request),
        // Prefilled only: the POST never reads the session.
        { email: request.auth?.user.email ?? undefined },
      );
    },
  );

  app.post(
    AUTHORIZE_PATH,
    {
      config: { public: true, secretPath: true, sessionless: true },
      schema: { body: ConsentBody },
      // After the body's schema, which says which budget pays. Allow checks
      // a password, so SIGN_IN_LIMIT and SIGN_IN_ACCOUNT_LIMIT, one budget
      // with the login and the API's device sign-in (sign-in.ts). Deny
      // checks nothing and names no email: on the account budget every
      // Deny would share one '' bucket, so it counts per address on the
      // GET's OAUTH_AUTHORIZE_LIMIT alone.
      preHandler: (request) =>
        request.body.decision === 'allow'
          ? enforceSignInLimits(signInLimits, request, log)
          : enforceLimit(authorizeLimit, request, {
              logger: log,
              who: request.ip,
            }),
    },
    async (request, reply) => {
      const { issuer, resource } = servedHere(request);
      const { body } = request;
      const verified = consentTokens.verify(body.consent);
      if (!verified.ok) {
        log.warn(`Consent refused: a ${verified.reason} request field`);
        return refusal(
          reply,
          t(verified.reason === 'expired' ? 'oauth.EXPIRED' : 'oauth.INVALID'),
        );
      }
      const consent = verified.request;
      const clientHost = new URL(consent.clientId).hostname;
      // The one redirect of the flow, to the URI the signed field carries.
      const toClient = (params: { code: string } | { error: string }) =>
        reply.redirect(
          redirectWith(consent.redirectUri, {
            ...params,
            state: consent.state,
            iss: issuer,
          }),
          303,
        );
      if (body.decision === 'deny') {
        log.info(`Consent denied to ${clientHost}`);
        return toClient({ error: 'access_denied' });
      }
      const form: ConsentFormState = {
        email: body.email,
        name: body.name,
        writes: body.writes === 'on',
        ownWardrobeOnly: body.ownWardrobeOnly === 'on',
      };
      const again = (refusal: 'credentials' | 'full') =>
        consentPage(reply, consent, body.consent, form, {
          status: 400,
          refusal,
        });
      // The sign-in's own check: one bcrypt either way, one refusal text.
      const check = await checkSignIn(
        db,
        body.email ?? '',
        body.password ?? '',
      );
      if (!check.ok) {
        log.warn(`Failed consent for ${failedSignInFor(check)}`);
        return again('credentials');
      }
      const result = await grantConsent(
        { db, logger },
        { userId: check.account.id, surface: 'page' },
        {
          request: consent,
          resource,
          name: displayText(body.name ?? '', NAME_MAX) || consent.clientName,
          scope: {
            readOnly: !(consent.writeRequested && form.writes),
            ownWardrobeOnly: form.ownWardrobeOnly === true,
          },
          verifiedPassword: check.account.password,
        },
      );
      if (!result.granted) {
        log.warn(
          `Consent for user ${check.account.id} refused: ${result.reason}`,
        );
        return again(result.reason === 'too-many' ? 'full' : 'credentials');
      }
      return toClient({ code: result.code });
    },
  );

  done();
};
