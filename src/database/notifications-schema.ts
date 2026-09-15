import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { users } from './schema';

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id') // recipient
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id') // nullable — some notifications are system-generated
    .references(() => users.id, { onDelete: 'set null' }),
  type: text('type').notNull(), // 'friend_request' | 'friend_accepted' | 'message' | etc — kept as free text, no enum, since the frontend already owns this vocabulary
  title: text('title').notNull(),
  message: text('message').notNull(),
  isRead: boolean('is_read').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
