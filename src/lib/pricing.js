// Canonical public price display values only. Server checkout must independently validate prices.
export const MYOPS_PLANS = Object.freeze({
  starter: Object.freeze({ id: 'starter', amountSen: 990, currency: 'MYR' }),
  single: Object.freeze({ id: 'single', amountSen: 1990, currency: 'MYR' }),
  duo: Object.freeze({ id: 'duo', amountSen: 2990, currency: 'MYR' }),
  complete: Object.freeze({ id: 'complete', amountSen: 3990, currency: 'MYR' }),
});
export function formatMyr(amountSen) {
  if (!Number.isSafeInteger(amountSen) || amountSen < 0) throw new RangeError('Invalid amount');
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(amountSen / 100);
}
