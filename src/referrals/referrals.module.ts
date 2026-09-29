import { Module } from '@nestjs/common';
import { ReferralsController, ReferralPublicController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { UsersModule } from '../users/users.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MilestonesModule } from '../milestones/milestones.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [UsersModule, LedgerModule, MilestonesModule, NotificationsModule],
  controllers: [ReferralsController, ReferralPublicController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
