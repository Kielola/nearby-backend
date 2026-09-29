/**
 * Money helpers. One place, because the alternative is a `* 100` scattered
 * across nine files and eventually one of them is wrong.
 *
 * EVERYTHING IS KOBO. A naira is 100 kobo. The API stores, sums, compares and
 * pays out in kobo; it converts to naira at exactly two places — the UI, and the
 * narration shown to a human. Floating-point naira is how balances end up
 * reported as ₦4,999.999999.
 */

export const KOBO_PER_NAIRA = 100;

/** Minimum withdrawal, in kobo — ₦1,000, carried over from the original flow. */
export const MIN_PAYOUT_KOBO = 100_000;

/** Kobo → a naira string for display and notification text. */
export function formatNaira(kobo: number): string {
  const naira = kobo / KOBO_PER_NAIRA;
  return `₦${naira.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

/** Naira (as typed by a human) → kobo. Rounds to the nearest kobo. */
export function nairaToKobo(naira: number): number {
  return Math.round(naira * KOBO_PER_NAIRA);
}

/**
 * A stable idempotency key for an action, built from the parts that identify it.
 *
 * Deterministic rather than random on purpose: the same logical action must
 * produce the same key on a retry, or the unique index cannot do its job. A
 * random uuid would be unique every time and would protect nothing.
 */
export function idempotencyKey(...parts: (string | number)[]): string {
  return parts.map((p) => String(p)).join(':');
}
