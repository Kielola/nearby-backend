import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

@Injectable()
export class RadarService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
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
  async findNearby(userId: string, radiusMeters: number) {
    const rows = await this.db.execute(sql`
      WITH me AS (
        SELECT location FROM users WHERE id = ${userId}
      ),
      candidates AS (
        SELECT
          u.id,
          u.display_name,
          u.avatar_url,
          u.is_visible_on_radar,
          u.radar_visibility_mode,
          u.banned,
          ST_Distance(u.location, me.location) AS distance_m,
          EXISTS (
            SELECT 1 FROM friend_requests fr
            WHERE fr.status = 'accepted'
              AND ((fr.sender_id = u.id AND fr.receiver_id = ${userId})
                OR (fr.sender_id = ${userId} AND fr.receiver_id = u.id))
          ) AS is_friend,
          EXISTS (
            SELECT 1 FROM conversation_participants cp1
            JOIN conversation_participants cp2
              ON cp1.conversation_id = cp2.conversation_id
            WHERE cp1.user_id = u.id AND cp2.user_id = ${userId}
          ) AS has_existing_chat
        FROM users u, me
        WHERE u.id != ${userId} AND u.location IS NOT NULL
      )
      SELECT
        id,
        display_name,
        avatar_url,
        ROUND((distance_m / 1000)::numeric, 2) AS distance_km,
        is_friend,
        has_existing_chat
      FROM candidates
      WHERE NOT banned
        AND (is_visible_on_radar OR is_friend OR has_existing_chat)
        AND (radar_visibility_mode != 'hidden' OR is_friend OR has_existing_chat)
        AND (radar_visibility_mode != 'friends' OR is_friend)
        AND (distance_m <= ${radiusMeters} OR is_friend OR has_existing_chat)
      ORDER BY distance_m ASC NULLS LAST
    `);
    return rows;
  }
}
