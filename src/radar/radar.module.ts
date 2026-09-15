import { Module } from '@nestjs/common';
import { RadarService } from './radar.service';
import { RadarController } from './radar.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [RadarController],
  providers: [RadarService],
})
export class RadarModule {}
