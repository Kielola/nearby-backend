import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async create(
    senderId: string | null,
    data: { userId: string; type: string; title: string; message: string },
  ) {
    const [notification] = await this.db
      .insert(schema.notifications)
      .values({ senderId, ...data })
      .returning();
    return notification;
  }

  async listForUser(userId: string) {
    return this.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(100);
  }

  async markRead(notificationId: string, userId: string) {
    await this.db
      .update(schema.notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.userId, userId), // never let one user mark another's notification read
        ),
      );
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.db
      .update(schema.notifications)
      .set({ isRead: true })
      .where(eq(schema.notifications.userId, userId));
    return { ok: true };
  }

  async setRead(notificationId: string, userId: string, isRead: boolean) {
    await this.db
      .update(schema.notifications)
      .set({ isRead })
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.userId, userId),
        ),
      );
    return { ok: true };
  }

  async delete(notificationId: string, userId: string) {
    await this.db
      .delete(schema.notifications)
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.userId, userId), // never let one user delete another's notification
        ),
      );
    return { ok: true };
  }

  async deleteAll(userId: string) {
    await this.db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    return { ok: true };
  }
}
