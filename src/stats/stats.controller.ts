import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { StatsService } from './stats.service';

@UseGuards(FirebaseAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly statsService: StatsService,
  ) {}

  /** Admin only: these are the programme's real numbers, including money owed. */
  @UseGuards(AdminGuard)
  @Get()
  async platform() {
    return this.statsService.platformStats();
  }

  /** Public-ish: the activity ticker shows first names only. */
  @Get('activity')
  async activity(@Query('limit') limit?: string) {
    return this.statsService.recentActivity(limit ? Number(limit) : 25);
  }

  @UseGuards(AdminGuard)
  @Get('daily')
  async daily(@Query('days') days?: string) {
    return this.statsService.dailySeries(days ? Number(days) : 30);
  }

  @Get('withdrawal-eligibility')
  async eligibility(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.statsService.withdrawalEligibility(me.id);
  }
}
