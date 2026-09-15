import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';

export const NOTIFICATIONS_QUEUE = Symbol('NOTIFICATIONS_QUEUE');

const connection = { host: 'localhost', port: 6379 };

@Module({
  providers: [
    {
      provide: NOTIFICATIONS_QUEUE,
      useFactory: () => new Queue('notifications', { connection }),
    },
  ],
  exports: [NOTIFICATIONS_QUEUE],
})
export class JobsModule {}
