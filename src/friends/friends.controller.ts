import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { FriendsService } from './friends.service';
import { UsersService } from '../users/users.service';

@UseGuards(FirebaseAuthGuard)
@Controller('friends')
export class FriendsController {
  constructor(
    private readonly friendsService: FriendsService,
    private readonly usersService: UsersService,
  ) {}

  @Post('request/:receiverId')
  async sendRequest(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('receiverId', ParseUUIDPipe) receiverId: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.friendsService.sendRequest(me.id, receiverId);
  }

  @Post(':requestId/accept')
  async accept(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.friendsService.respondToRequest(requestId, me.id, true);
  }

  @Post(':requestId/decline')
  async decline(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.friendsService.respondToRequest(requestId, me.id, false);
  }

  @Delete(':userId')
  async unfriend(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('userId', ParseUUIDPipe) otherUserId: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.friendsService.unfriend(me.id, otherUserId);
  }

  @Get('requests')
  async requests(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.friendsService.listIncomingRequests(me.id);
  }

  @Get('requests/sent')
  async sentRequests(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.friendsService.listSentRequests(me.id);
  }

  @Get()
  async list(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.friendsService.listFriends(me.id);
  }
}
