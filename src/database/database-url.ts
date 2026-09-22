/**
 * Connection strings from managed providers need a small amount of cleaning
 * before postgres.js can use them.
 *
 * ---------------------------------------------------------------------------
 * PROBLEM 1 — "unrecognized configuration parameter"
 * ---------------------------------------------------------------------------
 * Neon's console copy button hands you a string like:
 *
 *   postgresql://user:pw@ep-x-pooler.eu-central-1.aws.neon.tech/neondb
 *     ?sslmode=require&channel_binding=require
 *
 * `channel_binding` is a **libpq client-side option**, not a Postgres server
 * setting. libpq understands it; postgres.js does not. Worse, postgres.js
 * forwards every unrecognised query parameter it finds as a *startup
 * parameter* in the connection handshake, and the server rejects the entire
 * connection:
 *
 *   FATAL: unrecognized configuration parameter "channel_binding"
 *
 * That failure happens before a single query runs, so it shows up as the
 * migration hanging or the app refusing to boot, with no mention of Neon.
 * Fix: strip parameters that are known to be client-only.
 *
 * ---------------------------------------------------------------------------
 * PROBLEM 2 — silently unencrypted connections (the dangerous one)
 * ---------------------------------------------------------------------------
 * postgres.js resolves the TLS setting like this (node_modules/postgres/src/
 * index.js):
 *
 *   query[k] === 'disable' || query[k] === 'false' ? false : query[k]
 *
 * so **`sslmode=false` means "no TLS"**, exactly like `sslmode=disable`. Any
 * other unrecognised value (`'0'`, `'off'`, `'no'`, `''`) is a truthy string,
 * which makes the driver *attempt* TLS — but with certificate verification
 * left at its default, which is a different failure mode rather than a safe
 * one.
 *
 * We verified against a live Postgres that a URL missing `sslmode` entirely
 * — or carrying `sslmode=false` — connects **successfully and unencrypted**,
 * and Neon's pooler accepts it. The app works perfectly, nothing is logged,
 * and the database password plus every row (including users' exact
 * coordinates) crosses the public internet in cleartext.
 *
 * Because that is a silent downgrade triggered by one word in a query string,
 * we normalise the TLS setting for any host that is not obviously local:
 *
 *   - no setting at all            -> `require`  (and say so)
 *   - `false` / `0` / `no` / `off` -> `require`  (and say so — almost always a
 *                                      mistake rather than a decision)
 *   - `disable`                    -> honoured, but warned about on every
 *                                      boot; this is the one deliberate
 *                                      escape hatch
 *   - unrecognised value           -> `require`  (and say so)
 *   - a real libpq mode            -> left exactly as given
 */
const CLIENT_ONLY_PARAMS = ['channel_binding'];

/**
 * Values postgres.js resolves to "do not use TLS".
 *
 * `disable` and `false` are handled by the driver itself; the rest are here
 * because they clearly read as "off" to a human and we should not let one of
 * them become a silent plaintext connection just because the driver happens
 * to treat the string as truthy.
 */
const INSECURE_SSL_VALUES = new Set(['disable', 'false', '0', 'no', 'off', '']);

/**
 * Boolean-looking aliases people write for "turn TLS on". These are not real
 * libpq modes. postgres.js leaves certificate verification at its default for
 * them, which is stricter than `require` and can fail against a database with
 * a self-signed certificate for reasons that look nothing like a config typo.
 * Normalising them to `require` gives the behaviour the person intended.
 */
const BOOLEAN_SSL_ALIASES = new Set(['true', '1', 'yes', 'on']);

/** Every TLS setting we recognise and are happy to pass through untouched. */
const RECOGNISED_SSL_VALUES = new Set([
  ...INSECURE_SSL_VALUES,
  ...BOOLEAN_SSL_ALIASES,
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
]);

// ───────────────────────────────────────────────────────────────────────────
// PROBLEM 3 — "TypeError: Invalid URL" on boot
// ───────────────────────────────────────────────────────────────────────────
// A hosting dashboard is not an .env file. In a .env file you write
//
//   DATABASE_URL="postgresql://user:pw@host/db"
//
// and dotenv strips the quotes for you. Paste that same line — quotes and all
// — into a dashboard's value field and the quotes become part of the value.
// `new URL('"postgresql://..."')` throws, postgres.js reports a bare
// "TypeError: Invalid URL" with no mention of which variable is at fault, and
// the service crash-loops.
//
// Verified: quotes, a leading "DATABASE_URL=", a missing scheme, and leftover
// placeholder text all produce exactly that error.
//
// So we normalise the value first: trim it, and unwrap matching quotes — but
// only when the unwrapped string actually parses, so a legitimate value is
// never damaged. If it still will not parse, we throw an error that names the
// problem instead of letting the driver fail cryptically.
// ───────────────────────────────────────────────────────────────────────────

