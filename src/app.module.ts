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
import { ReferralsModule } from './referrals/referrals.module';
import { LedgerModule } from './ledger/ledger.module';
import { MilestonesModule } from './milestones/milestones.module';
import { TeamsModule } from './teams/teams.module';
import { TreasureModule } from './treasure/treasure.module';
import { PayoutsModule } from './payouts/payouts.module';
import { InfluencersModule } from './influencers/influencers.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { StatsModule } from './stats/stats.module';
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
    // Referral programme — phased rebuild of the standalone referral app on the
    // main backend, so it shares one identity and one notifications inbox.
    LedgerModule,
    ReferralsModule,
    MilestonesModule,
    TeamsModule,
    TreasureModule,
    PayoutsModule,
    InfluencersModule,
    LeaderboardModule,
    StatsModule,
    AiModule,
  ],
  controllers: [AppController], // handles incoming HTTP routes
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // applies rate limiting to every route
  ],
})
export class AppModule {}
