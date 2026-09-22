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

  // Human-readable location label ("Herbert Macaulay Way, Yaba, Lagos").
  // Resolved client-side from the GPS fix and synced here, so that OTHER
  // users' radar results can show a real street instead of a hardcoded
  // placeholder. Previously the frontend fabricated this everywhere with
  // getStateStreets('Osun')[0] -> every neighbour read "Gbongan Rd".
  streetName: text('street_name'),

  // Free-text status ("Jollof hunting in Yaba").
  customStatus: text('custom_status'),

  // Plain lat/lng columns. The PostGIS "location" geography column
  // (added via raw SQL) is generated FROM these automatically by
  // Postgres itself, so we never have to keep two values in sync by hand.
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),

  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),

  // Horizontal accuracy of the GPS fix, in metres, as reported by the
  // browser. Stored so we can refuse to trust (and never persist) a
  // location label derived from a fix too imprecise to name a street.
  locationAccuracy: doublePrecision('location_accuracy'),

  // Radar privacy controls, matching the old app's radar toggle + visibility
  // picker. "hidden"/"friends" still show you to people you already have a
  // relationship with (friend or existing chat) — proximity is a discovery
  // filter only, never a way to make an existing contact disappear.
  isVisibleOnRadar: boolean('is_visible_on_radar').notNull().default(true),
  radarVisibilityMode: radarVisibilityEnum('radar_visibility_mode')
    .notNull()
    .default('everyone'),

  // Terms of Service acceptance.
  //
  // Stored server-side because this is the record that has to hold up if the
  // question is ever asked "did this user agree to the terms, and to which
  // version?" A client-side flag cannot answer that: it is cleared by emptying
  // browser storage and never survives a reinstall.
  //
  // The timestamp is set by the server at write time, never sent by the client
  // — an acceptance record the client can backdate is worthless. `version`
  // lets us re-prompt everyone when the document itself changes.
  termsAcceptedVersion: text('terms_accepted_version'),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  termsAcceptedIpHash: text('terms_accepted_ip_hash'),

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
