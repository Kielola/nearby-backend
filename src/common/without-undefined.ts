/**
 * Return the same object with every `undefined`-valued key removed.
 *
 * postgres.js rejects `undefined` as a parameter outright — "UNDEFINED_VALUE:
 * Undefined values are not allowed" — and throws from inside the driver, before
 * the statement ever reaches Postgres. Optional fields arrive at a `.values()`
 * call as *present keys with undefined values*, because callers build payloads as
 * object literals listing every field and a spread of that literal carries the
 * holes along.
 *
 * Dropping the key is what lets Postgres apply NULL, which is the correct value
 * for "the client did not send this" on every optional column in this schema.
 *
 * Scoped to `T` rather than cast to the target table's insert type on purpose:
 * the caller keeps the compiler's full checking on the shape it passes, so
 * adding a column to the schema still fails to compile here if a payload does
 * not match. Casting to `$inferInsert` instead discards that check.
 *
 * One shared definition, imported by every service that assembles an optional
 * payload — the four copies of this bug (messages, posts, highlights,
 * notifications) were four copies of the same missing line.
 */
export function withoutUndefined<T extends Record<string, unknown>>(source: T): T {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as T;
}
