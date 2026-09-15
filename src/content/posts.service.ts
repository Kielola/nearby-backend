import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

@Injectable()
export class PostsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async create(authorId: string, data: { caption?: string; mediaUrl?: string; mediaType?: string }) {
    const [post] = await this.db
      .insert(schema.posts)
      .values({ authorId, ...data })
      .returning();
    return post;
  }

  async forUser(userId: string) {
    return this.db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.authorId, userId))
      .orderBy(desc(schema.posts.createdAt));
  }

  // Feed = posts authored by anyone in a given set of user ids (typically
  // the caller's friends + themself), newest first.
  async feedForUsers(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.db
      .select()
      .from(schema.posts)
      .where(inArray(schema.posts.authorId, userIds))
      .orderBy(desc(schema.posts.createdAt));
  }

  async delete(postId: string, requesterId: string) {
    const [post] = await this.db.select().from(schema.posts).where(eq(schema.posts.id, postId));
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== requesterId) throw new ForbiddenException('Not your post');
    await this.db.delete(schema.posts).where(eq(schema.posts.id, postId));
    return { ok: true };
  }
}
