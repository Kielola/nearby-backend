import 'dotenv/config';
import { Worker } from 'bullmq';

const connection = { host: 'localhost', port: 6379 };

new Worker(
  'notifications',
  async (job) => {
    console.log(`Processing notification job ${job.id}:`, job.data);
    // Push notification / email sending logic goes here later.
  },
  { connection },
);

console.log('Notifications worker running.');
