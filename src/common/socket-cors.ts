/**
 * Socket.IO CORS origin resolver.
 *
 * Both gateways previously hardcoded `cors: { origin: '*' }` with a
 * "lock this down before prod" comment. An open socket origin means any
 * website can open a connection to your realtime API on a visitor's
 * behalf. Read the same FRONTEND_URL list the HTTP layer uses so there
 * is exactly one place to configure allowed origins.
 *
 * Note: Socket.IO sends `Access-Control-Allow-Credentials` when
 * `credentials` is set, and browsers reject `*` in that combination —
 * another reason a wildcard is not a workable production default.
 */
export function socketCorsOrigins(): string[] | boolean {
  const configured = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;

  // No FRONTEND_URL set. Allowing every origin is acceptable for local
  // dev only — in production it is almost always a misconfiguration, so
  // we fail closed instead of silently exposing the API.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'FRONTEND_URL is not set in production — refusing all socket origins. ' +
        'Set FRONTEND_URL to your deployed frontend origin(s), comma-separated.',
    );
    return false;
  }

  return true;
}
