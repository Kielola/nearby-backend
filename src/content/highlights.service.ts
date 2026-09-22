import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { withoutUndefined } from '../common/without-undefined';

@Injectable()
export class HighlightsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async create(userId: string, data: { mediaUrl: string; mediaType: string; caption?: string }) {
    const [highlight] = await this.db
      .insert(schema.highlights)
      // `caption` is optional — same UNDEFINED_VALUE crash as messages and posts.
      .values(withoutUndefined({ userId, ...data }))
      .returning();
    return highlight;
  }

  async forUser(userId: string) {
    return this.db
      .select()
      .from(schema.highlights)
      .where(eq(schema.highlights.userId, userId))
      .orderBy(asc(schema.highlights.createdAt));
  }

  async delete(highlightId: string, requesterId: string) {
    const [highlight] = await this.db
      .select()
      .from(schema.highlights)
      .where(eq(schema.highlights.id, highlightId));
    if (!highlight) throw new NotFoundException('Highlight not found');
    if (highlight.userId !== requesterId) throw new ForbiddenException('Not your highlight');
    await this.db.delete(schema.highlights).where(eq(schema.highlights.id, highlightId));
    return { ok: true };
  }
}
