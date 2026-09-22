import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

@Injectable()
export class ChatService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  // Finds an existing 1:1 conversation between two users, or creates one.
  // Avoids duplicate conversation threads for the same pair of people —
  // this exact bug class was part of the old one-sided-delivery issue.
  async getOrCreateDirectConversation(userIdA: string, userIdB: string) {
    const existing = await this.db
      .select({ conversationId: schema.conversationParticipants.conversationId })
      .from(schema.conversationParticipants)
      .where(inArray(schema.conversationParticipants.userId, [userIdA, userIdB]))
      .groupBy(schema.conversationParticipants.conversationId)
      .having(sql`count(distinct ${schema.conversationParticipants.userId}) = 2`);

    if (existing.length > 0) {
      return { conversationId: existing[0].conversationId, wasCreated: false };
    }

    const [conversation] = await this.db
      .insert(schema.conversations)
      .values({})
      .returning();

    await this.db.insert(schema.conversationParticipants).values([
      { conversationId: conversation.id, userId: userIdA },
      { conversationId: conversation.id, userId: userIdB },
    ]);

    return { conversationId: conversation.id, wasCreated: true };
  }

  async sendMessage(
    conversationId: string,
    senderId: string,
    data: {
      content?: string;
      mediaUrl?: string;
      mediaType?: string;
      audioDurationSec?: number;
      fileName?: string;
      fileSize?: string;
      // Client-generated idempotency key. Stored so every read path — the live
      // broadcast and REST history — returns the same value, letting the
      // sender match it against its optimistic bubble on either path.
      clientId?: string;
    },
  ) {
    const [message] = await this.db
      .insert(schema.messages)
      .values({ conversationId, senderId, ...data })
      .returning();
    return message;
  }

  async listMessages(conversationId: string) {
    return this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(schema.messages.createdAt);
  }

  // Used by the WebSocket gateway to check a user is actually a
  // participant before letting them join a conversation's "room" —
  // never trust a conversationId the client sends without checking.
  async isParticipant(conversationId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(schema.conversationParticipants)
      .where(
        and(
          eq(schema.conversationParticipants.conversationId, conversationId),
          eq(schema.conversationParticipants.userId, userId),
        ),
      );
    return !!row;
  }

  // Everything the frontend needs to render a chat list in one call:
  // every conversation the user is in, who the other person is, and
  // their most recent message (for a preview line). Without this, the
  // frontend would need N+1 requests (list conversations, then fetch
  // each one's messages just to show a preview).
  // Everything with created_at after this timestamp (and not sent by
  // this user) counts as unread — same "watermark" approach WhatsApp
  // uses, rather than a read flag on every individual message.
  async listConversationsForUser(userId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        c.id AS conversation_id,
        other.id AS other_user_id,
        other.display_name AS other_display_name,
        other.avatar_url AS other_avatar_url,
        lm.content AS last_message_content,
        lm.sender_id AS last_message_sender_id,
        lm.created_at AS last_message_created_at,
        (
          SELECT COUNT(*) FROM messages m
          WHERE m.conversation_id = c.id
            AND m.sender_id != ${userId}
            AND m.created_at > COALESCE(my_cp.last_read_at, 'epoch'::timestamptz)
        ) AS unread_count
      FROM conversation_participants my_cp
      JOIN conversations c ON c.id = my_cp.conversation_id
      JOIN conversation_participants other_cp
        ON other_cp.conversation_id = c.id AND other_cp.user_id != ${userId}
      JOIN users other ON other.id = other_cp.user_id
      LEFT JOIN LATERAL (
        SELECT content, sender_id, created_at
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) lm ON true
      WHERE my_cp.user_id = ${userId}
      ORDER BY lm.created_at DESC NULLS LAST
    `);
    return rows;
  }

  async markConversationRead(conversationId: string, userId: string) {
    await this.db
      .update(schema.conversationParticipants)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(schema.conversationParticipants.conversationId, conversationId),
          eq(schema.conversationParticipants.userId, userId),
        ),
      );
    return { ok: true };
  }
}
