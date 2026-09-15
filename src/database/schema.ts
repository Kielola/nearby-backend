import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
  boolean,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const radarVisibilityEnum = pgEnum('radar_visibility_mode', [
  'everyone',
  'friends',
  'hidden',
]);

// This is a normal, type-safe Drizzle table. Note there's no "location"
// column defined here — Postgres/PostGIS geography types aren't
// something Drizzle's schema DSL models natively, so we handle that
// part with a hand-written SQL migration (see migrations/0001_..).
// Everything else — the columns Drizzle DOES understand — stays fully
// type-safe end to end.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),

  // The link back to Firebase Auth. Firebase issues the identity;
  // Postgres owns everything else about the user.
  firebaseUid: text('firebase_uid').notNull().unique(),

  displayName: text('display_name').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),

  // Plain lat/lng columns. The PostGIS "location" geography column
  // (added via raw SQL) is generated FROM these automatically by
  // Postgres itself, so we never have to keep two values in sync by hand.
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),

  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),

  // Radar privacy controls, matching the old app's radar toggle + visibility
  // picker. "hidden"/"friends" still show you to people you already have a
  // relationship with (friend or existing chat) — proximity is a discovery
  // filter only, never a way to make an existing contact disappear.
  isVisibleOnRadar: boolean('is_visible_on_radar').notNull().default(true),
  radarVisibilityMode: radarVisibilityEnum('radar_visibility_mode')
    .notNull()
    .default('everyone'),

  // Moderation: banned users are excluded from radar unconditionally,
  // relationship or not.
  banned: boolean('banned').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof users.$inferSelect; // shape of a row you SELECT
export type NewUser = typeof users.$inferInsert; // shape of a row you INSERT
