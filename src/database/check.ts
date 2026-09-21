/**
 * DATABASE CONNECTION DOCTOR
 * ==========================
 *
 *   npm run db:check
 *
 * Checks DATABASE_URL end to end and tells you what is wrong in plain
 * language — before you deploy, not after. Written because the first
 * hour with a new managed database is usually spent guessing which of
 * five things is broken.
 *
 * Exits 0 if the database is ready for the app, 1 otherwise.
 */
import 'dotenv/config';
import net from 'net';
import tls from 'tls';
import postgres from 'postgres';
import {
  sanitizeDatabaseUrl,
  readDeclaredSslMode,
  describeSslDecision,
  isRemoteHost,
} from './database-url';

type Check = { ok: boolean; label: string; detail?: string };

const checks: Check[] = [];
const add = (ok: boolean, label: string, detail?: string) =>
  checks.push({ ok, label, detail });

/** Never print the password — logs and screenshots leak. */
function describe(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ':' + u.port : ''}/${u.pathname.slice(1) || '(default)'} as ${u.username}`;
  } catch {
    return '(unparseable URL)';
  }
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();

  if (m.includes('unrecognized configuration parameter')) {
    return (
      `${msg}\n` +
      `      → Something in DATABASE_URL is a client-side option the driver\n` +
      `        cannot send. This is what "channel_binding=require" from the\n` +
      `        Neon dashboard used to do; it is now stripped automatically,\n` +
      `        so if you still see this, check for OTHER unusual ?params=.`
    );
  }
  if (m.includes('password authentication failed') || m.includes('authentication failed')) {
    return `${msg}\n      → Wrong password. Reset the role's password in Neon and re-copy the string.`;
  }
  if (m.includes('does not exist') && m.includes('database')) {
    return `${msg}\n      → The database name at the end of the URL is wrong (Neon's default is "neondb").`;
  }
  if (m.includes('enotfound') || m.includes('getaddrinfo')) {
    return `${msg}\n      → The hostname is wrong or has a typo. Copy it straight from Neon,\n        don't retype it.`;
  }
  if (m.includes('etimedout') || m.includes('timeout') || m.includes('econnrefused')) {
    return (
      `${msg}\n` +
      `      → Nothing answered. If this is Neon: check the project isn't deleted\n` +
      `        and the host has "-pooler". If it's your own machine: is Postgres\n` +
      `        actually running?`
    );
  }
  if (m.includes('ssl') || m.includes('tls') || m.includes('self-signed')) {
    return (
      `${msg}\n` +
      `      → TLS problem. Two causes: the URL may need ?sslmode=require, or the\n` +
      `        server may not offer TLS at all. The Encryption line below says which.`
    );
  }
  return msg;
}

// ───────────────────────────────────────────────────────────────────────────
// TLS PROBE
//
// Why this exists: `pg_stat_ssl` reports the TLS state of the connection *as
// Postgres sees it*. Through a connection pooler — Neon's hosts contain
// "-pooler" — that is the pooler→Postgres leg on the provider's private
// network, NOT your client→pooler leg. Verified: a client connection that
// completed a real TLS handshake (AES-256-GCM) still reported
// `pg_stat_ssl.ssl = false`.
//
// So we measure from OUR side of the wire instead: open a socket to the same
// host and port, send the PostgreSQL SSLRequest, and see what the server says.
// That is exactly the first thing postgres.js does when it connects.
// ───────────────────────────────────────────────────────────────────────────

type TlsProbe = {
  supportsSsl: boolean | null;
  handshake: 'ok' | 'refused' | 'error' | 'timeout';
  cipher?: string;
  error?: string;
};

async function probeTls(host: string, port: number, timeoutMs = 10_000): Promise<TlsProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: TlsProbe) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(r);
    };

    let socket: net.Socket = net.connect({ host, port }) as net.Socket;

    socket.setTimeout(timeoutMs, () =>
      finish({ supportsSsl: null, handshake: 'timeout', error: `no response within ${timeoutMs / 1000}s` }),
    );
    socket.on('error', (e: Error) =>
      finish({ supportsSsl: null, handshake: 'error', error: e.message }),
    );

    socket.once('connect', () => {
      // PostgreSQL SSLRequest: int32 length (8), int32 code (80877103).
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);

      socket.once('data', (data: Buffer) => {
        const reply = String.fromCharCode(data[0]);

        if (reply !== 'S') {
          // 'N' means the server will not do TLS on this connection.
          return finish({
            supportsSsl: false,
            handshake: 'refused',
            error: 'server answered "N" to the SSL request',
          });
        }

        // The server offers TLS. Complete a real handshake on the same socket
        // so we report a verified fact rather than an inference.
        const secure = tls.connect({
          socket,
          // Same posture postgres.js uses for sslmode=require: the server's
          // certificate chain is not validated. We are testing whether TLS is
          // *available and used*, not who the certificate belongs to.
          rejectUnauthorized: false,
          servername: net.isIP(host) ? undefined : host,
        });
        secure.setTimeout(timeoutMs, () =>
          finish({ supportsSsl: true, handshake: 'timeout', error: 'handshake timed out' }),
        );
        secure.once('secureConnect', () => {
          let cipher: string | undefined;
          try {
            cipher = secure.getCipher()?.name;
          } catch {
            /* not fatal */
          }
          socket = secure as unknown as net.Socket;
          finish({ supportsSsl: true, handshake: 'ok', cipher });
        });
        secure.once('error', (e: Error) =>
          finish({ supportsSsl: true, handshake: 'error', error: e.message }),
        );
      });
    });
  });
}

