import { ArgumentsHost, Catch, Logger, WsExceptionFilter } from '@nestjs/common';
import { Socket } from 'socket.io';

/**
 * Logging and client feedback for anything thrown inside a gateway handler.
 *
 * WHY THIS EXISTS
 *
 * Nest's HTTP filter — `GlobalExceptionFilter`, registered with
 * `app.useGlobalFilters()` in `main.ts` — does NOT apply to gateways. Nest's own
 * documentation is explicit that `useGlobalFilters()` sets up HTTP filters only.
 * So every socket handler that threw fell through to Nest's built-in
 * `WsExceptionsHandler`, which prints exactly this and nothing more:
 *
 *     ERROR [WsExceptionsHandler] UNDEFINED_VALUE: Undefined values are not allowed
 *
 * No event name. No user. No gateway. No query. That one line was the entire
 * evidence available for a live outage: it did not say which of the two gateways
 * threw, which client event caused it, or whose account was affected — and
 * because postgres.js throws from inside the driver, even the stack pointed at
 * `postgres/cjs/src/types.js` rather than at any code of ours.
 *
 * This filter restores the three missing facts — the event name, the
 * authenticated user id, and the driver's error code — and pushes a plain
 * `app:error` back to the client, so the app can stop silently waiting on a
 * request the server already abandoned. Socket.IO clients ignore events they
 * have no listener for, so sending it is additive and cannot break a client.
 *
 * Attached per gateway with `@UseFilters(GatewayExceptionFilter)` — filters
 * registered globally in `main.ts` would not reach these handlers.
 */
@Catch()
export class GatewayExceptionFilter implements WsExceptionFilter {
  private readonly logger = new Logger('gateway');

  catch(exception: unknown, host: ArgumentsHost) {
    const ws = host.switchToWs();
    const client = ws.getClient<Socket>();
    const pattern = ws.getPattern();
    const err = exception as
      | { code?: string; message?: string; stack?: string }
      | undefined;

    const userId =
      (client?.data as { userId?: string } | undefined)?.userId ?? 'unauthenticated';
    const detail = err?.code ? `${err.code} — ${err.message}` : (err?.message ?? String(exception));

    this.logger.error(`[ws] ${String(pattern)} failed for ${userId}: ${detail}`, err?.stack);

    if (client?.connected) {
      client.emit('app:error', { event: String(pattern), message: detail });
    }
  }
}
