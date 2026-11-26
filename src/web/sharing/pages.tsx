import { Card } from '../card';
import type { Child } from 'hono/jsx';
import type { SharePermission } from '../../db/schema';
import { AccountShell } from '../auth/account-shell';
import { Field, Fieldset, SubmitButton, UsernameTwin } from '../auth/form';
import { PostForm } from '../form';
import { loginUrl, registerUrl } from '../auth/return-to';
import { t, type StringKey } from '../i18n';
import { PageShell } from '../layout/page-shell';
import { BrandMark } from '../layout/brand-mark';
import { SettingsPage } from '../layout/settings-page';
import { CopyableText } from '../share/share-button';
// eslint-disable-next-line closet/no-foreign-page-import -- sharedBy is a share-page helper that is no markup; it moves to share/ with its next change (#718)
import { sharedBy } from '../share/share-page';
import type { ViewContext } from '../view-context';
import type {
  AcceptRefusal,
  InviteView,
  ShareParty,
  ShareView,
} from './queries';
import { wardrobeUrl } from '../wardrobe/urls';
import {
  CREATE_INVITE_PATH,
  EDIT_INVITE_PATH,
  invitePath,
  SHARING_PATH,
  SHARING_SECTION_ID,
} from './urls';

/** Views of sharing: Profile › Sharing's page, the invite landing, the new-link fragment. */

const REFUSAL_MESSAGES: Record<AcceptRefusal, StringKey> = {
  'not-found': 'SHARE_ERROR_NOT_FOUND',
  expired: 'SHARE_ERROR_EXPIRED',
  'own-invite': 'SHARE_ERROR_OWN_INVITE',
  'wrong-recipient': 'SHARE_ERROR_WRONG_RECIPIENT',
  'already-shared': 'SHARE_ERROR_ALREADY_SHARED',
};

