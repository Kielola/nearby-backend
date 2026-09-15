import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { PostsService } from './posts.service';
import { HighlightsService } from './highlights.service';
import { UsersService } from '../users/users.service';
import { FriendsService } from '../friends/friends.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createPostSchema,
  CreatePostDto,
  createHighlightSchema,
  CreateHighlightDto,
} from './content.dto';

@UseGuards(FirebaseAuthGuard)
@Controller()
export class ContentController {
  constructor(
    private readonly postsService: PostsService,
    private readonly highlightsService: HighlightsService,
    private readonly usersService: UsersService,
    private readonly friendsService: FriendsService,
  ) {}

  @Post('posts')
  async createPost(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(createPostSchema)) body: CreatePostDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.postsService.create(me.id, body);
  }

  @Get('posts/feed')
  async feed(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const friends = await this.friendsService.listFriends(me.id);
    const ids = [me.id, ...friends.map((f) => f.id)];
    return this.postsService.feedForUsers(ids);
  }

  @Get('posts/user/:userId')
  async userPosts(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.postsService.forUser(userId);
  }

  @Delete('posts/:id')
  async deletePost(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.postsService.delete(id, me.id);
  }

  @Post('highlights')
  async createHighlight(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(createHighlightSchema)) body: CreateHighlightDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.highlightsService.create(me.id, body);
  }

  @Get('highlights/user/:userId')
  async userHighlights(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.highlightsService.forUser(userId);
  }

  @Delete('highlights/:id')
  async deleteHighlight(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.highlightsService.delete(id, me.id);
  }
}
