import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import { REDIS, PresenceStore } from '../redis/redis.module';
import * as schema from '../database/all-schema';

// Hard ceiling on how many neighbours a single radar call can return.
// Without this, a client asking for a huge radius gets the entire users
// table in one response (see getNearby() — radiusKm is user-supplied).
const MAX_RADAR_RESULTS = 500;

// Anything beyond this is not "nearby" by any definition, and a bigger
// number is almost always either a bug or an enumeration attempt.
const MAX_RADIUS_METERS = 50_000; // 50 km

@Injectable()
export class RadarService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    @Inject(REDIS) private readonly redis: PresenceStore,
  ) {}

  async updateLocation(userId: string, latitude: number, longitude: number) {
    await this.db
      .update(schema.users)
      .set({ latitude, longitude, lastActiveAt: new Date() })
      .where(sql`${schema.users.id} = ${userId}`);
  }

  async setVisibility(
    userId: string,
    isVisibleOnRadar: boolean,
    radarVisibilityMode: 'everyone' | 'friends' | 'hidden',
  ) {
    await this.db
      .update(schema.users)
      .set({ isVisibleOnRadar, radarVisibilityMode })
      .where(sql`${schema.users.id} = ${userId}`);
    return { ok: true };
  }

  // Mirrors the old app's exact radar rules:
  // - banned users are excluded, no exceptions
  // - isVisibleOnRadar=false or mode='hidden' still shows to friends/existing chats
  // - mode='friends' only shows to actual friends
  // - proximity radius is a DISCOVERY filter only — friends/existing chats
  //   are never dropped just for being outside the radius
  //
  // PERFORMANCE: the radius test must be ST_DWithin, not ST_Distance <= x.
  // `ST_Distance(...) <= radius` is not something Postgres can satisfy from
  // the GiST index, so it forces a sequential scan over every row in users
  // and computes the distance for each one. ST_DWithin is the index-aware
  // "within a distance" predicate and uses users_location_gist_idx.
  //
  // Friends / existing chats are gathered separately by primary-key joins
  // instead of being OR-ed into the same WHERE clause — because
  // `ST_DWithin(...) OR EXISTS(...)` is *also* not index-usable, and would
  // reintroduce the sequential scan we are fixing here.
  async findNearby(userId: string, radiusMeters: number) {
    const clampedRadius = Math.min(
      Math.max(Number.isFinite(radiusMeters) ? radiusMeters : 0, 1),
      MAX_RADIUS_METERS,
    );

    const rows = await this.db.execute(sql`
      WITH me AS (
        SELECT location FROM users WHERE id = ${userId}
      ),
      -- Index-assisted: only rows physically within the radius.
      nearby AS (
        SELECT u.id, ST_Distance(u.location, me.location) AS distance_m
        FROM users u, me
        WHERE u.id <> ${userId}
          AND u.location IS NOT NULL
          AND me.location IS NOT NULL
          AND ST_DWithin(u.location, me.location, ${clampedRadius})
      ),
      -- Every accepted friend, in either direction.
      accepted_friends AS (
        SELECT CASE
                 WHEN fr.sender_id = ${userId} THEN fr.receiver_id
                 ELSE fr.sender_id
               END AS id
        FROM friend_requests fr
        WHERE fr.status = 'accepted'
          AND (fr.sender_id = ${userId} OR fr.receiver_id = ${userId})
      ),
      -- Anyone the user already has a conversation with.
      existing_partners AS (
        SELECT cp1.user_id AS id
        FROM conversation_participants cp1
        JOIN conversation_participants cp2
          ON cp1.conversation_id = cp2.conversation_id
        WHERE cp2.user_id = ${userId}
          AND cp1.user_id <> ${userId}
      ),
      -- Union of "within radius" + "already connected". Small by
      -- construction, so the join back to users below is cheap.
      candidate_ids AS (
        SELECT id FROM nearby
        UNION
        SELECT id FROM accepted_friends
        UNION
        SELECT id FROM existing_partners
      ),
      candidates AS (
        SELECT
          u.id,
          u.display_name,
          u.avatar_url,
          u.bio,
          u.street_name,
          u.custom_status,
          u.is_visible_on_radar,
          u.radar_visibility_mode,
          u.banned,
          COALESCE(
            n.distance_m,
            ST_Distance(u.location, me.location)
          ) AS distance_m,
          (f.id IS NOT NULL) AS is_friend,
          (p.id IS NOT NULL) AS has_existing_chat
        FROM candidate_ids ci
        JOIN users u ON u.id = ci.id
        CROSS JOIN me
        LEFT JOIN nearby n              ON n.id = ci.id
        LEFT JOIN accepted_friends f    ON f.id = ci.id
        LEFT JOIN existing_partners p   ON p.id = ci.id
        WHERE u.banned = false
      )
      SELECT
        id,
        display_name,
        avatar_url,
        bio,
        street_name,
        custom_status,
        ROUND((distance_m / 1000)::numeric, 2) AS distance_km,
        is_friend,
        has_existing_chat
      FROM candidates
      WHERE (is_visible_on_radar OR is_friend OR has_existing_chat)
        AND (radar_visibility_mode != 'hidden' OR is_friend OR has_existing_chat)
        AND (radar_visibility_mode != 'friends' OR is_friend)
        AND (distance_m <= ${clampedRadius} OR is_friend OR has_existing_chat)
      ORDER BY distance_m ASC NULLS LAST
      LIMIT ${MAX_RADAR_RESULTS}
    `);

    return this.withPresence(rows);
  }

  /**
   * Overlay live online status from Redis onto the radar rows.
   *
   * This is what replaces the client's old `onSnapshot(collection(db,
   * 'presence'))` listener, which downloaded EVERY user's presence
   * document to EVERY client (O(n^2) reads). One `mget` for the whole
   * page of results instead.
   *
   * `db.execute()` returns an array-like; normalise it first.
   */
  private async withPresence(rows: unknown): Promise<Record<string, unknown>[]> {
    const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    if (list.length === 0) return list;

    const ids = list
      .map((r) => r.id)
      .filter((id): id is string => typeof id === 'string');

    let onlineIds = new Set<string>();
    try {
      const values = await this.redis.mget(...ids.map((id) => `presence:${id}`));
      onlineIds = new Set(ids.filter((_, i) => values[i] !== null));
    } catch {
      // Redis being down must not take the radar down with it — everyone
      // just reads as offline until it recovers.
    }

    return list.map((row) => ({
      ...row,
      is_online: typeof row.id === 'string' && onlineIds.has(row.id),
    }));
  }
}
