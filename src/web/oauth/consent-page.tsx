import { AccountShell } from '../auth/account-shell';
import { ErrorAlert, Field, ScopeToggle, SubmitButton } from '../auth/form';
import { MAX_ACTIVE_TOKENS } from '../auth/personal-tokens';
import { PostForm } from '../form';
import { t, tAround } from '../i18n';
import type { ViewContext } from '../view-context';
import {
  type ConsentRequest,
  isLoopbackRedirect,
  NAME_MAX,
} from './authorize-request';
import { AUTHORIZE_PATH } from './discovery';

/**
 * The consent page (#1290; plan 4.4), in the agent app's browser sheet: the
 * redirect's host is the headline, the line the user must read (MCP's
 * MUST); the client's name is only what it calls itself, attributed and
 * never in Closet's voice, since its document is self-asserted. Read-only
 * and own-wardrobe-only by default whatever the client asked. Email and
 * password every time: no session is read or kept.
 */
export interface ConsentFormState {
  email?: string;
  name?: string;
  writes?: boolean;
  ownWardrobeOnly?: boolean;
}

export function ConsentPage(props: {
  ctx: ViewContext;
  request: ConsentRequest;
  /** The signed request (consent-token.ts), the POST's one trusted input. */
  field: string;
  form: ConsentFormState;
  refusal?: 'credentials' | 'full';
}) {
  const { request, form } = props;
  const redirectHost = new URL(request.redirectUri).hostname;
  const clientHost = new URL(request.clientId).hostname;
  const loopback = isLoopbackRedirect(request.redirectUri);
  const [before, after] = tAround('oauth.SENDS_TO', 'host', {
    appName: props.ctx.appName,
  });
  return (
    <AccountShell ctx={props.ctx} title={t('oauth.TITLE')}>
      <div class="flex w-full max-w-xs flex-col gap-3">
        <p class="text-lg">
          {before}
          <strong>{redirectHost}</strong>
          {after}
        </p>
        <p class="text-sm text-muted">
          {t('oauth.CALLS_ITSELF', {
            name: request.clientName,
            host: clientHost,
          })}
        </p>
        {loopback ? (
          <div role="status" class="alert alert-info">
            <span>{t('oauth.LOOPBACK')}</span>
          </div>
        ) : (
          clientHost !== redirectHost && (
            <div role="alert" class="alert alert-warning">
              <span>
                {t('oauth.HOST_MISMATCH', {
                  listed: clientHost,
                  host: redirectHost,
                })}
              </span>
            </div>
          )
        )}
      </div>
      {props.refusal === 'credentials' && (
        <ErrorAlert message={t('LOGIN_FAILED')} />
      )}
      {props.refusal === 'full' && (
        <ErrorAlert message={t('oauth.FULL', { max: MAX_ACTIVE_TOKENS })} />
      )}
      <PostForm
        action={AUTHORIZE_PATH}
        class="flex w-full max-w-xs flex-col gap-2"
      >
        <ConsentField field={props.field} decision="allow" />
        <fieldset class="flex flex-col gap-2 py-1">
          <legend class="text-sm mb-1">{t('oauth.SCOPE')}</legend>
          {request.writeRequested && (
            <ScopeToggle
              name="writes"
              label={t('agentAccess.WRITES')}
              hint={t('agentAccess.WRITES_HINT')}
              checked={form.writes === true}
            />
          )}
          <ScopeToggle
            name="ownWardrobeOnly"
            label={t('agentAccess.OWN_ONLY')}
            hint={t('agentAccess.OWN_ONLY_HINT')}
            checked={form.ownWardrobeOnly ?? true}
          />
        </fieldset>
        <label class="flex flex-col gap-1">
          <span class="text-sm">{t('oauth.NAME')}</span>
          <input
            type="text"
            name="name"
            class="input input-bordered w-full"
            value={form.name ?? request.clientName}
            maxlength={NAME_MAX}
            autocomplete="off"
            required
          />
        </label>
        <p class="text-sm">
          {t('oauth.CONFIRM', { appName: props.ctx.appName })}
        </p>
        <Field
          id="email"
          label={t('EMAIL')}
          type="email"
          autocomplete="username"
          value={form.email}
        />
        <Field
          id="password"
          label={t('PASSWORD')}
          type="password"
          autocomplete="current-password"
        />
        <SubmitButton label={t('oauth.ALLOW')} />
      </PostForm>
      {/* Its own form: Allow's fields are required, and Deny needs none. */}
      <PostForm action={AUTHORIZE_PATH} class="w-full max-w-xs">
        <ConsentField field={props.field} decision="deny" />
        <button type="submit" class="btn btn-ghost w-full">
          {t('oauth.DENY')}
        </button>
      </PostForm>
    </AccountShell>
  );
}

function ConsentField(props: { field: string; decision: 'allow' | 'deny' }) {
  return (
    <>
      <input type="hidden" name="consent" value={props.field} />
      <input type="hidden" name="decision" value={props.decision} />
    </>
  );
}

/**
 * A request the consent cannot take. Before the redirect URI is proven
 * there is nowhere safe to send the user, so no link; after, a link the
 * user taps back to the client carrying the error (never a redirect of our
 * own: the client's document is self-asserted, so its redirect URIs are
 * anyone's, decisions 2026-11-28).
 */
export function ConsentErrorPage(props: {
  ctx: ViewContext;
  message: string;
  returnTo?: string;
}) {
  return (
    <AccountShell ctx={props.ctx} title={t('oauth.ERROR_TITLE')}>
      <p class="w-full max-w-xs">{props.message}</p>
      {props.returnTo !== undefined && (
        <a href={props.returnTo} class="btn btn-outline" hx-boost="false">
          {t('oauth.RETURN_TO', { host: new URL(props.returnTo).hostname })}
        </a>
      )}
    </AccountShell>
  );
}
