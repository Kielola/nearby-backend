import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ChatService } from './chat.service';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { startConversationSchema, StartConversationDto } from './chat.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly usersService: UsersService,
  ) {}

  @Get('conversations')
  async listConversations(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.chatService.listConversationsForUser(me.id);
  }

  @Post('conversations/:id/read')
  async markRead(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) conversationId: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.chatService.markConversationRead(conversationId, me.id);
  }

  @Post('conversations')
  async startConversation(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(startConversationSchema)) body: StartConversationDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.chatService.getOrCreateDirectConversation(me.id, body.otherUserId);
  }

  @Get('conversations/:id/messages')
  async getMessages(@Param('id', ParseUUIDPipe) conversationId: string) {
    return this.chatService.listMessages(conversationId);
  }
}
