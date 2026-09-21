import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from './users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { updateMeSchema, UpdateMeDto } from './users.dto';

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // @UseGuards runs FirebaseAuthGuard BEFORE getMe() executes. If the
  // guard throws, getMe() never runs — request.user is guaranteed to
  // exist by the time we get here.
  @UseGuards(FirebaseAuthGuard)
  @Get('me')
  async getMe(@CurrentUser() firebaseUser: { uid: string }) {
    return this.usersService.findOrCreateByFirebaseUid(firebaseUser);
  }

  /**
   * Partial profile update. Replaces the client-side
   * `updateDoc(doc(db,'users',uid), {...})` calls — the client no longer
   * needs write access to the users collection at all.
   */
  @UseGuards(FirebaseAuthGuard)
  @Patch('me')
  async updateMe(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(updateMeSchema)) body: UpdateMeDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.usersService.updateMyProfile(me.id, body);
  }

  /**
   * Public profile of another user, for the neighbour profile view.
   * Requires auth (so it can't be scraped anonymously) but not a
   * relationship — matching how the radar already lets you see people
   * near you you haven't added yet.
   *
   * Never returns latitude/longitude or email.
   */
  @UseGuards(FirebaseAuthGuard)
  @Get('users/:id')
  async getPublicProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getPublicProfile(id);
  }
}
