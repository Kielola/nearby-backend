import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, avg, count, eq, or, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

@Injectable()
export class MeetupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private async areFriends(userIdA: string, userIdB: string): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(schema.friendRequests)
      .where(
        and(
          eq(schema.friendRequests.status, 'accepted'),
          or(
            and(
              eq(schema.friendRequests.senderId, userIdA),
              eq(schema.friendRequests.receiverId, userIdB),
            ),
            and(
              eq(schema.friendRequests.senderId, userIdB),
              eq(schema.friendRequests.receiverId, userIdA),
            ),
          ),
        ),
      );
    return !!row;
  }

  async schedule(requesterId: string, otherUserId: string, scheduledAt?: string, location?: string) {
    if (requesterId === otherUserId) {
      throw new BadRequestException("Can't schedule a meetup with yourself");
    }
    if (!(await this.areFriends(requesterId, otherUserId))) {
      throw new ForbiddenException('You can only schedule meetups with friends');
    }

    const [meetup] = await this.db
      .insert(schema.meetups)
      .values({
        requesterId,
        otherUserId,
        location,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
      })
      .returning();
    return meetup;
  }

  private async getParticipantMeetup(meetupId: string, userId: string) {
    const [meetup] = await this.db
      .select()
      .from(schema.meetups)
      .where(eq(schema.meetups.id, meetupId));
    if (!meetup) throw new NotFoundException('Meetup not found');
    if (meetup.requesterId !== userId && meetup.otherUserId !== userId) {
      throw new ForbiddenException('Not a participant in this meetup');
    }
    return meetup;
  }

  async updateStatus(
    meetupId: string,
    userId: string,
    status: 'confirmed' | 'completed' | 'cancelled',
  ) {
    await this.getParticipantMeetup(meetupId, userId);
    const [updated] = await this.db
      .update(schema.meetups)
      .set({ status })
      .where(eq(schema.meetups.id, meetupId))
      .returning();
    return updated;
  }

  async listForUser(userId: string) {
    return this.db
      .select()
      .from(schema.meetups)
      .where(or(eq(schema.meetups.requesterId, userId), eq(schema.meetups.otherUserId, userId)));
  }

  async rate(meetupId: string, raterId: string, rating: number, comment?: string) {
    const meetup = await this.getParticipantMeetup(meetupId, raterId);
    if (meetup.status !== 'completed') {
      throw new BadRequestException('Can only rate a completed meetup');
    }
    const ratedUserId = meetup.requesterId === raterId ? meetup.otherUserId : meetup.requesterId;

    const [existing] = await this.db
      .select()
      .from(schema.meetupRatings)
      .where(
        and(eq(schema.meetupRatings.meetupId, meetupId), eq(schema.meetupRatings.raterId, raterId)),
      );
    if (existing) {
      throw new ConflictException('Already rated this meetup');
    }

    const [created] = await this.db
      .insert(schema.meetupRatings)
      .values({ meetupId, raterId, ratedUserId, rating, comment })
      .returning();
    return created;
  }

  // Individual ratings received, with comments — used for a profile's
  // review list, distinct from getStatsForUser's aggregate numbers.
  async getRatingsForUser(userId: string) {
    return this.db
      .select()
      .from(schema.meetupRatings)
      .where(eq(schema.meetupRatings.ratedUserId, userId));
  }

  // Aggregated on the fly rather than stored/denormalized on the user row —
  // one extra query beats a trustScore that silently drifts out of sync
  // with the ratings actually behind it.
  async getStatsForUser(userId: string) {
    const [meetupStats] = await this.db
      .select({ value: count() })
      .from(schema.meetups)
      .where(
        and(
          or(eq(schema.meetups.requesterId, userId), eq(schema.meetups.otherUserId, userId)),
          eq(schema.meetups.status, 'completed'),
        ),
      );

    const [ratingStats] = await this.db
      .select({ ratingsCount: count(), averageRating: avg(schema.meetupRatings.rating) })
      .from(schema.meetupRatings)
      .where(eq(schema.meetupRatings.ratedUserId, userId));

    return {
      meetupsCompleted: meetupStats?.value ?? 0,
      ratingsCount: ratingStats?.ratingsCount ?? 0,
      averageRating: ratingStats?.averageRating ? Number(ratingStats.averageRating) : null,
    };
  }
}
