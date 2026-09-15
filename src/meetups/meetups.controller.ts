import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { MeetupsService } from './meetups.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { scheduleMeetupSchema, ScheduleMeetupDto, rateMeetupSchema, RateMeetupDto } from './meetups.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('meetups')
export class MeetupsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly meetupsService: MeetupsService,
  ) {}

  @Post()
  async schedule(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(scheduleMeetupSchema)) body: ScheduleMeetupDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.meetupsService.schedule(me.id, body.otherUserId, body.scheduledAt, body.location);
  }

  @Get()
  async list(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.meetupsService.listForUser(me.id);
  }

  @Post(':id/confirm')
  async confirm(@CurrentUser() firebaseUser: { uid: string }, @Param('id', ParseUUIDPipe) id: string) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.meetupsService.updateStatus(id, me.id, 'confirmed');
  }

  @Post(':id/complete')
  async complete(@CurrentUser() firebaseUser: { uid: string }, @Param('id', ParseUUIDPipe) id: string) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.meetupsService.updateStatus(id, me.id, 'completed');
  }

  @Post(':id/cancel')
  async cancel(@CurrentUser() firebaseUser: { uid: string }, @Param('id', ParseUUIDPipe) id: string) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.meetupsService.updateStatus(id, me.id, 'cancelled');
  }

  @Post(':id/rate')
  async rate(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rateMeetupSchema)) body: RateMeetupDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.meetupsService.rate(id, me.id, body.rating, body.comment);
  }

  @Get('stats/:userId')
  async stats(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.meetupsService.getStatsForUser(userId);
  }

  @Get('ratings/:userId')
  async ratings(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.meetupsService.getRatingsForUser(userId);
  }
}
