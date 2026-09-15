import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { PresenceService } from './presence.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { presenceStatusSchema, PresenceStatusDto } from './presence.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('presence')
export class PresenceController {
  constructor(
    private readonly usersService: UsersService,
    private readonly presenceService: PresenceService,
  ) {}

  // Call this periodically (e.g. every 30-60s) while the app is in the
  // foreground — that's what keeps the TTL from expiring.
  @Post('heartbeat')
  async heartbeat(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.presenceService.heartbeat(me.id);
  }

  @Delete()
  async goOffline(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.presenceService.goOffline(me.id);
  }

  // Batch check — pass every user id currently visible (radar list, chat
  // list) and get back who's online in one call.
  @Post('status')
  async getStatus(
    @Body(new ZodValidationPipe(presenceStatusSchema)) body: PresenceStatusDto,
  ) {
    return this.presenceService.getStatusForUsers(body.userIds);
  }
}
