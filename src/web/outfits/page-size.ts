/**
 * Outfits a page holds (#660): the Saved tab, the pickers (the calendar's
 * plan page, a trip's add page), list_outfits, and GET /api/v1/outfits
 * unless asked. Fixed, so bare /outfits renders the same bytes while
 * nothing changes (a stale-while-revalidate tab root). A module of its own,
 * like GRID_PAGE_SIZE, so the Playwright scenario reads it without the
 * queries.
 */
export const OUTFIT_PAGE_SIZE = 30;
