import { Inject, Injectable } from '@nestjs/common';
import { REDIS, PresenceStore } from '../redis/redis.module';

// A key existing (with a live TTL) means "online". No explicit "offline"
// bookkeeping needed for the common case — a phone that closes the app,
// loses signal, or crashes just stops refreshing its key and it expires
// on its own after HEARTBEAT_TTL_SECONDS. This is deliberately simpler
// than tracking connect/disconnect events, which get unreliable the
// moment a client doesn't get to say goodbye cleanly.
const HEARTBEAT_TTL_SECONDS = 90;
const key = (userId: string) => `presence:${userId}`;

@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS) private readonly redis: PresenceStore) {}

  async heartbeat(userId: string) {
    await this.redis.set(key(userId), new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
    return { ok: true };
  }

  // Called on explicit logout / app close — lets a user show as offline
  // immediately instead of waiting out the TTL.
  async goOffline(userId: string) {
    await this.redis.del(key(userId));
    return { ok: true };
  }

  // One round trip for a whole batch (e.g. everyone in the current radar
  // list or chat thread list) instead of one Redis call per user.
  async getStatusForUsers(userIds: string[]): Promise<Record<string, boolean>> {
    if (userIds.length === 0) return {};
    const keys = userIds.map(key);
    const values = await this.redis.mget(...keys);
    const result: Record<string, boolean> = {};
    userIds.forEach((id, i) => {
      result[id] = values[i] !== null;
    });
    return result;
  }
}
