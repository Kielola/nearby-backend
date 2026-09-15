import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { getFirebaseAuth } from '../auth/firebase-admin';
import { UsersService } from '../users/users.service';

// IMPORTANT: this gateway only relays the WebRTC "handshake" (SDP
// offer/answer + ICE candidates). Actual audio/video bytes never touch
// our server — they flow peer-to-peer between the two phones once the
// handshake completes. For calls across strict NATs/mobile networks
// you'll also need a TURN server (e.g. self-hosted coturn, or a
// service like Twilio/Metered) — that's infra config, not code here.
@WebSocketGateway({ namespace: 'calls', cors: { origin: '*' } })
export class CallGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  // In-memory map of userId -> socketId. Fine for a single server
  // instance. If you ever run multiple backend instances behind a load
  // balancer, this needs to move to Redis (the ioredis client we
  // already have) so every instance can look up where a user is
  // connected, not just the instance that happens to hold this map.
  private onlineUsers = new Map<string, string>();

  constructor(private readonly usersService: UsersService) {}

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

      client.data.userId = dbUser.id;
      this.onlineUsers.set(dbUser.id, client.id);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data.userId) {
      this.onlineUsers.delete(client.data.userId);
    }
  }

  @SubscribeMessage('call:invite')
  handleInvite(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { calleeId: string; offer: unknown; type: 'audio' | 'video' },
  ) {
    const calleeSocketId = this.onlineUsers.get(data.calleeId);
    if (!calleeSocketId) {
      client.emit('call:unavailable', { calleeId: data.calleeId });
      return;
    }
    this.server.to(calleeSocketId).emit('call:incoming', {
      callerId: client.data.userId,
      offer: data.offer,
      type: data.type,
    });
  }

  @SubscribeMessage('call:answer')
  handleAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callerId: string; answer: unknown },
  ) {
    const callerSocketId = this.onlineUsers.get(data.callerId);
    if (callerSocketId) {
      this.server.to(callerSocketId).emit('call:answered', {
        calleeId: client.data.userId,
        answer: data.answer,
      });
    }
  }

  @SubscribeMessage('call:ice-candidate')
  handleIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId: string; candidate: unknown },
  ) {
    const targetSocketId = this.onlineUsers.get(data.targetUserId);
    if (targetSocketId) {
      this.server.to(targetSocketId).emit('call:ice-candidate', {
        fromUserId: client.data.userId,
        candidate: data.candidate,
      });
    }
  }

  @SubscribeMessage('call:end')
  handleEnd(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId: string },
  ) {
    const targetSocketId = this.onlineUsers.get(data.targetUserId);
    if (targetSocketId) {
      this.server.to(targetSocketId).emit('call:ended', {
        fromUserId: client.data.userId,
      });
    }
  }
}
