import 'dotenv/config';
import { Worker } from 'bullmq';

// Was hardcoded to localhost:6379, which does not exist in production.
function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

new Worker(
  'notifications',
  async (job) => {
    console.log(`Processing notification job ${job.id}:`, job.data);
    // Push notification / email sending logic goes here later.
  },
  { connection: redisConnection() },
);

console.log('Notifications worker running.');
