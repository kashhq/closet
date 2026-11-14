import { todayIn } from '../../calendar-date';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Layout } from '../layout/layout';
import { CopyableText } from '../share/share-button';
import type { ViewContext } from '../view-context';
import { Field, PostForm, UsernameTwin } from './form';
import { AGENT_ACCESS_SECTION_ID, profileSection } from './urls';
import {
  MAX_ACTIVE_TOKENS,
  TOKEN_NAME_MAX,
  type TokenListing,
  type TokenScope,
} from './personal-tokens';

/**
 * /auth/tokens, the profile's "Agent access" (#33): personal access tokens
 * for the MCP endpoint. A new token is shown once, in the answer to the
 * create form (a native post, never cached), with the command that connects
 * Claude Code; the list shows each token's name, prefix and scope (#701:
 * chosen in the form, read-only unless ticked, never changed after). The
 * redesign moves this into a Profile section (docs/plans/2026-09-26-redesign.md).
 */

type TokenNotice = 'revoked' | 'revoke-gone' | 'name-required' | 'too-many';

const ERROR_NOTICE = {
  'name-required': 'agentAccess.NAME_REQUIRED',
  'too-many': 'agentAccess.TOO_MANY',
} as const;

export interface TokensPageProps {
  ctx: ViewContext;
  tokens: TokenListing[];
  /** APP_TIMEZONE: dates are the household's. */
  timeZone: string;
  /** The token just created: its only showing. */
  created?: { name: string; token: string };
  notice?: TokenNotice;
  /** A refused create: the name and scope as chosen and the password's message (never the password). */
  form?: { name: string; scope: TokenScope; passwordError?: string };
}

/** The MCP endpoint on the canonical name (SITE_URL), for the connect command. */
function mcpUrl(siteUrl: string): string {
  return new URL('/mcp', siteUrl).toString();
}

function connectCommand(siteUrl: string, token: string): string {
  return `claude mcp add --transport http closet ${mcpUrl(siteUrl)} --header "Authorization: Bearer ${token}"`;
}

/** What a token may do, as the list says it: its scope's words, joined. */
function scopeText(scope: TokenScope): string {
  const words = [
    t(scope.readOnly ? 'agentAccess.READ_ONLY' : 'agentAccess.READ_WRITE'),
  ];
  if (scope.ownWardrobeOnly) words.push(t('agentAccess.OWN_WARDROBE_ONLY'));
  return words.join(' · ');
}

