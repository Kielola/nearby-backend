import { Module } from '@nestjs/common';
import { PostsService } from './posts.service';
import { HighlightsService } from './highlights.service';
import { ContentController } from './content.controller';
import { UsersModule } from '../users/users.module';
import { FriendsModule } from '../friends/friends.module';

@Module({
  imports: [UsersModule, FriendsModule],
  controllers: [ContentController],
  providers: [PostsService, HighlightsService],
})
export class ContentModule {}
