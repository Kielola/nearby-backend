import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * The only Redis surface this app uses.
 *
 * Presence is deliberately tiny: set a key with a TTL, delete it, read a
 * batch. Keeping that contract written down means an alternative
 * implementation only has to satisfy four methods, not the whole ioredis
 * API.
 */
export interface PresenceStore {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

/**
 * In-memory stand-in for Redis, used when REDIS_URL is not configured.
 *
 * WHY THIS EXISTS
 * ---------------
 * Redis is a third service to sign up for, keep alive, and pay for once you
 * outgrow a free tier. But the only thing this app actually stores in it is
 * "who is online right now" — a key that expires after 90 seconds.
 *
 * For a single-instance deployment (which is what every free tier gives you
 * anyway — see the render.yaml blueprint) an in-memory Map with TTLs is
 * functionally identical, and it removes an entire dependency from the
 * deployment: one less signup, one less secret, one less thing to break.
 *
 * Trade-offs, stated plainly:
 *   - Presence is lost on restart. Users flicker offline for one heartbeat
 *     cycle (~60s) and then reappear. Nobody loses data.
 *   - It does NOT work across multiple instances. The moment you run more
 *     than one backend, you must set REDIS_URL. The app logs a warning at
 *     boot so this can't be forgotten silently.
 */
class InMemoryPresenceStore implements PresenceStore {
  private store = new Map<string, { value: string; expiresAt: number }>();

  private sweepIfExpired(key: string): void {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt <= Date.now()) this.store.delete(key);
  }

  async set(key: string, value: string, _mode: 'EX', ttlSeconds: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return 'OK';
  }

  async del(key: string) {
    const existed = this.store.delete(key);
    return existed ? 1 : 0;
  }

  async mget(...keys: string[]) {
    return keys.map((key) => {
      this.sweepIfExpired(key);
      return this.store.get(key)?.value ?? null;
    });
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PresenceStore => {
        const url = config.get<string>('REDIS_URL');

        if (!url) {
          new Logger('RedisModule').warn(
            'REDIS_URL is not set — using an in-memory presence store. ' +
              'Online status works, but it is reset whenever this process ' +
              'restarts and will NOT work if you ever run more than one ' +
              'instance. Set REDIS_URL before you scale.',
          );
          return new InMemoryPresenceStore();
        }

        // ioredis handles both redis:// and rediss:// (TLS) from the URL,
        // which is what managed providers such as Upstash and Redis Cloud
        // hand you.
        return new Redis(url);
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
