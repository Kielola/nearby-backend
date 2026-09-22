import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { UpdateMeDto } from './users.dto';

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
    //
    // This MUST be a single atomic statement with ON CONFLICT, not a
    // bare insert. On a brand-new account the client opens the chat
    // socket AND the calls socket at the same time, and both
    // gateways call this method on connect. Both requests SELECT,
    // both miss, both INSERT, and the loser hits
    // users_firebase_uid_unique and dies with an unhandled 500 /
    // socket disconnect. That is a first-login-only failure, which is
    // why it can pass every test and still hit real users.
    //
    // onConflictDoNothing makes the loser a no-op instead of an error,
    // and the follow-up SELECT then returns the winner's row.
    const [created] = await this.db
      .insert(schema.users)
      .values({
        firebaseUid: firebaseUser.uid,
        displayName: firebaseUser.name ?? 'New User',
        // `?? null`, not the raw value, and this is not defensive padding.
        //
        // postgres.js refuses `undefined` as a query parameter outright —
        // "UNDEFINED_VALUE: Undefined values are not allowed" — and throws
        // before the statement ever reaches Postgres. `email` and `picture` are
        // absent from a Firebase ID token whenever that claim is not present:
        // a phone-number sign-in has no email at all, and an account with no
        // profile photo has no picture.
        //
        // displayName was already guarded here; these two were not, so for
        // exactly those users the row was never created, the gateway rejected
        // the socket, and the account became permanently unreachable for calls
        // — the caller was told "they're not reachable right now" and nothing
        // anywhere said why.
        //
        // Both columns are nullable in the schema, so null is the correct value.
        email: firebaseUser.email ?? null,
        avatarUrl: firebaseUser.picture ?? null,
      })
      .onConflictDoNothing({ target: schema.users.firebaseUid })
      .returning();

    if (created) return created;

    // We lost the race — read back the row the other request created.
    const [raced] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.firebaseUid, firebaseUser.uid));

    return raced;
  }

  async updateAvatarUrl(userId: string, avatarUrl: string) {
    const [updated] = await this.db
      .update(schema.users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning();
    return updated;
  }

  /**
   * PATCH /me — the single write path for profile fields that used to be
   * written straight to the `users` Firestore document from the client.
   * `undefined` fields are dropped so a partial update never blanks out
   * a column the client didn't mention.
   */
  async updateMyProfile(userId: string, patch: UpdateMeDto) {
    const values: Record<string, unknown> = { updatedAt: new Date() };

    if (patch.displayName !== undefined) values.displayName = patch.displayName;
    if (patch.bio !== undefined) values.bio = patch.bio;
    if (patch.avatarUrl !== undefined) values.avatarUrl = patch.avatarUrl;
    if (patch.streetName !== undefined) values.streetName = patch.streetName;
    if (patch.customStatus !== undefined) values.customStatus = patch.customStatus;
    if (patch.locationAccuracy !== undefined) values.locationAccuracy = patch.locationAccuracy;

    const [updated] = await this.db
      .update(schema.users)
      .set(values)
      .where(eq(schema.users.id, userId))
      .returning();

    return updated;
  }

  /**
   * Record that this user accepted a specific version of the Terms of Service.
   *
   * Idempotent by design: accepting again — a re-prompt after the document
   * changes, or a duplicate request after a flaky reconnect — simply overwrites
   * with the newest version and a fresh server timestamp. The client fires this
   * without blocking the sign-up flow, so retries are expected and harmless.
   *
   * `ipHash` is an optional SHA-256 of the request IP. It lets us show later
   * that an acceptance came from a distinct origin without retaining the
   * address itself. Null when no usable header was present.
   */
  async acceptTerms(userId: string, version: string, ipHash: string | null) {
    const [updated] = await this.db
      .update(schema.users)
      .set({
        termsAcceptedVersion: version,
        termsAcceptedAt: new Date(),
        termsAcceptedIpHash: ipHash,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId))
      .returning({
        id: schema.users.id,
        termsAcceptedVersion: schema.users.termsAcceptedVersion,
        termsAcceptedAt: schema.users.termsAcceptedAt,
      });

    return updated;
  }

  /**
   * GET /users/:id — public profile for viewing a neighbour. Deliberately
   * excludes latitude/longitude, email and moderation flags.
   */
  async getPublicProfile(userId: string) {
    const [user] = await this.db
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        bio: schema.users.bio,
        streetName: schema.users.streetName,
        customStatus: schema.users.customStatus,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
