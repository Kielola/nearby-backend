import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InfluencersService } from './influencers.service';
import {
  applyInfluencerSchema,
  ApplyInfluencerDto,
  influencerStatusSchema,
  InfluencerStatusDto,
} from './influencers.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('influencers')
export class InfluencersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly influencersService: InfluencersService,
  ) {}

  /** The public creator board: approved creators, ranked, with real analytics. */
  @Get()
  async list() {
    return this.influencersService.listApproved();
  }

  @Post('apply')
  async apply(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(applyInfluencerSchema)) body: ApplyInfluencerDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.influencersService.apply(me.id, body);
  }

  @Get('mine')
  async mine(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.influencersService.myApplication(me.id);
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  @UseGuards(AdminGuard)
  @Get('all')
  async all() {
    return this.influencersService.listAll();
  }

  @UseGuards(AdminGuard)
  @Post(':id/status')
  async setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(influencerStatusSchema)) body: InfluencerStatusDto,
  ) {
    return this.influencersService.setStatus(id, body.status, body.reason);
  }
}
