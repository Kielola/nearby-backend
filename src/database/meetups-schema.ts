import { pgTable, uuid, text, integer, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { users } from './schema';

export const meetupStatusEnum = pgEnum('meetup_status', [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
]);

export const meetups = pgTable('meetups', {
  id: uuid('id').primaryKey().defaultRandom(),
  requesterId: uuid('requester_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  otherUserId: uuid('other_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  location: text('location'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  status: meetupStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const meetupRatings = pgTable(
  'meetup_ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    meetupId: uuid('meetup_id')
      .notNull()
      .references(() => meetups.id, { onDelete: 'cascade' }),
    raterId: uuid('rater_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ratedUserId: uuid('rated_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(), // 1-5, enforced in the Zod DTO
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // One rating per rater per meetup — can't inflate/deflate someone's
    // score by rating the same meetup repeatedly.
    uniqueRaterPerMeetup: unique().on(table.meetupId, table.raterId),
  }),
);
