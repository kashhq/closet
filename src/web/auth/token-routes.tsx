import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { RowId } from '../schemas';
import { ACCOUNT_LIMIT } from '../security/rate-limit';
import { viewContext } from '../view-context';
import {
  createToken,
  listTokens,
  revokeToken,
  TOKEN_NAME_MAX,
  type TokenListing,
  type TokenScope,
} from './personal-tokens';
import { verifyPassword } from './passwords';
import { sessionUserId } from './require-session';
import { sessionAccount } from './session';
import { TokensPage } from './tokens-page';
import {
  DEVICES_PATH,
  DEVICES_SECTION_ID,
  PROFILE_PATH,
  revokeNotice,
  TOKENS_PATH,
} from './urls';
import { Password } from './validation';

const TokensQuery = Type.Object({
  // Navigation state from the revoke redirect (1: revoked, 0: nothing to
  // revoke); anything else shows nothing.
  revoked: Type.Optional(Type.String()),
});

// A longer name is a 400 (the input carries the same maxlength); a blank one
// re-renders the page with a message.
// The scope's two checkboxes (#701), each absent unless ticked: a token
// that may write and one confined to the user's own wardrobe are asked
// for, so a form posted without them mints the narrowest read.
const CreateTokenBody = Type.Object({
  name: Type.String({ maxLength: TOKEN_NAME_MAX }),
  currentPassword: Password,
  writes: Type.Optional(Type.Literal('on')),
  ownWardrobeOnly: Type.Optional(Type.Literal('on')),
});

const TokenParams = Type.Object({ id: RowId });

/**
 * The profile's "Agent access" (#33): create, list and revoke the MCP
 * endpoint's personal access tokens (src/web/auth/personal-tokens.ts, kind
 * `mcp`), and revoke the profile's Devices (kind `device`, #189; minted by
 * a native client's sign-in, never here). Every form is a native post
 * (PostForm). A token's scope (#701: read-only unless "can make changes"
 * is ticked, optionally own wardrobe only) is chosen here and never changed
 * after: a wider one is a new token. Creating needs the current password (a token is a credential
 * that survives signing out) and answers the page with the token in it,
 * once, and `no-store`, so no cache keeps it; rate-limited like the other
 * routes that check the password. Revoking needs no password: it only
 * narrows access. A revoke that finds nothing to revoke (a stale tab's
 * second tap, an id that is not the caller's) lands on the same page with a
 * notice, never an error page, and alike for every such id.
 */
export const tokenRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  app.get(
    TOKENS_PATH,
    { schema: { querystring: TokensQuery } },
    async (request, reply) =>
      renderPage(
        reply,
        <TokensPage
          ctx={viewContext(reply)}
          tokens={await listTokens(db, sessionUserId(request), 'mcp')}
          timeZone={config.timeZone}
          notice={revokeNotice(request.query.revoked)}
        />,
      ),
  );

  app.post(
    TOKENS_PATH,
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: CreateTokenBody },
    },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const name = request.body.name.trim();
      const scope: TokenScope = {
        readOnly: request.body.writes === undefined,
        ownWardrobeOnly: request.body.ownWardrobeOnly !== undefined,
      };
      // The form again with what was typed, the password never echoed.
      // `tokens`: the list when the caller already read it (createToken's).
      const refuse = async ({
        notice,
        passwordError,
        tokens,
      }: {
        notice?: 'name-required' | 'too-many';
        passwordError?: string;
        tokens?: TokenListing[];
      }) =>
        renderPage(
          reply,
          <TokensPage
            ctx={viewContext(reply)}
            tokens={tokens ?? (await listTokens(db, userId, 'mcp'))}
            timeZone={config.timeZone}
            notice={notice}
            form={{ name: request.body.name, scope, passwordError }}
          />,
          { status: 400 },
        );
      if (!name) return refuse({ notice: 'name-required' });

      // Step-up, as for every route that hands out or changes a credential:
      // a token outlives signing out, so a borrowed unlocked phone or a
      // stolen cookie must not be enough to mint one.
      const { password } = sessionAccount(request);
      if (!(await verifyPassword(request.body.currentPassword, password))) {
        logger.info(`Token refused for user ${userId}: wrong current password`);
        return refuse({ passwordError: t('WRONG_CURRENT_PASSWORD') });
      }

      const result = await createToken(
        { db, logger },
        {
          userId,
          kind: 'mcp',
          name,
          scope,
          verifiedPassword: password,
        },
      );
      if (!result.created) {
        logger.warn(`Token refused for user ${userId}: ${result.reason}`);
        // The password moved between the check and the mint: ask for the
        // one in force now (whoever changed it signed this session out, so
        // the next request is the login page anyway).
        return result.reason === 'password-changed'
          ? refuse({ passwordError: t('agentAccess.PASSWORD_CHANGED') })
          : refuse({ notice: result.reason, tokens: result.tokens });
      }
      logger.info(
        `User ${userId} created access token ${result.id} (${scope.readOnly ? 'read-only' : 'read-write'}${scope.ownWardrobeOnly ? ', own wardrobe only' : ''})`,
      );
      // The only time the token exists in a response: nothing may store it.
      reply.header('Cache-Control', 'no-store');
      return renderPage(
        reply,
        <TokensPage
          ctx={viewContext(reply)}
          tokens={result.tokens}
          timeZone={config.timeZone}
          created={{ name, token: result.token }}
        />,
      );
    },
  );

  app.post(
    `${TOKENS_PATH}/:id/revoke`,
    { schema: { params: TokenParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      const revoked = await revokeToken(db, userId, 'mcp', id);
      logRevoke(userId, 'access token', id, revoked);
      return reply.redirect(`${TOKENS_PATH}?revoked=${revoked ? 1 : 0}`, 303);
    },
  );

  // Profile › Devices: a native client's sign-in, revoked from the web.
  app.post(
    `${DEVICES_PATH}/:id/revoke`,
    { schema: { params: TokenParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      const revoked = await revokeToken(db, userId, 'device', id);
      logRevoke(userId, 'device token', id, revoked);
      return reply.redirect(
        `${PROFILE_PATH}?deviceRevoked=${revoked ? 1 : 0}#${DEVICES_SECTION_ID}`,
        303,
      );
    },
  );

  function logRevoke(
    userId: number,
    what: string,
    id: number,
    revoked: boolean,
  ) {
    logger.info(
      revoked
        ? `User ${userId} revoked ${what} ${id}`
        : `User ${userId} found no ${what} ${id} to revoke`,
    );
  }

  done();
};
