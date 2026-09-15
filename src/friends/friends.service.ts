import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

@Injectable()
export class FriendsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async sendRequest(senderId: string, receiverId: string) {
    if (senderId === receiverId) {
      throw new BadRequestException("Can't friend request yourself");
    }

    const [existing] = await this.db
      .select()
      .from(schema.friendRequests)
      .where(
        or(
          and(
            eq(schema.friendRequests.senderId, senderId),
            eq(schema.friendRequests.receiverId, receiverId),
          ),
          and(
            eq(schema.friendRequests.senderId, receiverId),
            eq(schema.friendRequests.receiverId, senderId),
          ),
        ),
      );

    if (existing) {
      if (existing.status === 'accepted') {
        throw new BadRequestException('Already friends');
      }
      if (existing.status === 'pending') {
        throw new BadRequestException('Request already pending');
      }
      // Previously declined — allow a fresh request by resetting it.
      const [updated] = await this.db
        .update(schema.friendRequests)
        .set({
          senderId,
          receiverId,
          status: 'pending',
          respondedAt: null,
          createdAt: new Date(),
        })
        .where(eq(schema.friendRequests.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(schema.friendRequests)
      .values({ senderId, receiverId })
      .returning();
    return created;
  }

  async respondToRequest(
    requestId: string,
    userId: string,
    accept: boolean,
  ) {
    const [request] = await this.db
      .select()
      .from(schema.friendRequests)
      .where(eq(schema.friendRequests.id, requestId));

    if (!request) throw new NotFoundException('Request not found');
    if (request.receiverId !== userId) {
      throw new ForbiddenException('Not your request to respond to');
    }

    const [updated] = await this.db
      .update(schema.friendRequests)
      .set({
        status: accept ? 'accepted' : 'declined',
        respondedAt: new Date(),
      })
      .where(eq(schema.friendRequests.id, requestId))
      .returning();
    return updated;
  }

  // Broadened beyond just "accepted" — this now covers unfriending AND
  // cancelling a request you sent that's still pending (the old app let
  // the sender delete their own pending request the same way).
  async unfriend(userId: string, otherUserId: string) {
    await this.db
      .delete(schema.friendRequests)
      .where(
        or(
          and(
            eq(schema.friendRequests.senderId, userId),
            eq(schema.friendRequests.receiverId, otherUserId),
          ),
          and(
            eq(schema.friendRequests.senderId, otherUserId),
            eq(schema.friendRequests.receiverId, userId),
          ),
        ),
      );
    return { ok: true };
  }

  async listIncomingRequests(userId: string) {
    return this.db
      .select()
      .from(schema.friendRequests)
      .where(
        and(
          eq(schema.friendRequests.receiverId, userId),
          eq(schema.friendRequests.status, 'pending'),
        ),
      );
  }

  // The mirror of listIncomingRequests — requests I sent that are still
  // awaiting a response. Needed so the frontend can show "Requested"
  // instead of "Add Friend" for people I've already asked.
  async listSentRequests(userId: string) {
    return this.db
      .select()
      .from(schema.friendRequests)
      .where(
        and(
          eq(schema.friendRequests.senderId, userId),
          eq(schema.friendRequests.status, 'pending'),
        ),
      );
  }

  async listFriends(userId: string) {
    const asSender = await this.db
      .select({ friend: schema.users })
      .from(schema.friendRequests)
      .innerJoin(schema.users, eq(schema.users.id, schema.friendRequests.receiverId))
      .where(
        and(
          eq(schema.friendRequests.senderId, userId),
          eq(schema.friendRequests.status, 'accepted'),
        ),
      );

    const asReceiver = await this.db
      .select({ friend: schema.users })
      .from(schema.friendRequests)
      .innerJoin(schema.users, eq(schema.users.id, schema.friendRequests.senderId))
      .where(
        and(
          eq(schema.friendRequests.receiverId, userId),
          eq(schema.friendRequests.status, 'accepted'),
        ),
      );

    return [...asSender, ...asReceiver].map((r) => r.friend);
  }
}
