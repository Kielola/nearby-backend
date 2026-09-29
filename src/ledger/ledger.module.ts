import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [LedgerController],
  providers: [LedgerService],
  // Exported because every earning path in the programme — milestones, treasure,
  // payouts, leaderboard prizes, influencer commission — credits through it.
  exports: [LedgerService],
})
export class LedgerModule {}
