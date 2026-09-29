import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sanitizeDatabaseUrl } from './database-url';

/**
 * Where the migration SQL lives.
 *
 * Two candidates, because the same script is reached two ways: `npm run
 * db:migrate` runs the TypeScript straight out of `src/`, while
 * `npm run db:migrate:prod` runs the compiled `dist/` build. Resolving instead
 * of hardcoding means neither path can silently find zero migrations and report
 * success — which is the failure mode that matters here, since a migration that
 * quietly does nothing looks exactly like a migration that worked.
 */
function resolveMigrationsFolder(): string {
  const candidates = ['./src/database/migrations', './dist/database/migrations'];
  const found = candidates.find((folder) => existsSync(folder));

  if (!found) {
    throw new Error(
      `No migrations folder found. Looked in: ${candidates.join(', ')}. ` +
        'Run this from the backend project root.',
    );
  }

  return found;
}

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/**
 * The tables the referral programme needs. Reported after migrating so "did it
 * work?" has a definite answer instead of an inference from a green log line.
 */
const REFERRAL_TABLES = [
  'referral_codes',
  'referrals',
  'referral_clicks',
  'ledger_entries',
  'milestones',
  'milestone_claims',
  'teams',
  'team_members',
  'treasure_codes',
  'payouts',
  'influencers',
  'leaderboard_snapshots',
];

async function reportSchema(
  sql: postgres.Sql,
): Promise<{ present: string[]; missing: string[] }> {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public'
  `;
  const presentSet = new Set(rows.map((r) => r.table_name));
  const present = REFERRAL_TABLES.filter((t) => presentSet.has(t));
  const missing = REFERRAL_TABLES.filter((t) => !presentSet.has(t));
  return { present, missing };
}

async function main() {
  // max: 1 because migrations should run as a single sequential connection,
  // never pooled/parallel — running schema changes out of order is how you
  // corrupt a database.
  const sql = postgres(sanitizeDatabaseUrl(process.env.DATABASE_URL), { max: 1 });
  const db = drizzle(sql);

  try {
    const folder = resolveMigrationsFolder();
    const journal = JSON.parse(
      readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] };

    console.log(`\nMigrations folder : ${folder}`);
    console.log(`Migration files   : ${journal.entries.length}`);

    /**
     * What the database says it has already applied.
     *
     * Drizzle records each applied migration in `drizzle.__drizzle_migrations`
     * and decides what to run by comparing the newest recorded timestamp against
     * each migration's `when`. That comparison is the whole scheduling
     * mechanism — so when a column exists in the database but the journal has no
     * row for the migration that adds it, Drizzle will try to add it again and
     * Postgres will refuse.
     *
     * Printing both sides makes that situation visible immediately rather than
     * as a raw Postgres error halfway through. This guard would have told us
     * that `terms_accepted_version` already existed before the migration ran.
     */
    let applied: { created_at: string }[] = [];
    try {
      applied = await sql<{ created_at: string }[]>`
        select created_at from "drizzle"."__drizzle_migrations" order by created_at
      `;
    } catch {
      // The migrations table does not exist yet: this is a brand-new database.
      // Not an error — it is the state the very first run is supposed to be in.
    }

    const newest =
      applied.length > 0 ? Number(applied[applied.length - 1].created_at) : 0;
    const pending = journal.entries.filter((entry) => entry.when > newest);

    console.log(
      `Already applied   : ${applied.length}${applied.length === 0 ? ' (fresh database)' : ''}`,
    );
    console.log(`Pending           : ${pending.length}`);

    if (pending.length === 0) {
      console.log('\nNothing to do — the database is already up to date.');
    } else {
      console.log(`\nApplying: ${pending.map((p) => p.tag).join('\n          ')}\n`);

      await migrate(db, { migrationsFolder: folder });

      console.log('\nMigrations complete.');
    }

    // Always report the schema, whether or not anything was applied — the
    // question being asked after a migration is "are the tables there?", and
    // this answers it directly.
    const { present, missing } = await reportSchema(sql);
    console.log(`\nReferral tables   : ${present.length}/${REFERRAL_TABLES.length}`);
    if (missing.length > 0) {
      console.log(`Missing           : ${missing.join(', ')}`);
      console.log(
        '\nThe referral endpoints will fail until these exist. ' +
          'Re-run this command and check the output above.',
      );
    } else {
      console.log('Schema is ready — the referral programme can serve requests.');
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err?.message ?? err);

  // The one failure mode worth spelling out, because the raw Postgres text
  // ("column ... already exists") says nothing about what to do about it.
  if (err?.code === '42701') {
    console.error(
      '\nThat error means the object already exists in the database but this migration\n' +
        'was never recorded as applied — usually because the column was added by hand\n' +
        'in the SQL console at some point.\n\n' +
        'The migrations in this folder are written to be safely re-runnable, so if you\n' +
        'are seeing this, this copy of the folder is out of date. Pull the latest\n' +
        'backend files and run it again. Nothing has been left half-applied: Drizzle\n' +
        'runs every pending migration inside a single transaction, so a failure rolls\n' +
        'the whole lot back.',
    );
  }

  process.exit(1);
});
