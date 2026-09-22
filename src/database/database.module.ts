import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './all-schema';
import { sanitizeDatabaseUrl } from './database-url';

export const DRIZZLE = Symbol('DRIZZLE_CONNECTION');

// @Global() means we only export this once from AppModule and every
// other module can inject DRIZZLE without importing DatabaseModule
// themselves. Worth it for something as universally needed as the DB.
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // A real connection pool (unlike migrate.ts's max: 1) — the
        // running app serves many requests concurrently.
        const client = postgres(sanitizeDatabaseUrl(config.getOrThrow('DATABASE_URL')), {
          // Managed Postgres (Neon, Supabase, ...) SUSPENDS the compute after
          // a few minutes with no queries and closes every open connection to
          // do it. postgres.js keeps idle connections open forever by default,
          // so the next query after a quiet spell can fail against a socket
          // the server already dropped.
          //
          // Closing our own idle connections after 20s means we never hold a
          // socket long enough for the provider to yank it. The cost is one
          // fresh TCP+TLS handshake after each quiet period (~200-500ms), not
          // per request. Local Postgres is unaffected (it reconnects instantly).
          idle_timeout: 20,

          // Seatbelt for the entire `UNDEFINED_VALUE` class of failure.
          //
          // postgres.js refuses `undefined` as a parameter by default: it throws
          // from inside the driver, before the statement reaches Postgres, which
          // is why the error names no column, no query and no user. Setting
          // `transform.undefined` to `null` makes it send NULL instead of
          // throwing.
          //
          // That is the correct default for this app — every optional column in
          // the schema is nullable, so NULL is exactly what "the client did not
          // send this field" means. If a column is ever NOT NULL, Postgres now
          // raises a proper not-null violation naming that column, which is a far
          // more useful failure than a context-free driver throw.
          //
          // The honest trade-off: an `undefined` used in a WHERE clause now
          // compiles to `col = NULL`, which matches no rows (SQL three-valued
          // logic) instead of aborting the query. A lookup that would have thrown
          // a 500 now returns "not found" instead. That is the better of the two
          // failures for a user-facing app, and the explicit per-call-site fixes
          // above mean the meaningful paths pass real values either way.
          //
          // The per-call-site fixes stay in place (they make the intent explicit
          // at the place it matters). This makes the whole class of bug
          // impossible rather than merely absent from the paths we happened to
          // audit today.
          transform: { undefined: null },
        });
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
