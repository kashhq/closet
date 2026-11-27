/**
 * Money in cents. Prices arrive as the numeric column's strings ('49.90',
 * at most two decimals), so sums and comparisons in cents never pick up a
 * float's error. Used by insights' costs and an agent need's budget fit.
 */

/** '49.90' as 4990. */
export function toCents(price: string): number {
  return Math.round(Number(price) * 100);
}

/** 4990 as '49.90', the form priceLabel reads. */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
