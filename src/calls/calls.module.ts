import { Module } from '@nestjs/common';
import { CallGateway } from './call.gateway';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  providers: [CallGateway],
})
export class CallsModule {}
