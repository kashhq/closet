import type * as z from 'zod';
import type { ClosetTool } from '../tool';
import { calendarTools } from './calendar';
import { capsuleTools } from './capsules';
import { coverageTools } from './coverage';
import { galleryTools } from './gallery';
import { garmentTools } from './garments';
import { insightTools } from './insights';
import { inspirationTools } from './inspiration';
import { outfitTools } from './outfits';
import { sharingTools } from './sharing';
import { sizeTools } from './sizes';
import { styleTools } from './style';
import { suggestionTools } from './suggestions';
import { todayTools } from './today';
import { tripTools } from './trips';
import { weatherTools } from './weather';
import { weekPlanTools } from './week-plan';

/**
 * Every MCP tool (#33), in the order clients list them: the weather's
 * (#14) only with WEATHER_ENABLED. The weekly auto-plan (#16) is
 * tools/week-plan.ts's plan_week, its template in tools/style.ts's
 * get_style_profile. Trips (#10) are tools/trips.ts: list_trips, get_trip
 * (the packing list, and the destination's forecast with WEATHER_ENABLED)
 * and plan_trip_outfit. The agent's (#337) are tools/suggestions.ts (needs,
 * options, outfits, the inbox and the owner's feedback) and
 * tools/coverage.ts (get_closet_coverage). The outfit gallery (#9)
 * is tools/gallery.ts, with "Goes with my closet" for a wishlist item
 * (#18b, goes_with_closet), insights (#17) tools/insights.ts's
 * wardrobe_stats, Today (#15) tools/today.ts. A garment's photo for
 * tagging (#90) is tools/garments.ts's get_garment_photo, its queue
 * search_garments' needsTagging. Sizes (#24) are tools/sizes.ts's
 * get_sizes, read only. Saved looks (#22d) are tools/inspiration.ts's.
 */
export function mcpTools(options: {
  weather: boolean;
}): readonly ClosetTool<z.ZodObject>[] {
  return [
    ...garmentTools,
    ...capsuleTools,
    ...outfitTools,
    ...galleryTools,
    ...inspirationTools,
    ...todayTools,
    ...calendarTools,
    ...weekPlanTools,
    ...tripTools,
    ...insightTools,
    ...(options.weather ? weatherTools : []),
    ...sharingTools,
    ...styleTools,
    ...sizeTools,
    ...coverageTools,
    ...suggestionTools,
  ];
}
