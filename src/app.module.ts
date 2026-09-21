import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RedisModule } from './redis/redis.module';
import { JobsModule } from './jobs/jobs.module';
import { ChatModule } from './chat/chat.module';
import { RadarModule } from './radar/radar.module';
import { FriendsModule } from './friends/friends.module';
import { MediaModule } from './media/media.module';
import { ContentModule } from './content/content.module';
import { CallsModule } from './calls/calls.module';
import { PresenceModule } from './presence/presence.module';
import { ReportsModule } from './reports/reports.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MeetupsModule } from './meetups/meetups.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    // Loads .env into process.env once, globally, so every module can
    // read config without each file calling dotenv itself.
    ConfigModule.forRoot({ isGlobal: true }),
    // 100 requests per 60s per IP by default — generous for normal
    // usage, enough to stop a broken client or scraper from hammering
    // the API. Individual routes can override this with @Throttle().
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    DatabaseModule,
    RedisModule,
    JobsModule,
    AuthModule,
    UsersModule,
    ChatModule,
    RadarModule,
    FriendsModule,
    MediaModule,
    ContentModule,
    CallsModule,
    PresenceModule,
    ReportsModule,
    NotificationsModule,
    MeetupsModule,
    AiModule,
  ],
  controllers: [AppController], // handles incoming HTTP routes
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // applies rate limiting to every route
  ],
})
export class AppModule {}
