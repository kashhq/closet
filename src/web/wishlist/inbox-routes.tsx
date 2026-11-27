import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { OWNER_DISMISS_REASONS } from '../../wardrobe/suggestions';
import { sessionUserId } from '../auth/require-session';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import { GarmentParams, OwnerQuery, RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import {
  actorOf,
  type WardrobeRequest,
  wardrobeGuard,
} from '../sharing/access';
import { viewContext } from '../view-context';
import {
  garmentUrl,
  needUrl,
  WISHLIST_PATH,
  withParams,
} from '../wardrobe/urls';
import { NeedPage } from './group-page';
import { readInbox } from './inbox';
import {
  GroupCards,
  INBOX_MORE_PATH,
  INBOX_SEEN_PATH,
  InboxPage,
  NewFromAgent,
} from './inbox-page';
import {
  DECISION_FLAG,
  type DecisionToast,
  decisionToastOf,
} from './suggestion-parts';
import {
  makeDecision,
  markNeedsSeen,
  type OwnerDecision,
  requireNeed,
} from './suggestion-actions';

/** `?decided=`: a decision's toast (decisionToastOf). */
const DecidedFlag = Type.Optional(Type.String({ maxLength: 16 }));

const InboxQuery = Type.Object({
  ...OwnerQuery.properties,
  [DECISION_FLAG]: DecidedFlag,
});

/** The next page of need cards; the first is the page's own. */
const MoreQuery = Type.Object({
  ...OwnerQuery.properties,
  page: Type.Integer({ minimum: 2, maximum: 100 }),
});

const NeedParams = Type.Object({ id: RowId });

const NeedQuery = Type.Object({
  ...OwnerQuery.properties,
  // The option centred first (a thumb tapped in the inbox): URL state, so
  // an id that is none of the options centres the first.
  option: Type.Optional(Type.Union([Type.Literal(''), RowId])),
  [DECISION_FLAG]: DecidedFlag,
});

/** Where a decision comes back to: the page it was made on (checked by safeReturnTo). */
const RETURN_TO = Type.Optional(Type.String({ maxLength: 2048 }));
const NOTE_MAX = 500;

const DecisionBody = Type.Union([
  Type.Object({ returnTo: RETURN_TO }),
  Type.Null(),
]);

/** "Not for me": one of the owner's reasons (a 400 without one), and an optional note. */
const DismissBody = Type.Object({
  returnTo: RETURN_TO,
  reason: Type.Union(
    OWNER_DISMISS_REASONS.map((reason) => Type.Literal(reason)),
  ),
  note: Type.Optional(Type.String({ maxLength: NOTE_MAX })),
});

/** A typed note, trimmed; null when blank. */
function noteOf(note: string | undefined): string | null {
  return note?.trim() || null;
}

/**
 * The agent inbox (#333; docs/plans/2026-10-05-muse-suggestions.md, section
 * 4 C and D): the Wishlist tab as the inbox, its next page of needs, the
 * "New from the agent" marker, a need's decision screen, and every decision
 * made on them. The pages are read by whoever reads the wishlist (a VIEW
 * grantee sees the agent's notes: owner decision, 2026-10-05); unlocks, best
 * outfits, the marker and every decision are the owner's alone. Each
 * decision is one call of makeDecision() (suggestion-actions.ts, which
 * refuses itself: a 404 not theirs, a 409 a stale page or a double tap,
 * #188) and answers 303 to the page it was made on with a toast. "Bought it" stays
 * GET|POST /wardrobe/:id/bought (wishlist/routes.tsx), whose buyWishlistItem settles
 * the need; "Bought a different one" is the closet form with
 * `?forNeed=` (src/web/wardrobe/destination.ts).
 */
export const inboxRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  const authorize = wardrobeGuard(db, 'wardrobe');

  /** The addressed wardrobe's inbox: the page's, and its next pages' groups alone. */
  async function addressedInbox(request: WardrobeRequest, groupsOnly: boolean) {
    const { access, viewOwner } = await authorize(request, 'view');
    const inbox = await readInbox(db, {
      ownerId: access.ownerId,
      viewerId: sessionUserId(request),
      role: access.role,
      groupsOnly,
      switcher: !groupsOnly,
    });
    return { access, viewOwner, inbox };
  }

  app.get(
    WISHLIST_PATH,
    { schema: { querystring: InboxQuery } },
    async (request, reply) => {
      const { access, viewOwner, inbox } = await addressedInbox(request, false);
      logger.debug(
        `Inbox of wardrobe ${access.ownerId}: ${inbox.groups.length} needs with options, ${inbox.counted} options counted in ${inbox.searchMs.toFixed(0)}ms`,
      );
      return renderPage(
        reply,
        <InboxPage
          ctx={viewContext(reply)}
          model={{
            inbox,
            viewOwner,
            isOwner: access.isOwner,
            canEdit: access.canManage,
            toast: decisionToastOf(request.query[DECISION_FLAG]),
          }}
        />,
      );
    },
  );

  // The next page of need cards (the sentinel's `intersect once`): always
  // a fragment.
  app.get(
    INBOX_MORE_PATH,
    { schema: { querystring: MoreQuery } },
    async (request, reply) => {
      const { viewOwner, inbox } = await addressedInbox(request, true);
      return renderFragment(
        reply,
        <GroupCards
          groups={inbox.groups}
          page={request.query.page}
          viewOwner={viewOwner}
        />,
      );
    },
  );

  // "New from the agent", sent by the owner's inbox as it loads (hx-swap none):
  // the answer is the marker's slot, out of band. A write, so never cached
  // (doc section 9: the bare page stays the same before and after).
  app.post(INBOX_SEEN_PATH, async (request, reply) => {
    const needs = await markNeedsSeen({ db, logger }, actorOf(request));
    return renderFragment(reply, <NewFromAgent needs={needs} />);
  });

  app.get(
    `${WISHLIST_PATH}/needs/:id`,
    { schema: { params: NeedParams, querystring: NeedQuery } },
    async (request, reply) => {
      const { access, viewOwner, detail } = await requireNeed(
        db,
        actorOf(request),
        { id: request.params.id, ownerId: request.query.ownerId },
      );
      logger.debug(
        `Need ${detail.need.id} of wardrobe ${access.ownerId}: ${detail.options.length} options judged in ${detail.searchMs.toFixed(0)}ms`,
      );
      return renderPage(
        reply,
        <NeedPage
          ctx={viewContext(reply)}
          model={{
            detail,
            viewOwner,
            isOwner: access.isOwner,
            canEdit: access.canManage,
            option: request.query.option || undefined,
            toast: decisionToastOf(request.query[DECISION_FLAG]),
          }}
        />,
      );
    },
  );

  /** makeDecision() for the owner, then 303 to the page it was made on with its toast. */
  async function decided(
    request: WardrobeRequest,
    reply: FastifyReply,
    decision: OwnerDecision,
    {
      returnTo,
      fallback,
      toast,
    }: { returnTo: string | undefined; fallback: string; toast: DecisionToast },
  ): Promise<FastifyReply> {
    await makeDecision(
      { db, logger },
      actorOf(request),
      request.query.ownerId,
      decision,
    );
    return reply.redirect(
      withParams(safeReturnTo(returnTo, fallback), { [DECISION_FLAG]: toast }),
      303,
    );
  }

  const pickRoute = {
    schema: {
      params: GarmentParams,
      querystring: OwnerQuery,
      body: DecisionBody,
    },
  };

  // This one: the need resolved by the pick, its other options set aside.
  app.post('/wardrobe/:id/choose', pickRoute, (request, reply) =>
    decided(
      request,
      reply,
      { kind: 'choose', garmentId: request.params.id },
      {
        returnTo: request.body?.returnTo,
        fallback: garmentUrl(request.params.id, undefined),
        toast: 'choose',
      },
    ),
  );

  // Not for me on a pick, with the owner's reason and note.
  app.post(
    '/wardrobe/:id/dismiss',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: DismissBody,
      },
    },
    (request, reply) =>
      decided(
        request,
        reply,
        {
          kind: 'dismiss-pick',
          garmentId: request.params.id,
          reason: request.body.reason,
          note: noteOf(request.body.note),
        },
        {
          returnTo: request.body.returnTo,
          fallback: garmentUrl(request.params.id, undefined),
          toast: 'dismiss',
        },
      ),
  );

  // Undo on a pick set aside: back among its need's options.
  app.post('/wardrobe/:id/undo', pickRoute, (request, reply) =>
    decided(
      request,
      reply,
      { kind: 'undo-pick', garmentId: request.params.id },
      {
        returnTo: request.body?.returnTo,
        fallback: garmentUrl(request.params.id, undefined),
        toast: 'undo',
      },
    ),
  );

  // Not this need right now: the need set aside, its picks with it.
  app.post(
    `${WISHLIST_PATH}/needs/:id/dismiss`,
    {
      schema: {
        params: NeedParams,
        querystring: OwnerQuery,
        body: DismissBody,
      },
    },
    (request, reply) =>
      decided(
        request,
        reply,
        {
          kind: 'dismiss-group',
          groupId: request.params.id,
          reason: request.body.reason,
          note: noteOf(request.body.note),
        },
        {
          returnTo: request.body.returnTo,
          fallback: needUrl(request.params.id, undefined),
          toast: 'dismiss',
        },
      ),
  );

  // Undo on a need: one set aside, or a choice (its options back).
  app.post(
    `${WISHLIST_PATH}/needs/:id/undo`,
    {
      schema: {
        params: NeedParams,
        querystring: OwnerQuery,
        body: DecisionBody,
      },
    },
    (request, reply) =>
      decided(
        request,
        reply,
        { kind: 'undo-group', groupId: request.params.id },
        {
          returnTo: request.body?.returnTo,
          fallback: needUrl(request.params.id, undefined),
          toast: 'undo',
        },
      ),
  );

  // Returned it (the garment page's ⋯ menu, an htmx post like Archive): a
  // bought suggestion archived, set aside `returned`, its need open again.
  app.post(
    '/wardrobe/:id/returned',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { id } = request.params;
      await makeDecision(
        { db, logger },
        actorOf(request),
        request.query.ownerId,
        { kind: 'returned', garmentId: id },
      );
      return navigateTo(
        reply,
        garmentUrl(id, undefined, '', { [DECISION_FLAG]: 'returned' }),
      );
    },
  );

  // The wardrobe plans' addresses (#337): the inbox replaced plans, so an
  // old bookmark or notification lands there. 302, not 301: nothing should
  // cache these for good. Only GETs: an old form's post falls to the
  // not-found handler, or to a garment route's 400.
  for (const path of [
    '/wardrobe/plans',
    '/wardrobe/plans/*',
    '/wardrobe/shopping',
  ]) {
    app.get(path, async (_request, reply) =>
      reply.redirect(WISHLIST_PATH, 302),
    );
  }
  // A wishlist item's "For plan item…" page: back to the garment.
  app.get(
    '/wardrobe/:id/plan-items',
    { schema: { params: GarmentParams } },
    async (request, reply) =>
      reply.redirect(garmentUrl(request.params.id, undefined), 302),
  );

  done();
};