/** One scope checkbox, a toggle as the garment form's booleans are. */
function ScopeToggle({
  name,
  label,
  hint,
  checked,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
}) {
  return (
    <label class="label cursor-pointer justify-start items-start gap-3 whitespace-normal">
      <input
        type="checkbox"
        name={name}
        value="on"
        class="toggle toggle-sm mt-0.5"
        checked={checked}
      />
      <span class="flex flex-col gap-0.5">
        <span class="label-text">{label}</span>
        <span class="text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}

/**
 * The create form's scope (#701): both off unless a refused create brings
 * back what was chosen, so a token is read-only with every wardrobe unless
 * asked.
 */
function ScopeFields({ scope }: { scope?: TokenScope }) {
  return (
    <fieldset class="flex flex-col gap-2 py-1" data-token-scope>
      <legend class="text-sm mb-1">{t('agentAccess.SCOPE')}</legend>
      <ScopeToggle
        name="writes"
        label={t('agentAccess.WRITES')}
        hint={t('agentAccess.WRITES_HINT')}
        checked={scope?.readOnly === false}
      />
      <ScopeToggle
        name="ownWardrobeOnly"
        label={t('agentAccess.OWN_ONLY')}
        hint={t('agentAccess.OWN_ONLY_HINT')}
        checked={scope?.ownWardrobeOnly === true}
      />
    </fieldset>
  );
}

function TokenAlert({ notice }: { notice: TokenNotice }) {
  if (notice === 'revoked' || notice === 'revoke-gone') {
    return (
      <div role="status" class="alert alert-success mb-4">
        <span>
          {t(
            notice === 'revoked'
              ? 'agentAccess.REVOKED'
              : 'agentAccess.ALREADY_REVOKED',
          )}
        </span>
      </div>
    );
  }
  return (
    <div role="alert" class="alert alert-error mb-4">
      <span>{t(ERROR_NOTICE[notice], { max: MAX_ACTIVE_TOKENS })}</span>
    </div>
  );
}

export function TokensPage(props: TokensPageProps) {
  const { ctx, tokens, created, timeZone } = props;
  const day = (instant: Date) => todayIn(timeZone, instant);
  return (
    <Layout ctx={ctx} title={t('agentAccess.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('agentAccess.TITLE')}
        back={profileSection(AGENT_ACCESS_SECTION_ID)}
        formPage
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-2xl mx-auto">
        <p class="text-sm text-base-content/70 mb-6">
          {t('agentAccess.INTRO')}
        </p>

        {props.notice && <TokenAlert notice={props.notice} />}

        {created && (
          <div class="card bg-base-100 shadow-sm mb-6" id="new-token">
            <div class="card-body gap-3">
              <h2 class="card-title text-lg">{created.name}</h2>
              <p class="text-sm text-warning">{t('agentAccess.SHOWN_ONCE')}</p>
              <CopyableText
                value={created.token}
                size="sm"
                label={t('agentAccess.COPY')}
              />
              <p class="text-sm">{t('agentAccess.CONNECT')}</p>
              <CopyableText
                value={connectCommand(ctx.siteUrl, created.token)}
                size="xs"
                label={t('agentAccess.COPY')}
              />
            </div>
          </div>
        )}

        <div class="card bg-base-100 shadow-sm mb-6">
          <div class="card-body">
            <h2 class="card-title text-lg">{t('agentAccess.NEW')}</h2>
            <p class="text-sm text-base-content/70">
              {t('agentAccess.PASSWORD_WHY')}
            </p>
            <PostForm action="/auth/tokens" class="flex flex-col gap-2">
              <UsernameTwin email={ctx.user?.email} />
              <label class="flex flex-col gap-1">
                <span class="text-sm">{t('agentAccess.NAME')}</span>
                <input
                  type="text"
                  name="name"
                  class="input input-bordered input-sm w-full"
                  placeholder={t('agentAccess.NAME_PLACEHOLDER')}
                  value={props.form?.name}
                  maxlength={TOKEN_NAME_MAX}
                  autocomplete="off"
                  required
                />
              </label>
              <ScopeFields scope={props.form?.scope} />
              <Field
                id="currentPassword"
                label={t('CURRENT_PASSWORD')}
                type="password"
                autocomplete="current-password"
                errors={
                  props.form?.passwordError
                    ? [props.form.passwordError]
                    : undefined
                }
              />
              <button type="submit" class="btn btn-primary btn-sm self-start">
                {t('agentAccess.CREATE')}
              </button>
            </PostForm>
          </div>
        </div>

        <div class="card bg-base-100 shadow-sm">
          <div class="card-body">
            <h2 class="card-title text-lg">{t('agentAccess.YOUR_TOKENS')}</h2>
            {tokens.length === 0 ? (
              <p class="text-sm text-muted">{t('agentAccess.NONE')}</p>
            ) : (
              <ul class="divide-y divide-base-200">
                {tokens.map((token) => (
                  <li class="py-3 flex items-center justify-between gap-2">
                    <div class="flex flex-col gap-1 min-w-0">
                      <span class="font-medium truncate">{token.name}</span>
                      <span class="text-xs" data-scope>
                        {scopeText(token)}
                      </span>
                      <span class="text-xs text-muted">
                        <code>{token.prefix}…</code>{' '}
                        {t('agentAccess.CREATED_ON', {
                          day: day(token.createdAt),
                        })}
                        {' · '}
                        {token.lastUsedAt
                          ? t('agentAccess.LAST_USED', {
                              day: day(token.lastUsedAt),
                            })
                          : t('agentAccess.NEVER_USED')}
                      </span>
                    </div>
                    <PostForm
                      action={`/auth/tokens/${token.id}/revoke`}
                      confirm={t('agentAccess.REVOKE_CONFIRM', {
                        name: token.name,
                      })}
                    >
                      <button
                        type="submit"
                        class="btn btn-ghost btn-xs text-error"
                      >
                        {t('agentAccess.REVOKE')}
                      </button>
                    </PostForm>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </Layout>
  );
}
