import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

// Matches the threshold the old frontend already enforced client-side
// (reportsCount >= 10 hid a user from radar) — now enforced server-side
// as an actual ban, not just a display filter the client could ignore.
const AUTO_BAN_REPORT_THRESHOLD = 10;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async create(reporterId: string, reportedUserId: string, reason: string) {
    if (reporterId === reportedUserId) {
      throw new BadRequestException("Can't report yourself");
    }

    const [existing] = await this.db
      .select()
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.reporterId, reporterId),
          eq(schema.reports.reportedUserId, reportedUserId),
        ),
      );
    if (existing) {
      throw new ConflictException('Already reported this user');
    }

    const [report] = await this.db
      .insert(schema.reports)
      .values({ reporterId, reportedUserId, reason })
      .returning();

    const [{ value: reportCount }] = await this.db
      .select({ value: count() })
      .from(schema.reports)
      .where(eq(schema.reports.reportedUserId, reportedUserId));

    let banned = false;
    if (reportCount >= AUTO_BAN_REPORT_THRESHOLD) {
      await this.db
        .update(schema.users)
        .set({ banned: true })
        .where(eq(schema.users.id, reportedUserId));
      banned = true;
    }

    return { report, reportCount, banned };
  }
}
