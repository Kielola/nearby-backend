import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './all-schema';

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
        const client = postgres(config.getOrThrow('DATABASE_URL'));
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
