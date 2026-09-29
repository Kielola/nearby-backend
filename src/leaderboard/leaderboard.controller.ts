import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { LeaderboardService, LeaderboardPeriod } from './leaderboard.service';

const PERIODS: LeaderboardPeriod[] = ['weekly', 'biweekly', 'monthly', 'all_time'];

@UseGuards(FirebaseAuthGuard)
@Controller('leaderboard')
export class LeaderboardController {
  constructor(
    private readonly usersService: UsersService,
    private readonly leaderboardService: LeaderboardService,
  ) {}

  /** All four boards in one response — one round trip instead of four, which is
   *  what the hub actually needs. */
  @Get()
  async all(@Query('limit') limit?: string) {
    return this.leaderboardService.getAllBoards(limit ? Number(limit) : 50);
  }

  // Declared before `:period` on purpose — Nest matches routes in declaration
  // order, and `:period` would otherwise swallow "snapshots".
  @UseGuards(AdminGuard)
  @Get('snapshots')
  async snapshots(@Query('period') period?: string) {
    return this.leaderboardService.listSnapshots(
      period && PERIODS.includes(period as LeaderboardPeriod)
        ? (period as LeaderboardPeriod)
        : undefined,
    );
  }

  @Get(':period/me')
  async me(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('period') period: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const safe = PERIODS.includes(period as LeaderboardPeriod)
      ? (period as LeaderboardPeriod)
      : 'all_time';
    return this.leaderboardService.getUserRank(me.id, safe);
  }

  @Get(':period')
  async one(@Param('period') period: string, @Query('limit') limit?: string) {
    const safe = PERIODS.includes(period as LeaderboardPeriod)
      ? (period as LeaderboardPeriod)
      : 'all_time';
    return this.leaderboardService.getLeaderboard(safe, limit ? Number(limit) : 50);
  }

  /** Admin: freeze a finished period so its result can be paid out later. */
  @UseGuards(AdminGuard)
  @Post('snapshot')
  async snapshot(
    @Body() body: { period: LeaderboardPeriod; periodStart: string; periodEnd: string },
  ) {
    const safe = PERIODS.includes(body.period) ? body.period : 'weekly';
    return this.leaderboardService.snapshot(
      safe,
      new Date(body.periodStart),
      new Date(body.periodEnd),
    );
  }
}
