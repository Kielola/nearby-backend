import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { NotificationsService } from './notifications.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { createNotificationSchema, CreateNotificationDto } from './notifications.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Post()
  async create(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(createNotificationSchema)) body: CreateNotificationDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.notificationsService.create(me.id, body);
  }

  @Get()
  async list(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.notificationsService.listForUser(me.id);
  }

  @Post(':id/read')
  async markRead(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.notificationsService.markRead(id, me.id);
  }

  @Post('read-all')
  async markAllRead(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.notificationsService.markAllRead(me.id);
  }

  @Post(':id/toggle-read')
  async toggleRead(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { isRead: boolean },
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.notificationsService.setRead(id, me.id, Boolean(body.isRead));
  }

  @Delete(':id')
  async delete(
    @CurrentUser() firebaseUser: { uid: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.notificationsService.delete(id, me.id);
  }

  @Delete()
  async deleteAll(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.notificationsService.deleteAll(me.id);
  }
}
