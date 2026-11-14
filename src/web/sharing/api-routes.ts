import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, type Static, Type } from '@sinclair/typebox';
import { SHARE_PERMISSIONS } from '../../db/schema';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { literals, withoutNulls } from '../api/resource';
import { actorOf, type SharedWardrobe, sharedWardrobesOf } from './access';

const SharedWardrobeResource = Type.Object(
  {
    ownerId: Type.Integer({
      description: 'The `ownerId` the share-aware routes take (GET /garments)',
    }),
    ownerFirstName: Type.Optional(
      Type.String({ description: 'Left out when they set none' }),
    ),
    permission: CloneType(literals(SHARE_PERMISSIONS), {
      description:
        'VIEW: read only; MANAGE: you may also change its garments and capsules',
    }),
  },
  { title: 'SharedWardrobe' },
);

const SharedWardrobeList = Type.Object(
  { data: Type.Array(SharedWardrobeResource) },
  {
    title: 'SharedWardrobeList',
    description:
      'Every wardrobe shared with you, in the order you accepted them',
  },
);

/**
 * The first name alone, never `grantorName`: that falls back to the email,
 * which no API answer carries (as list_shared_wardrobes, MCP).
 */
function toSharedWardrobe(
  shared: SharedWardrobe,
): Static<typeof SharedWardrobeResource> {
  return withoutNulls({
    ownerId: shared.grantorId,
    ownerFirstName: shared.grantorFirstName,
    permission: shared.permission,
  });
}

/**
 * The wardrobes shared with the token's user on /api/v1 (#195c): the
 * switcher's list (sharedWardrobesOf, as list_shared_wardrobes), accepted
 * shares only. Read on every call, so a share revoked or left is gone from
 * the next one. Sharing admin (invites, accepting, removing) stays the
 * web app's (operations.ts, SHARING_ADMIN): an invite is a credential.
 */
export const sharingApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db },
  done,
) => {
  app.get(
    '/shared-wardrobes',
    {
      schema: {
        operationId: 'listSharedWardrobes',
        tags: ['sharing'],
        summary: 'The wardrobes shared with you',
        description:
          "Each owner's id and first name and your permission there. Never paged: a household shares a few.",
        response: apiResponses({ 200: SharedWardrobeList }),
      },
    },
    async (request) => {
      const shared = await sharedWardrobesOf(db, actorOf(request));
      return { data: shared.map(toSharedWardrobe) };
    },
  );

  done();
};
