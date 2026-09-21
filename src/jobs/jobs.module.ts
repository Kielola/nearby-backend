import { Logger, Module } from '@nestjs/common';
import { Queue } from 'bullmq';

export const NOTIFICATIONS_QUEUE = Symbol('NOTIFICATIONS_QUEUE');

// This used to be a hardcoded { host: 'localhost', port: 6379 }.
// On a hosted deployment Redis is never on localhost, so BullMQ would
// silently fail to connect and every queued notification would be lost.
// RedisModule already reads REDIS_URL correctly — do the same here.
function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    // Upstash and most managed Redis providers only expose TLS.
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Module({
  providers: [
    {
      provide: NOTIFICATIONS_QUEUE,
      useFactory: () => {
        // Nothing enqueues to this queue yet, so without a Redis URL
        // there's no reason to open a connection that will only retry
        // forever and fill the logs. Provide a null handle instead;
        // anything that later needs it must check for a Redis URL first.
        if (!process.env.REDIS_URL) {
          new Logger('JobsModule').warn(
            'REDIS_URL is not set — background queue disabled.',
          );
          return null;
        }
        return new Queue('notifications', { connection: redisConnection() });
      },
    },
  ],
  exports: [NOTIFICATIONS_QUEUE],
})
export class JobsModule {}
