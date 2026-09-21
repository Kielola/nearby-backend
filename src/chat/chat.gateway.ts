import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { getFirebaseAuth } from '../auth/firebase-admin';
import { ChatService } from './chat.service';
import { UsersService } from '../users/users.service';
import { socketCorsOrigins } from '../common/socket-cors';

const joinConversationSchema = z.object({ conversationId: z.string().uuid() });

// Typing notifications are ephemeral (never persisted) and deliberately
// tiny — a conversation id and nothing else. The server injects the
// sender's identity, so a client can't claim to be someone else.
const typingSchema = z.object({
  conversationId: z.string().uuid(),
  isTyping: z.boolean(),
});
const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().min(1).max(5000).optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(['image', 'video', 'voice', 'document']).optional(),
  audioDurationSec: z.number().optional(),
  fileName: z.string().optional(),
  fileSize: z.string().optional(),
}).refine((d) => d.content || d.mediaUrl, {
  message: 'Message must have content or media',
});

@WebSocketGateway({ cors: { origin: socketCorsOrigins(), credentials: true } })
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;
  constructor(
    private readonly chatService: ChatService,
    private readonly usersService: UsersService,
  ) {}

  // Sockets don't go through Nest's HTTP guards, so we verify the
  // Firebase token manually the moment a socket connects — same idea
  // as FirebaseAuthGuard, just a different transport.
  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('no token');

      const decoded = await getFirebaseAuth().verifyIdToken(token);
      const dbUser = await this.usersService.findOrCreateByFirebaseUid({
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
      });

      client.data.userId = dbUser.id; // our Postgres user id, not the firebase uid
    } catch {
      client.disconnect();
    }
  }

  @SubscribeMessage('join_conversation')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: unknown,
  ) {
    const parsed = joinConversationSchema.safeParse(rawData);
    if (!parsed.success) return;
    const data = parsed.data;

    const allowed = await this.chatService.isParticipant(
      data.conversationId,
      client.data.userId,
    );
    if (!allowed) return; // silently refuse — don't leak conversation existence

    client.join(data.conversationId); // Socket.IO "room" = one conversation
  }

  /**
   * Typing indicator. Replaces the old Firestore `presence` document
   * write, which every client subscribed to. Only participants of the
   * conversation receive the event, and the sender is taken from the
   * authenticated socket rather than the payload.
   */
  @SubscribeMessage('typing')
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: unknown,
  ) {
    const parsed = typingSchema.safeParse(rawData);
    if (!parsed.success) return;
    const { conversationId, isTyping } = parsed.data;

    const allowed = await this.chatService.isParticipant(
      conversationId,
      client.data.userId,
    );
    if (!allowed) return;

    client.to(conversationId).emit('typing', {
      conversationId,
      userId: client.data.userId,
      isTyping,
    });
  }

  @SubscribeMessage('send_message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: unknown,
  ) {
    const parsed = sendMessageSchema.safeParse(rawData);
    if (!parsed.success) return;
    const data = parsed.data;

    const allowed = await this.chatService.isParticipant(
      data.conversationId,
      client.data.userId,
    );
    if (!allowed) return;

    const message = await this.chatService.sendMessage(
      data.conversationId,
      client.data.userId,
      {
        content: data.content,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        audioDurationSec: data.audioDurationSec,
        fileName: data.fileName,
        fileSize: data.fileSize,
      },
    );

    // Broadcast to every socket in the room, including the sender —
    // this is what fixes "one-sided delivery": both participants get
    // the same event from the same source of truth, no per-client
    // Firestore listener race.
    this.server.to(data.conversationId).emit('new_message', message);
  }
}
