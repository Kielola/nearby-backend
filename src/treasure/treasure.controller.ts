import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TreasureService } from './treasure.service';
import {
  redeemTreasureSchema,
  RedeemTreasureDto,
  setTreasureLocationSchema,
  SetTreasureLocationDto,
} from './treasure.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('treasure')
export class TreasureController {
  constructor(
    private readonly usersService: UsersService,
    private readonly treasureService: TreasureService,
  ) {}

  @Get()
  async list() {
    return this.treasureService.list();
  }

  @Post('redeem')
  async redeem(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(redeemTreasureSchema)) body: RedeemTreasureDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const location =
      body.latitude !== undefined && body.longitude !== undefined
        ? { latitude: body.latitude, longitude: body.longitude }
        : undefined;
    return this.treasureService.redeem(me.id, body.code, location);
  }

  /** Admin: pin a code to a place so it starts requiring proximity. */
  @UseGuards(AdminGuard)
  @Post(':id/location')
  async setLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setTreasureLocationSchema)) body: SetTreasureLocationDto,
  ) {
    return this.treasureService.setLocation(id, body.latitude, body.longitude, body.radiusMeters);
  }
}
