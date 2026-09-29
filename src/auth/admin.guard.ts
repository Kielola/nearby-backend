import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Admin gate for the review endpoints (payout approval, influencer approval,
 * marking a referral fraudulent).
 *
 * ## Why an env allowlist instead of an `isAdmin` column
 *
 * A column lives in the same database the app writes to. Any bug that lets a
 * user write to their own `users` row — and the original referral app had
 * exactly that, with `allow read, write: if true` — is simultaneously a bug that
 * grants admin. Keeping the list in `ADMIN_FIREBASE_UIDS`, which lives only on
 * the server, means the two failures cannot happen together.
 *
 * There is also nothing to migrate, and revoking someone is an env change
 * rather than a data edit.
 *
 * Put this AFTER `FirebaseAuthGuard` so `request.user` is populated.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const uid: string | undefined = request?.user?.uid;

    if (!uid) {
      throw new ForbiddenException('Admin access requires an authenticated account.');
    }

    const admins = (process.env.ADMIN_FIREBASE_UIDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (admins.length === 0) {
      // Fail closed. An empty allowlist must mean "nobody is an admin", never
      // "everybody is" — the tempting `if (admins.length === 0) return true;`
      // would turn a missing env var into an open admin API.
      throw new ForbiddenException(
        'Admin access is not configured on this server (ADMIN_FIREBASE_UIDS is empty).',
      );
    }

    if (!admins.includes(uid)) {
      throw new ForbiddenException('This account does not have admin access.');
    }

    return true;
  }
}
