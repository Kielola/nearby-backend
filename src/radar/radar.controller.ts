import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RadarService } from './radar.service';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { updateLocationSchema, UpdateLocationDto, nearbyQuerySchema, NearbyQueryDto } from './radar.dto';
import { setVisibilitySchema, SetVisibilityDto } from './radar-visibility.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('radar')
export class RadarController {
  constructor(
    private readonly radarService: RadarService,
    private readonly usersService: UsersService,
  ) {}

  @Post('location')
  async updateLocation(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(updateLocationSchema)) body: UpdateLocationDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    await this.radarService.updateLocation(me.id, body.latitude, body.longitude);
    return { ok: true };
  }

  @Post('visibility')
  async setVisibility(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(setVisibilitySchema)) body: SetVisibilityDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.radarService.setVisibility(
      me.id,
      body.isVisibleOnRadar,
      body.radarVisibilityMode,
    );
  }

  // radiusKm used to be read straight off the query string and multiplied
  // by 1000 with no validation. That meant:
  //   /radar/nearby?radiusKm=999999  -> every user in the database, in one
  //                                    response (a free enumeration endpoint)
  //   /radar/nearby?radiusKm=abc     -> NaN, which Postgres happily compares
  //                                    as "distance <= NaN" == true
  // The schema below rejects both before they reach the service. The
  // service also clamps as a second line of defence.
  @Get('nearby')
  async getNearby(
    @CurrentUser() firebaseUser: { uid: string },
    @Query(new ZodValidationPipe(nearbyQuerySchema)) query: NearbyQueryDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.radarService.findNearby(me.id, query.radiusKm * 1000);
  }
}
