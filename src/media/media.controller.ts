import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { MediaService } from './media.service';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { setProfilePictureSchema, SetProfilePictureDto } from './media.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly usersService: UsersService,
  ) {}

  // Frontend calls this FIRST, gets a signature, then uploads the
  // actual file straight to Cloudinary's API using it.
  @Get('upload-signature')
  getSignature(@Query('folder') folder = 'nearby/uploads') {
    return this.mediaService.generateUploadSignature(folder);
  }

  // After a successful direct upload, the frontend calls this with the
  // resulting secure_url to persist it as the profile picture.
  @Post('profile-picture')
  async setProfilePicture(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(setProfilePictureSchema)) body: SetProfilePictureDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.usersService.updateAvatarUrl(me.id, body.url);
  }
}
