import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MilestonesService } from './milestones.service';
import { claimMilestoneSchema, ClaimMilestoneDto } from './milestones.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('milestones')
export class MilestonesController {
  constructor(
    private readonly usersService: UsersService,
    private readonly milestonesService: MilestonesService,
  ) {}

  /** The five tiers with this user's eligibility and claim state resolved
   *  server-side — the client is never asked to work out whether it qualifies. */
  @Get()
  async list(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.milestonesService.listForUser(me.id);
  }

  @Post('claim')
  async claim(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(claimMilestoneSchema)) body: ClaimMilestoneDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.milestonesService.claim(me.id, body.milestoneKey);
  }
}