function canParse(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Trim, and unwrap a pair of surrounding quotes when doing so yields a URL. */
export function normaliseDatabaseUrl(raw: string): { value: string; quoteStripped: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const paired = (first === '"' && last === '"') || (first === "'" && last === "'");
    if (paired) {
      const inner = trimmed.slice(1, -1).trim();
      if (canParse(inner)) {
        return { value: inner, quoteStripped: true };
      }
    }
  }
  return { value: trimmed, quoteStripped: false };
}

/**
 * Explain what is wrong with a connection string without ever printing the
 * password. Only the scheme and structural facts are reported.
 */
export function diagnoseDatabaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) {
    return 'DATABASE_URL is not set at all.';
  }

  if (raw.trim() === '') {
    return (
      'DATABASE_URL is set but EMPTY.\n\n' +
      '  Paste your full connection string as the value, or delete the\n' +
      '  variable. An empty value crashes the service on boot.'
    );
  }

  const { value } = normaliseDatabaseUrl(raw);
  if (canParse(value)) return null; // nothing wrong

  const trimmed = raw.trim();
  const startsQuote = /^["']/.test(trimmed);
  const endsQuote = /["']$/.test(trimmed);
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed);
  const scheme = schemeMatch ? schemeMatch[1] : null;
  const hasKeyPrefix = /^[A-Z_]+=/.test(trimmed);

  const observations: string[] = [];
  if (startsQuote && endsQuote) {
    observations.push('it is wrapped in quote characters');
  }
  if (hasKeyPrefix) {
    observations.push('it includes a leading "NAME=" prefix');
  }
  if (!scheme) {
    observations.push('it does not start with a URL scheme (postgresql:// or postgres://)');
  } else if (!/^(postgres|postgresql)$/i.test(scheme)) {
    observations.push(`its scheme is "${scheme}:", not postgres:// or postgresql://`);
  }
  if (observations.length === 0) {
    observations.push('it is not a complete connection URL');
  }

  return [
    'DATABASE_URL is not a valid PostgreSQL connection URL.',
    '',
    `  ${observations.join(';\n  ')}.`,
    `  ${trimmed.length} characters long.`,
    '',
    'Expected shape:',
    '  postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require',
    '',
    'Most common cause: the value was pasted WITH surrounding quotes. In a',
    '.env file quotes are stripped for you; in a hosting dashboard they are',
    'part of the value. Re-paste it without the quotes.',
  ].join('\n');
}


/**
 * Is this host reachable only from this machine / this private network?
 * Everything else is treated as "on the internet" and must use TLS.
 */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv6 literal — real hostnames never contain a colon.
  if (h.includes(':')) {
    return h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd');
  }

  if (h === 'localhost' || h === '' || h.endsWith('.localhost')) return true;
  // mDNS and private-network names. `.internal` covers hosts like Render's
  // internal service DNS, which is not publicly routable and may not offer TLS.
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true; // loopback + private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  // A bare hostname with no dots ("db", "postgres") is a docker-compose name.
  if (!h.includes('.')) return true;

  return false;
}

/** What TLS setting does this URL declare, if any? */
export function readDeclaredSslMode(raw: string | undefined) {
  if (!raw) return { key: null as string | null, value: null as string | null };
  let url: URL;
  try {
    url = new URL(normaliseDatabaseUrl(raw).value);
  } catch {
    return { key: null, value: null };
  }
  for (const key of ['sslmode', 'ssl']) {
    if (url.searchParams.has(key)) {
      return { key, value: url.searchParams.get(key) };
    }
  }
  return { key: null, value: null };
}

