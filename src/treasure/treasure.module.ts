import { Module } from '@nestjs/common';
import { TreasureController } from './treasure.controller';
import { TreasureService } from './treasure.service';
import { UsersModule } from '../users/users.module';
import { LedgerModule } from '../ledger/ledger.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [UsersModule, LedgerModule, NotificationsModule],
  controllers: [TreasureController],
  providers: [TreasureService],
  exports: [TreasureService],
})
export class TreasureModule {}
