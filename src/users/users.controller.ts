import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from './users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { acceptTermsSchema, AcceptTermsDto, updateMeSchema, UpdateMeDto } from './users.dto';

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
   * Record acceptance of the Terms of Service.
   *
   * Deliberately a separate endpoint from PATCH /me rather than another field
   * on the profile DTO. Accepting terms is a distinct legal act, and keeping it
   * on its own route means a bug in the generic profile-update path can never
   * silently overwrite the acceptance record — the thing that has to hold up if
   * it is ever relied upon.
   *
   * The client sends only the version it displayed; the timestamp is the
   * server's, so it cannot be backdated.
   */
  @UseGuards(FirebaseAuthGuard)
  @Post('me/terms-acceptance')
  async acceptTerms(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(acceptTermsSchema)) body: AcceptTermsDto,
    @Req() request: Request,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);

    // Hashed, not raw: proving provenance without retaining an address.
    const forwarded = request.headers['x-forwarded-for'];
    const rawIp =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ||
      request.ip ||
      '';
    const ipHash = rawIp
      ? createHash('sha256').update(rawIp).digest('hex')
      : null;

    return this.usersService.acceptTerms(me.id, body.version, ipHash);
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