export function sanitizeDatabaseUrl(raw: string | undefined): string {
  if (!raw) {
    throw new Error('DATABASE_URL is not set');
  }

  const { value: normalised, quoteStripped } = normaliseDatabaseUrl(raw);

  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    // Throw a diagnosis that names the problem. Returning the raw value here
    // would let postgres.js produce a bare "TypeError: Invalid URL" that never
    // mentions DATABASE_URL — the hardest possible failure to debug from a
    // hosting dashboard.
    throw new Error(diagnoseDatabaseUrl(raw) ?? 'DATABASE_URL is not a valid URL');
  }

  if (quoteStripped) {
    console.warn(
      '[database] DATABASE_URL was wrapped in quote characters — removing them. ' +
        'In a .env file your tooling strips quotes for you; in a hosting ' +
        'dashboard they become part of the value. The connection string still ' +
        'works — this is safe.',
    );
  }

  // ── 1. Drop client-only parameters ────────────────────────────────────
  const stripped: string[] = [];
  for (const param of CLIENT_ONLY_PARAMS) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      stripped.push(param);
    }
  }

  // ── 2. Normalise the TLS setting for anything not obviously local ─────
  const { value: declaredRaw } = readDeclaredSslMode(raw);
  const declared = declaredRaw === null ? null : declaredRaw.trim().toLowerCase();
  const remote = !isLocalHost(url.hostname);

  let effective: string | null = declared;
  let enforcedReason: 'missing' | 'insecure' | 'unknown' | 'alias' | null = null;
  let insecure = false;

  if (remote) {
    if (declared === null) {
      enforcedReason = 'missing';
    } else if (INSECURE_SSL_VALUES.has(declared) && declared !== 'disable') {
      enforcedReason = 'insecure';
    } else if (BOOLEAN_SSL_ALIASES.has(declared)) {
      enforcedReason = 'alias';
    } else if (!RECOGNISED_SSL_VALUES.has(declared)) {
      enforcedReason = 'unknown';
    } else if (declared === 'disable') {
      insecure = true;
    }

    if (enforcedReason) {
      effective = 'require';
      // Rewrite to a single canonical `sslmode` so `ssl=false` can't survive
      // alongside it, and so nothing else can re-introduce the old value.
      url.searchParams.delete('ssl');
      url.searchParams.set('sslmode', 'require');
    }
  }

  const changed = stripped.length > 0 || enforcedReason !== null || quoteStripped;

  // ── 3. Report ─────────────────────────────────────────────────────────
  if (stripped.length > 0) {
    console.warn(
      `[database] Removed client-only parameter(s) ${stripped
        .map((p) => `"${p}"`)
        .join(', ')} from DATABASE_URL. ` +
        `These are understood by libpq but not by postgres.js, which would ` +
        `otherwise fail with: unrecognized configuration parameter. ` +
        `The connection string still works — this is safe.`,
    );
  }

  if (enforcedReason === 'insecure') {
    console.warn(
      `[database] DATABASE_URL sets sslmode=${declaredRaw}, which DISABLES ` +
        `encryption — replacing it with sslmode=require for the remote host ` +
        `"${url.hostname}". postgres.js treats the value "false" exactly like ` +
        `"disable", so this connection would have been plaintext: your ` +
        `database password and every query result would cross the internet ` +
        `unencrypted, with no error to warn you. If you genuinely need an ` +
        `unencrypted connection, use ?sslmode=disable to opt out on purpose.`,
    );
  } else if (enforcedReason === 'alias') {
    console.warn(
      `[database] DATABASE_URL sets sslmode=${declaredRaw}, which is not a ` +
        `real TLS mode — using sslmode=require instead for the remote host ` +
        `"${url.hostname}". Same effect, but without the implicit certificate ` +
        `verification that value would have switched on.`,
    );
  } else if (enforcedReason === 'unknown') {
    console.warn(
      `[database] DATABASE_URL sets sslmode=${declaredRaw}, which is not a ` +
        `TLS setting postgres.js understands — using sslmode=require instead ` +
        `for the remote host "${url.hostname}".`,
    );
  } else if (enforcedReason === 'missing') {
    console.warn(
      `[database] DATABASE_URL had no SSL setting for the remote host ` +
        `"${url.hostname}" — adding sslmode=require automatically. Without it ` +
        `the connection would be plaintext: your database password and every ` +
        `result would cross the internet unencrypted, with no error to warn ` +
        `you.`,
    );
  }

  if (insecure) {
    console.warn(
      `[database] WARNING: DATABASE_URL sets "sslmode=disable" for the remote ` +
        `host "${url.hostname}". The connection — including your database ` +
        `password and all query results — will be sent UNENCRYPTED across ` +
        `the network. Remove it unless you have a specific reason.`,
    );
  }

  // Nothing changed → return the original string byte-for-byte, so normal
  // connection strings are never round-tripped through the URL parser.
  if (!changed) {
    return raw;
  }

  return url.toString();
}

/** Exposed for the connection doctor and for tests. */
export function isRemoteHost(hostname: string): boolean {
  return !isLocalHost(hostname);
}

/** Exposed so the doctor can describe what it will do before doing it. */
export function describeSslDecision(raw: string) {
  const { value } = readDeclaredSslMode(raw);
  let hostname = '';
  try {
    hostname = new URL(raw).hostname;
  } catch {
    /* unparseable — caller handles */
  }
  const declared = value === null ? null : value.trim().toLowerCase();
  const remote = hostname ? isRemoteHost(hostname) : false;
  return { declared, remote, hostname };
}