/** Modes where the driver will insist on TLS and fail rather than downgrade. */
const TLS_ENFORCING_MODES = new Set(['require', 'prefer', 'allow', 'verify-ca', 'verify-full']);

async function main() {
  const raw = process.env.DATABASE_URL;

  if (!raw) {
    console.error('\n✗ DATABASE_URL is not set.\n');
    console.error('  Put it in a .env file in the backend folder:');
    console.error('    DATABASE_URL="postgresql://user:pw@host/db?sslmode=require"\n');
    process.exit(1);
  }

  console.log('\nDatabase check');
  console.log('  target :', describe(raw));

  // ── 1. Parse and clean the URL ─────────────────────────────────────────
  let url: string;
  try {
    const before = readDeclaredSslMode(raw);
    const decision = describeSslDecision(raw);
    url = sanitizeDatabaseUrl(raw);
    const after = readDeclaredSslMode(url);

    const declaredDesc = before.value === null ? 'not set' : `${before.key}=${before.value}`;
    add(true, 'SSL setting in URL', declaredDesc);

    const notes: string[] = [];
    if (raw.includes('channel_binding')) notes.push('channel_binding stripped (safe)');
    if (before.value !== after.value) {
      notes.push(`changed to ${after.key}=${after.value} to protect a remote connection`);
    } else if (decision.remote && after.value === 'disable') {
      notes.push('sslmode=disable honoured — this connection will NOT be encrypted');
    }
    add(true, 'Connection string parsed', notes.length ? notes.join('; ') : undefined);
  } catch (err) {
    add(false, 'Connection string parsed', friendlyError(err));
    report();
    return;
  }

  let hostname = '';
  let port = 5432;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    port = Number(parsed.port) || 5432;
  } catch {
    /* handled below by the connection attempt */
  }

  const pooled = /-pooler/i.test(hostname);
  const remote = hostname ? isRemoteHost(hostname) : true;
  const sslModeRaw = readDeclaredSslMode(url).value ?? '';
  const sslMode = sslModeRaw.trim().toLowerCase();

  // Probe TLS BEFORE connecting. If the connection then fails, we already know
  // whether TLS was the cause, instead of reporting a generic network error.
  const tlsBlocked = remote && sslMode !== 'disable';
  const probe = tlsBlocked ? await probeTls(hostname, port) : null;

  let sql;
  try {
    sql = postgres(url, { max: 1, connect_timeout: 15 });
  } catch (err) {
    add(false, 'Driver initialised', friendlyError(err));
    report();
    return;
  }

  // ── 2. Connect ─────────────────────────────────────────────────────────
  try {
    const [row] = await sql`
      select version() as version,
             current_database() as db,
             current_user as usr
    `;
    add(true, 'Connected', `${row.db} as ${row.usr}`);
    add(true, 'Server version', String(row.version).split(' ').slice(0, 2).join(' '));
  } catch (err) {
    add(false, 'Connected', friendlyError(err));
    if (probe && probe.supportsSsl === false) {
      add(
        false,
        'Cause',
        `this server does not offer TLS at all (it answered "N" to the SSL ` +
          `request),\n        but the URL asks for sslmode=${sslMode || 'require'}. That is why the\n` +
          `        connection failed. Either the server genuinely has no TLS, or you are\n` +
          `        pointing at the wrong port.`,
      );
    }
    report();
    await sql.end({ timeout: 1 });
    return;
  }

  // ── 3. Encryption — measured from OUR side, not the server's ───────────
  if (!remote) {
    add(true, 'Encryption', 'local/private database — TLS is not required here');
  } else if (sslMode === 'disable') {
    add(
      false,
      'Encryption',
      'TLS is switched OFF by ?sslmode=disable.\n' +
        "        Your database password and every query result — including your\n" +
        "        users' coordinates — cross the internet in cleartext.\n" +
        '        FIX: remove sslmode=disable from DATABASE_URL.',
    );
  } else if (probe && probe.handshake === 'ok') {
    add(
      true,
      'Encryption — TLS verified',
      `completed a real handshake with ${hostname}${probe.cipher ? ` (${probe.cipher})` : ''}`,
    );
  } else if (probe && probe.supportsSsl === false) {
    add(
      false,
      'Encryption',
      `the server refused TLS, so sslmode=${sslMode || 'require'} cannot be honoured.\n` +
        '        postgres.js will fail the connection rather than fall back to\n' +
        '        plaintext — but check the hostname and the provider status.',
    );
  } else if (probe) {
    add(
      false,
      'Encryption',
      `could not complete a TLS handshake (${probe.handshake}): ${probe.error}\n` +
        `        sslmode=${sslMode || 'require'} means the connection will FAIL rather\n` +
        '        than silently downgrade — but this needs investigating before\n' +
        '        you deploy.',
    );
  }

  // ── 3b. Cross-check with pg_stat_ssl, and explain the pooler caveat ────
  try {
    const [row] = await sql`
      select (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl
    `;
    if (row.ssl === false && pooled) {
      // Expected through a pooler: this reports the pooler→Postgres leg.
      add(
        true,
        'pg_stat_ssl cross-check',
        'reports unencrypted, which is EXPECTED through a "-pooler" host:\n' +
          '        it reflects the pooler→Postgres leg inside the provider\'s own\n' +
          '        network, not your connection. Your leg is measured above.',
      );
    } else if (row.ssl === false && !pooled && remote) {
      add(
        false,
        'pg_stat_ssl cross-check',
        'reports the connection as UNENCRYPTED, and this host is not pooled.\n' +
          '        Re-check the Encryption line above.',
      );
    } else if (row.ssl === false && !remote) {
      // Local Postgres usually has TLS off. That is fine and already reported.
      // Saying nothing here is deliberate: a local database is not a problem.
    } else if (row.ssl === true) {
      add(true, 'pg_stat_ssl cross-check', 'server confirms an encrypted connection');
    }
  } catch {
    /* non-fatal: some restricted roles cannot read pg_stat_ssl */
  }

  // ── 4. PostGIS: the #1 cause of "migration failed on line 1" ───────────
  let hasPostgis = false;
  try {
    const [row] = await sql`select postgis_lib_version() as v`;
    hasPostgis = true;
    add(true, 'PostGIS extension', `v${row.v}`);
  } catch {
    add(
      false,
      'PostGIS extension',
      'NOT ENABLED. Run this in your database, then migrate:\n' +
        '        CREATE EXTENSION IF NOT EXISTS postgis;',
    );
  }

  // ── 5. Did the migrations land? ────────────────────────────────────────
  try {
    const tables = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public' order by 1
    `;
    const names = tables.map((t) => t.tablename).filter((t) => t !== 'spatial_ref_sys');
    // The complete set a clean `npm run db:migrate` creates.
    const expected = [
      'conversation_participants',
      'conversations',
      'friend_requests',
      'highlights',
      'meetup_ratings',
      'meetups',
      'messages',
      'notifications',
      'posts',
      'reports',
      'users',
    ];
    const missing = expected.filter((e) => !names.includes(e));
    const extra = names.filter((n) => !expected.includes(n));

    if (missing.length === 0) {
      add(
        true,
        'Schema',
        `${names.length} tables, all expected ones present` +
          (extra.length
            ? `\n        — ${extra.length} table(s) the migrations did NOT create: ${extra.join(', ')}\n` +
              `          (playing_with_neon is Neon's own demo table from their\n` +
              `          onboarding snippet — safe to DROP. Others are usually a Neon\n` +
              `          feature you enabled, or leftovers from an earlier attempt.)`
            : ''),
      );
    } else if (names.length === 0) {
      add(false, 'Schema', 'EMPTY — migrations have not run yet. Run: npm run db:migrate');
    } else {
      add(false, 'Schema', `missing: ${missing.join(', ')} — re-run: npm run db:migrate`);
    }

    if (hasPostgis && names.includes('users')) {
      const [col] = await sql<{ udt_name: string }[]>`
        select udt_name from information_schema.columns
        where table_name = 'users' and column_name = 'location'
      `;
      add(
        col?.udt_name === 'geography',
        'Radar column',
        col ? `users.location : ${col.udt_name}` : 'users.location absent',
      );

      const idx = await sql`
        select indexname from pg_indexes
        where schemaname = 'public' and indexdef ilike '%gist%'
      `;
      add(
        idx.length > 0,
        'Radar index (GiST)',
        idx.length ? String(idx[0].indexname) : 'MISSING — radar will be slow',
      );
    }

    const [{ count: users }] = await sql<{ count: string }[]>`
      select count(*)::text as count from users
    `.catch(() => [{ count: '0' }]);
    if (users !== '0') console.log(`  users  : ${users} rows already in there`);
  } catch (err) {
    add(false, 'Schema', friendlyError(err));
  }

  await sql.end({ timeout: 1 });
  report();
}

function report() {
  console.log();
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ' — ' + c.detail : ''}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log();
  if (failed.length === 0) {
    console.log('  ALL GOOD — the backend can use this database.\n');
    process.exit(0);
  }
  console.log(`  ${failed.length} problem(s) above need fixing before deploying.\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\nUnexpected failure:', friendlyError(err), '\n');
  process.exit(1);
});