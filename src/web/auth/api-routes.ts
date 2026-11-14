import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { todayIn } from '../../calendar-date';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { IsoDateSchema } from '../schemas';
import { actorOf } from '../sharing/access';
import {
  createToken,
  FULL_SCOPE,
  revokeToken,
  TOKEN_NAME_MAX,
} from './personal-tokens';
import { checkSignIn, failedSignInFor, signInGuards } from './sign-in';
import { Email, Password } from './validation';

const TokenSignInBody = Type.Object({
  email: Email,
  password: Password,
  // The name Profile › Devices lists it under; never blank.
  deviceName: Type.String({
    minLength: 1,
    maxLength: TOKEN_NAME_MAX,
    pattern: '\\S',
  }),
});

const DeviceToken = Type.Object(
  {
    /** Shown once: the client keeps it, the server only its hash. */
    token: Type.String(),
    /** Profile › Devices' row; logs name it, never the token. */
    tokenId: Type.Integer(),
  },
  { title: 'DeviceToken', description: 'Signed in: the device token' },
);

const Me = Type.Object(
  {
    id: Type.Integer(),
    email: Type.Optional(Type.String()),
    /** APP_TIMEZONE: the household's zone, whose day `today` is. */
    timeZone: Type.String(),
    /** The household's today (todayIn), the day a wear or wash defaults to. */
    today: IsoDateSchema,
    /**
     * What this server has, decided at registration: a client reads it here
     * rather than guessing from a 404 (src/web/api/AGENTS.md).
     */
    features: Type.Object(
      {
        weather: Type.Boolean({
          description:
            'WEATHER_ENABLED: the /weather routes, GET and PUT /trips/{id}/weather and destination exist',
        }),
        push: Type.Boolean({
          description: 'PWA_ENABLED: Web Push (the /push routes) exists',
        }),
      },
      { title: 'Features' },
    ),
    /** The build: the same release /health/ready reports as `version`. */
    version: Type.String({
      description: 'The server build, as `version` on /health/ready',
    }),
  },
  { title: 'Me', description: 'The account the token acts as' },
);

/**
 * The API's account routes (#190; plan section 3), registered by apiPlugin
 * under /api/v1:
 *  - POST /auth/token: a native client signs in and gets a device token,
 *    public, under the login page's own SIGN_IN_LIMIT and
 *    SIGN_IN_ACCOUNT_LIMIT budgets (signInGuards: one of each for both
 *    doors). It sets no cookie.
 *  - DELETE /auth/token: signs this device out, revoking the calling token
 *    and nothing else.
 *  - GET /me: who the token acts as, the household's day, the server's
 *    features and build.
 */
export const authApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, weather, apiLogger: logger, signInLimits },
  done,
) => {
  app.post(
    '/auth/token',
    {
      config: { public: true },
      ...signInGuards(signInLimits, logger),
      schema: {
        operationId: 'signIn',
        tags: ['auth'],
        summary: 'Sign a device in: a device token for this account',
        security: [],
        body: TokenSignInBody,
        response: apiResponses({ 201: DeviceToken }),
      },
    },
    async (request, reply) => {
      const { email, password, deviceName } = request.body;
      // One bcrypt comparison on every path (checkSignIn), and one answer
      // for an unknown email, a wrong password and a password that moved.
      const check = await checkSignIn(db, email, password);
      if (!check.ok) {
        logger.warn(
          `Failed API sign-in for ${failedSignInFor(check)} from ${request.ip}`,
        );
        throw new HttpError(401, t('LOGIN_FAILED'));
      }
      const { account } = check;
      const result = await createToken(
        { db, logger },
        { userId: account.id, surface: 'api' },
        {
          kind: 'device',
          name: deviceName.trim(),
          scope: FULL_SCOPE,
          verifiedPassword: account.password,
          address: request.ip,
        },
      );
      // A device at the cap evicts, never refuses: only a password changed
      // (or the account deleted) since the check refuses a device token.
      if (!result.created) {
        logger.warn(
          `API sign-in for user ${account.id} refused: ${result.reason} (the password moved or the account went during the sign-in)`,
        );
        throw new HttpError(401, t('LOGIN_FAILED'));
      }
      // The only time the token exists in a response: nothing may store it.
      reply.header('Cache-Control', 'no-store').status(201);
      return { token: result.token, tokenId: result.id };
    },
  );

  app.delete(
    '/auth/token',
    {
      schema: {
        operationId: 'signOut',
        tags: ['auth'],
        summary: 'Sign this device out: revoke the calling token',
        response: apiResponses({
          204: Type.Null({ description: 'Signed out' }),
        }),
      },
    },
    async (request, reply) => {
      const { tokenId } = request.accessToken!;
      // Unchanged only when something revoked it since this request
      // authenticated (a new password, Profile › Devices): signed out
      // either way, which is what the client asked for.
      await revokeToken({ db, logger }, actorOf(request), 'device', tokenId);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/me',
    {
      schema: {
        operationId: 'getMe',
        tags: ['auth'],
        summary: 'Who the token acts as, and the household day',
        response: apiResponses({ 200: Me }),
      },
    },
    (request) => {
      const { user } = request.accessToken!;
      return {
        id: user.id,
        ...(user.email === null ? {} : { email: user.email }),
        timeZone: config.timeZone,
        today: todayIn(config.timeZone, new Date()),
        features: { weather: weather !== undefined, push: config.pwaEnabled },
        version: config.release,
      };
    },
  );

  done();
};
