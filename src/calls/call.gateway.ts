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
import { socketCorsOrigins } from '../common/socket-cors';

// IMPORTANT: this gateway only relays the WebRTC "handshake" (SDP
// offer/answer + ICE candidates). Actual audio/video bytes never touch
// our server — they flow peer-to-peer between the two phones once the
// handshake completes. For calls across strict NATs/mobile networks
// you'll also need a TURN server (e.g. self-hosted coturn, or a
// service like Twilio/Metered) — that's infra config, not code here.
@WebSocketGateway({ namespace: 'calls', cors: { origin: socketCorsOrigins(), credentials: true } })
export class CallGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // The `!` is required: Nest injects this after construction, so it is
  // genuinely unassigned in the constructor. Without it, TypeScript 6+ rejects
  // the file with TS2564 ("has no initializer and is not definitely assigned")
  // even though TypeScript 5.x accepted it — which means an editor running a
  // newer TypeScript than the build shows an error the build does not.
  @WebSocketServer() server!: Server;

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
      console.log(`[calls] ${dbUser.id} connected (socket ${client.id})`);
    } catch (err: any) {
      // This used to be a bare `catch { client.disconnect(); }`, which meant a
      // rejected socket left NO trace anywhere. The symptom was indistinguishable
      // from the other person simply not answering: the caller got
      // 'call:unavailable', and nothing in the logs explained why the callee was
      // missing from `onlineUsers`.
      //
      // The usual causes, in order of likelihood:
      //   1. the ID token is from a different Firebase project than
      //      FIREBASE_PROJECT_ID on this service — verifyIdToken rejects it
      //   2. FIREBASE_PRIVATE_KEY is malformed (the \n escapes are the usual
      //      culprit when pasted into a dashboard)
      //   3. the token genuinely expired
      const reason = err?.code || err?.errorInfo?.code || err?.message || 'unknown';
      console.error(
        `[calls] socket ${client.id} rejected: ${reason}` +
          (reason === 'auth/argument-error' || /project/i.test(String(reason))
            ? ' — check FIREBASE_PROJECT_ID and FIREBASE_PRIVATE_KEY on this service'
            : ''),
      );
      // Tell the client before dropping it, so the app can say something true
      // rather than silently losing the ability to receive calls. The delay
      // gives the packet a chance to flush — disconnect() would otherwise cut
      // the connection before it is written.
      client.emit('auth:error', { reason: String(reason) });
      setTimeout(() => client.disconnect(), 250);
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
