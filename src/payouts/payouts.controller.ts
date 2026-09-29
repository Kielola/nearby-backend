import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PayoutsService } from './payouts.service';
import {
  requestPayoutSchema,
  RequestPayoutDto,
  socialTagSchema,
  SocialTagDto,
  updatePayoutStatusSchema,
  UpdatePayoutStatusDto,
} from './payouts.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('payouts')
export class PayoutsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly payoutsService: PayoutsService,
  ) {}

  @Post()
  async request(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(requestPayoutSchema)) body: RequestPayoutDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    // A key that is unique per attempt but stable across retries of the same
    // attempt. The client sends its own; if it does not, one is generated here
    // so the call still succeeds — it simply cannot deduplicate across a retry.
    const key = body.idempotencyKey ?? `payout_request:${me.id}:${randomUUID()}`;
    return this.payoutsService.request(
      me.id,
      {
        amountKobo: body.amountKobo,
        bankName: body.bankName,
        accountNumber: body.accountNumber,
        accountName: body.accountName,
      },
      key,
    );
  }

  @Get('mine')
  async mine(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.payoutsService.myPayouts(me.id);
  }

  @Post(':id/social-tag')
  async socialTag(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(socialTagSchema)) body: SocialTagDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.payoutsService.setSocialTag(me.id, id, body.handle);
  }

  // ── Admin: the manual payout queue ───────────────────────────────────────

  @UseGuards(AdminGuard)
  @Get()
  async list(@Query('status') status?: string) {
    return this.payoutsService.listAll(status);
  }

  @UseGuards(AdminGuard)
  @Post(':id/status')
  async updateStatus(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePayoutStatusSchema)) body: UpdatePayoutStatusDto,
  ) {
    return this.payoutsService.updateStatus(id, body.status, firebaseUser.uid, body.reason);
  }
}
