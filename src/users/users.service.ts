import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';

interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
}

@Injectable()
export class UsersService {
  // @Inject(DRIZZLE) pulls the exact connection DatabaseModule created —
  // this class never opens its own connection or knows the connection
  // string. That's the whole point of DI: swap the DB implementation
  // later and this file doesn't change.
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async findOrCreateByFirebaseUid(firebaseUser: VerifiedFirebaseUser) {
    const [existing] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.firebaseUid, firebaseUser.uid));

    if (existing) return existing;

    // First time we've ever seen this Firebase uid — provision a row.
    // .returning() gets Postgres to hand back the inserted row in the
    // same round trip, instead of a second SELECT after inserting.
    const [created] = await this.db
      .insert(schema.users)
      .values({
        firebaseUid: firebaseUser.uid,
        displayName: firebaseUser.name ?? 'New User',
        email: firebaseUser.email,
        avatarUrl: firebaseUser.picture,
      })
      .returning();

    return created;
  }

  async updateAvatarUrl(userId: string, avatarUrl: string) {
    const [updated] = await this.db
      .update(schema.users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning();
    return updated;
  }
}
