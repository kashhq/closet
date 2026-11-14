import * as z from 'zod';
import { HttpError } from '../../errors';
import { sharedWardrobesOf } from '../../sharing/access';
import {
  CLOSET_FILTERS,
  type GarmentSummary,
  garmentSummaries,
} from '../../wardrobe/queries';
import { type ComparedGarment, compareWardrobes } from '../compare';
import { actorOf, defineTool, type ToolContext, wardrobeFor } from '../tool';
import { rowId } from './common';

/**
 * Past this many garments on a side the comparison says it is partial: a
 * household closet is a few hundred at most, and the answer goes into a
 * model's context.
 */
const MAX_COMPARED = 1000;

async function closet(
  ctx: ToolContext,
  ownerId: number,
): Promise<{ garments: ComparedGarment[]; complete: boolean }> {
  const page = await garmentSummaries(ctx.db, ownerId, CLOSET_FILTERS, {
    limit: MAX_COMPARED,
  });
  return {
    garments: page.garments.map((garment: GarmentSummary) => ({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      type: garment.type,
      brand: garment.brand,
      colors: garment.colors ?? [],
      price: garment.price,
      sourceUrl: garment.sourceUrl,
    })),
    complete: page.before === undefined,
  };
}

export const sharingTools = [
  defineTool({
    name: 'list_shared_wardrobes',
    title: 'Wardrobes shared with me',
    description:
      "The wardrobes other people share with you: each owner's id (the ownerId other tools take), their first name, and your permission: VIEW (read only) or MANAGE (you may also change its garments and capsules).",
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const shared = await sharedWardrobesOf(ctx.db, actorOf(ctx));
      return {
        wardrobes: shared.map((wardrobe) => ({
          ownerId: wardrobe.grantorId,
          name: wardrobe.grantorFirstName,
          permission: wardrobe.permission,
        })),
      };
    },
  }),

  defineTool({
    name: 'compare_with_shared_wardrobe',
    title: 'Compare my closet with a shared wardrobe',
    description:
      "Compares your closet (garments in it: not archived, not the wishlist) with a wardrobe shared with you, by role (top, bottom, layer, footwear...) and type (t-shirt, jeans, overshirt...). Answers the counts per role, the gaps (kinds the shared wardrobe has and you have none of, with its garments' brands, colours, prices and product links), the overlap and what only you have. Use it to talk through what to buy next.",
    input: z.object({
      ownerId: rowId().describe(
        "The shared wardrobe's owner id, from list_shared_wardrobes.",
      ),
    }),
    writes: false,
    async run({ ownerId }, ctx) {
      if (ownerId === ctx.userId) {
        throw new HttpError(400, 'Compare with a wardrobe shared with you');
      }
      const shared = await wardrobeFor(ctx, ownerId, 'view');
      const [mine, theirs] = await Promise.all([
        closet(ctx, ctx.userId),
        closet(ctx, shared.ownerId),
      ]);
      return {
        ...compareWardrobes(mine.garments, theirs.garments),
        complete: mine.complete && theirs.complete,
      };
    },
  }),
];
