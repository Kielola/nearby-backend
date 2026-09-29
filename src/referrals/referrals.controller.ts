import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReferralsService } from './referrals.service';
import { attributeReferralSchema, AttributeReferralDto, markFraudSchema, MarkFraudDto } from './referrals.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('referrals')
export class ReferralsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly referralsService: ReferralsService,
  ) {}

  /** Everything the referral hub renders, in one round trip. */
  @Get('me')
  async me(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.referralsService.myProfile(me.id);
  }

  @Get('link')
  async link(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const code = await this.referralsService.ensureCode(me.id);
    return { code, link: await this.referralsService.referralLink(me.id) };
  }

  @Get('list')
  async list(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.referralsService.myReferrals(me.id);
  }

  @Get('analytics')
  async analytics(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.referralsService.myAnalytics(me.id);
  }

  /**
   * Called by the client immediately after signup, with the code captured from
   * the invite link. The body carries the code and nothing else — no referrer id
   * and no counts — so a client cannot assert an attribution that did not happen.
   */
  @Post('attribute')
  async attribute(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(attributeReferralSchema)) body: AttributeReferralDto,
    @Ip() ip: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.referralsService.attribute({
      referredUserId: me.id,
      code: body.code,
      ip,
      deviceHash: body.deviceHash,
    });
  }

  /** The current user's own referral qualifies — called once they have accepted
   *  the terms and completed a profile. */
  @Post('qualify')
  async qualify(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.referralsService.qualify(me.id);
  }


  // ── Admin review ─────────────────────────────────────────────────────────

  /** Admin: recompute the retention metric from stored activity. One statement,
   *  no client input — see `recomputeRetention` for the definition. */
  @UseGuards(AdminGuard)
  @Post('retention/recompute')
  async recomputeRetention() {
    return this.referralsService.recomputeRetention();
  }

  @UseGuards(AdminGuard)
  @Get('review')
  async review(@Query('limit') limit?: string) {
    return this.referralsService.listForReview(limit ? Number(limit) : 100);
  }

  @UseGuards(AdminGuard)
  @Post(':id/fraudulent')
  async markFraudulent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(markFraudSchema)) body: MarkFraudDto,
  ) {
    return this.referralsService.markFraudulent(id, body.reason);
  }
}

/**
 * Unauthenticated click tracking.
 *
 * A visitor who follows an invite link has no account yet, so this cannot sit
 * behind the auth guard. It writes one append-only row and nothing else: no
 * balance, no attribution, no referral. The worst a spammer can do here is
 * inflate a click count they are not paid on — the money is only ever unlocked
 * by a verified referral, which requires a real account.
 */
@Controller('referrals')
export class ReferralPublicController {
  constructor(private readonly referralsService: ReferralsService) {}

  @Post('click')
  async click(
    @Body(new ZodValidationPipe(attributeReferralSchema.pick({ code: true }))) body: { code: string },
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.referralsService.logClick(body.code, ip, userAgent);
  }

  @Get('code/:code')
  async lookup(@Param('code') code: string) {
    const resolved = await this.referralsService.resolveCode(code);
    // A boolean and nothing else — never the owner's identity, so this cannot be
    // used to map codes to people.
    return { valid: Boolean(resolved) };
  }
}
