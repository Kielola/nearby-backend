import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { users } from './schema';

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Join table: many-to-many between users and conversations.
export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Everything with created_at after this timestamp (and not sent by
    // this user) counts as unread — same "watermark" approach WhatsApp
    // uses, rather than a read flag on every individual message.
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.conversationId, table.userId] }),
  }),
);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  content: text('content'), // nullable now — media messages can have no text
  mediaUrl: text('media_url'),
  mediaType: text('media_type'), // 'image' | 'video' | 'voice' | 'document'
  audioDurationSec: doublePrecision('audio_duration_sec'),
  fileName: text('file_name'),
  fileSize: text('file_size'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
