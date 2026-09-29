import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../database/all-schema';

/** The root Drizzle client. */
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * The object handed to a `db.transaction(async (tx) => …)` callback.
 *
 * Derived from `Db` rather than written out, so it stays correct if the driver's
 * generic signature changes. `Parameters<...>[0]` walks: the transaction method's
 * parameter list, then the callback type's parameter list, then the first one —
 * which is the transaction handle itself.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Something that can run queries: either the client, or a transaction handle.
 *
 * ## Why this exists
 *
 * A service that always uses its injected client **cannot participate in a
 * caller's transaction**. `LedgerService.apply()` originally did exactly that:
 * it ran its insert on the pooled client, so calling it from inside
 * `db.transaction(async (tx) => …)` wrote the ledger row on a *different
 * connection*, outside the transaction. The credit would commit even if the
 * transaction around it rolled back — a paid reward with no claim, which is the
 * one failure mode a ledger exists to prevent.
 *
 * Accepting an optional `Executor` lets a service run its statement on the
 * caller's transaction when there is one, and on its own connection when there
 * is not.
 */
export type Executor = Db | Tx;