/** A refusal code from a URL; anything else is none (navigation state, never a 400). */
export function parseRefusal(
  value: string | undefined,
): AcceptRefusal | undefined {
  return value !== undefined && Object.hasOwn(REFUSAL_MESSAGES, value)
    ? (value as AcceptRefusal)
    : undefined;
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin}${invitePath(token)}`;
}

function permissionLabel(permission: SharePermission): string {
  return t(permission === 'VIEW' ? 'PERMISSION_VIEW' : 'PERMISSION_MANAGE');
}

export function PermissionBadge(props: {
  permission: SharePermission;
  class?: string;
}) {
  const tone = props.permission === 'VIEW' ? 'badge-outline' : 'badge-primary';
  return (
    <span class={`badge badge-sm ${tone} ${props.class ?? ''}`.trim()}>
      {permissionLabel(props.permission)}
    </span>
  );
}

/** The answer to the create-invite form (htmx swaps it into #invite-link-result). */
export function InviteLinkResult(props: { url: string }) {
  return (
    <div id="invite-link-result" class="grid gap-3">
      <CopyableText
        value={props.url}
        size="sm"
        name={t('INVITE_LINK')}
        label={t('COPY_TEXT')}
      />
    </div>
  );
}

function PostButton(props: {
  action: string;
  label: string;
  class: string;
  formClass?: string;
}) {
  return (
    <PostForm action={props.action} class={props.formClass ?? 'inline'}>
      <button type="submit" class={props.class}>
        {props.label}
      </button>
    </PostForm>
  );
}

function partyName(party: ShareParty): string {
  return party.email ?? '';
}

/** A list on the Sharing page: outbound, pending or inbound shares. */
function ShareList(props: { title: string; children: Child }) {
  return (
    <div class="flex flex-col">
      <h2 class="font-semibold text-sm">{props.title}</h2>
      <ul class="divide-y divide-base-300">{props.children}</ul>
    </div>
  );
}

export interface SharingModel {
  outbound: ShareView[];
  inbound: ShareView[];
  pending: ShareView[];
  /** Origin the invite links are built on (the one this page was requested on). */
  origin: string;
  /** Why an invite could not be accepted, from the accept's redirect. */
  refusal?: AcceptRefusal;
}

/**
 * Profile › Sharing (the manage page until #82, a Profile section until
 * #728): invite links, the wardrobes this user shares and the ones shared
 * with them, and invites waiting for an answer. Every write posts to
 * /wardrobe-share/* and lands back here (SHARING_PATH), so it is a
 * `formPage`: Back from a landing returns to Profile, not the page before
 * the write.
 */
export function SharingPage(props: { ctx: ViewContext; model: SharingModel }) {
  const { model } = props;
  const { outbound, inbound, pending } = model;
  const empty = !outbound.length && !inbound.length && !pending.length;
  return (
    <SettingsPage
      ctx={props.ctx}
      title={t('WARDROBE_SHARING')}
      section={SHARING_SECTION_ID}
      formPage
    >
      {model.refusal && (
        <div role="alert" class="alert alert-error">
          <span>{t(REFUSAL_MESSAGES[model.refusal])}</span>
        </div>
      )}

      <p class="text-sm text-muted">{t('SHARE_WARDROBE_DESC')}</p>
      {/* A view link is one tap; an edit link asks for the password on its
          own page (#668). */}
      <div class="flex gap-2 items-center flex-wrap">
        <form
          hx-post={CREATE_INVITE_PATH}
          hx-target="#invite-link-result"
          hx-swap="outerHTML"
        >
          <input type="hidden" name="permission" value="VIEW" />
          <button type="submit" class="btn btn-primary btn-sm">
            {t('CREATE_VIEW_LINK')}
          </button>
        </form>
        <a href={EDIT_INVITE_PATH} class="btn btn-outline btn-sm">
          {t('CREATE_EDIT_LINK')}
        </a>
      </div>
      <div id="invite-link-result"></div>

      {outbound.length > 0 && (
        <ShareList title={t('YOUR_SHARED_WARDROBES')}>
          {outbound.map((share) => (
            <li class="py-3 flex items-center justify-between gap-2">
              <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium break-all">
                    {share.grantee
                      ? partyName(share.grantee)
                      : t('PENDING_INVITE')}
                  </span>
                  <PermissionBadge permission={share.permission} />
                  {!share.acceptedAt && <InviteState share={share} />}
                </div>
                {share.inviteToken && !share.expired && (
                  <CopyableText
                    value={inviteUrl(model.origin, share.inviteToken)}
                    size="xs"
                    name={t('INVITE_LINK')}
                    label={t('COPY_INVITE_LINK')}
                  />
                )}
              </div>
              <PostButton
                action={`/wardrobe-share/${share.id}/remove`}
                label={t('REVOKE')}
                class="btn btn-ghost btn-xs text-error"
              />
            </li>
          ))}
        </ShareList>
      )}

      {pending.length > 0 && (
        <ShareList title={t('PENDING_INVITES')}>
          {pending.map((share) => (
            <li class="py-3 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <span class="font-medium break-all">
                  {partyName(share.grantor)}
                </span>
                <PermissionBadge permission={share.permission} class="ml-2" />
                {share.expired && <InviteState share={share} class="ml-2" />}
              </div>
              {share.inviteToken && (
                <div class="flex gap-2">
                  {!share.expired && (
                    <PostButton
                      action={`/wardrobe-share/invite/${share.inviteToken}/accept`}
                      label={t('ACCEPT')}
                      class="btn btn-primary btn-xs"
                    />
                  )}
                  <PostButton
                    action={`/wardrobe-share/invite/${share.inviteToken}/decline`}
                    label={t('DECLINE')}
                    class="btn btn-ghost btn-xs text-error"
                  />
                </div>
              )}
            </li>
          ))}
        </ShareList>
      )}

      {inbound.length > 0 && (
        <ShareList title={t('SHARED_WITH_YOU')}>
          {inbound.map((share) => (
            <li class="py-3 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <a
                  href={wardrobeUrl(share.grantor.id)}
                  class="font-medium link link-primary break-all"
                >
                  {partyName(share.grantor)}
                </a>
                <PermissionBadge permission={share.permission} class="ml-2" />
              </div>
              <PostButton
                action={`/wardrobe-share/${share.id}/remove`}
                label={t('LEAVE')}
                class="btn btn-ghost btn-xs text-error"
              />
            </li>
          ))}
        </ShareList>
      )}

      {empty && <p class="text-sm text-muted">{t('NO_SHARES_YET')}</p>}
    </SettingsPage>
  );
}

/**
 * Profile's Sharing row: who has this wardrobe, whose this user has, and
 * the invites to answer and the links still open (told apart: one needs
 * this user, the other someone else), from the lists the page shows.
 */
export function sharingSummary(
  model: Pick<SharingModel, 'outbound' | 'inbound' | 'pending'>,
): string {
  const shared = model.outbound.filter((share) => share.acceptedAt).length;
  const links = model.outbound.filter(
    (share) => !share.acceptedAt && !share.expired,
  ).length;
  const toAnswer = model.pending.filter((share) => !share.expired).length;
  const parts = [
    shared > 0 && t('sharing.SUMMARY_SHARED', { count: shared }),
    model.inbound.length > 0 &&
      t('sharing.SUMMARY_INBOUND', { count: model.inbound.length }),
    toAnswer === 1 && t('sharing.SUMMARY_ANSWER_ONE'),
    toAnswer > 1 && t('sharing.SUMMARY_ANSWER_MANY', { count: toAnswer }),
    links === 1 && t('sharing.SUMMARY_LINKS_ONE'),
    links > 1 && t('sharing.SUMMARY_LINKS_MANY', { count: links }),
  ].filter((part) => part !== false);
  return parts.length > 0 ? parts.join(' · ') : t('sharing.SUMMARY_NONE');
}

/** An unanswered invite's badge: pending, or expired (listed, never offered). */
function InviteState(props: { share: ShareView; class?: string }) {
  const [tone, label] = props.share.expired
    ? ['badge-warning', t('INVITE_EXPIRED')]
    : ['badge-ghost', t('PENDING')];
  return (
    <span class={`badge badge-sm ${tone} ${props.class ?? ''}`.trim()}>
      {label}
    </span>
  );
}

/**
 * The edit link's step-up page (#668), a one-form page like changing the
 * password: what an edit link gives, and the current password. A refusal
 * answers it again with the field marked; success lands on Profile ›
 * Sharing, listing the new link.
 */
export function EditInvitePage(props: {
  ctx: ViewContext;
  passwordError?: string;
}) {
  return (
    <AccountShell
      ctx={props.ctx}
      title={t('CREATE_EDIT_LINK')}
      back={SHARING_PATH}
    >
      <p class="text-sm text-muted w-full max-w-xs">{t('EDIT_LINK_DESC')}</p>
      <PostForm action={CREATE_INVITE_PATH}>
        <Fieldset legend={t('CREATE_EDIT_LINK')}>
          <input type="hidden" name="permission" value="MANAGE" />
          <UsernameTwin email={props.ctx.user?.email} />
          <Field
            id="currentPassword"
            label={t('CURRENT_PASSWORD')}
            type="password"
            autocomplete="current-password"
            errors={props.passwordError ? [props.passwordError] : undefined}
          />
          <SubmitButton label={t('CREATE_EDIT_LINK')} />
        </Fieldset>
      </PostForm>
    </AccountShell>
  );
}

/**
 * The invite landing page, public: an anonymous recipient sees who invited
 * them and to what before being asked to sign in.
 */
export function InvitePage(props: {
  ctx: ViewContext;
  invite: InviteView | undefined;
  token: string;
}) {
  const { ctx, invite } = props;
  return (
    <PageShell
      ctx={ctx}
      name="invite"
      layout="centred"
      bar={{
        title: t('WARDROBE_INVITE'),
        returnTo: invite && invitePath(props.token),
      }}
    >
      {!ctx.user && <BrandMark ctx={ctx} />}
      <Card variant="content" class="w-full max-w-md" bodyClass="">
        {invite && !invite.expired ? (
          <InviteDetails invite={invite} token={props.token} ctx={ctx} />
        ) : (
          <>
            <div role="alert" class="alert alert-error mb-4">
              <span>
                {t(invite ? 'INVITE_EXPIRED_DESC' : 'INVITE_NOT_FOUND')}
              </span>
            </div>
            <a href="/" class="btn btn-primary btn-sm">
              {t('RETURN_TO_HOME')}
            </a>
          </>
        )}
      </Card>
    </PageShell>
  );
}

function InviteDetails(props: {
  ctx: ViewContext;
  invite: InviteView;
  token: string;
}) {
  const { invite, ctx } = props;
  // Public page (opened before signing in, fetched by link previews): the
  // inviter is named the way /share names an owner, never by email.
  const name = sharedBy(invite.grantor);
  const from = name ?? t('INVITE_FROM_UNKNOWN');
  const path = invitePath(props.token);
  return (
    <>
      <p class="text-muted mb-4">
        {t('INVITE_FROM')} <strong>{from}</strong>
      </p>
      <div class="mb-4 space-y-2">
        <PermissionBadge permission={invite.permission} />
        <p class="text-sm text-muted">
          {inviteeAccess(invite.permission, name)}
        </p>
      </div>
      {ctx.user ? (
        <div class="flex gap-2">
          <PostButton
            action={`${path}/accept`}
            label={t('ACCEPT')}
            class="btn btn-primary w-full"
            formClass="flex-1"
          />
          <PostButton
            action={`${path}/decline`}
            label={t('DECLINE')}
            class="btn btn-ghost w-full"
            formClass="flex-1"
          />
        </div>
      ) : (
        <div class="flex flex-col gap-2">
          <p class="text-sm text-muted mb-2">{t('INVITE_LOGIN_REQUIRED')}</p>
          {/* Signing in or registering comes back here (#661). */}
          <a href={loginUrl(path)} class="btn btn-primary">
            {t('LOGIN')}
          </a>
          {ctx.signupsOpen && (
            <a href={registerUrl(path)} class="btn btn-outline">
              {t('REGISTER')}
            </a>
          )}
        </div>
      )}
    </>
  );
}

/**
 * What accepting gives the person reading the invite, in their words and
 * naming the inviter: the first name only (sharedBy, a public page), else
 * "this wardrobe".
 */
function inviteeAccess(
  permission: SharePermission,
  name: string | undefined,
): string {
  const view = permission === 'VIEW';
  if (name === undefined) {
    return t(view ? 'INVITE_VIEW_DESC_UNNAMED' : 'INVITE_MANAGE_DESC_UNNAMED');
  }
  return t(view ? 'INVITE_VIEW_DESC' : 'INVITE_MANAGE_DESC', { name });
}
