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
        });
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
