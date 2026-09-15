import { Controller, Get, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from './users.service';

@Controller('me')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // @UseGuards runs FirebaseAuthGuard BEFORE getMe() executes. If the
  // guard throws, getMe() never runs — request.user is guaranteed to
  // exist by the time we get here.
  @UseGuards(FirebaseAuthGuard)
  @Get()
  async getMe(@CurrentUser() firebaseUser: { uid: string }) {
    return this.usersService.findOrCreateByFirebaseUid(firebaseUser);
  }
}
