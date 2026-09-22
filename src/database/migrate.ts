import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sanitizeDatabaseUrl } from './database-url';

async function main() {
  // max: 1 because migrations should run as a single sequential
  // connection, never pooled/parallel — running schema changes out of
  // order is how you corrupt a database.
  const migrationClient = postgres(sanitizeDatabaseUrl(process.env.DATABASE_URL), { max: 1 });
  const db = drizzle(migrationClient);

  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './src/database/migrations' });
  console.log('Migrations complete.');

  await migrationClient.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
