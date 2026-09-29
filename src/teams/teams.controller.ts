import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TeamsService } from './teams.service';
import { createTeamSchema, CreateTeamDto, joinTeamSchema, JoinTeamDto } from './teams.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('teams')
export class TeamsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly teamsService: TeamsService,
  ) {}

  @Get()
  async list() {
    return this.teamsService.listTeams();
  }

  @Get('mine')
  async mine(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.teamsService.myTeam(me.id);
  }

  @Post()
  async create(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(createTeamSchema)) body: CreateTeamDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const team = await this.teamsService.createTeam(me.id, body.name);
    return { success: true, team, message: `Squad "${team.name}" created. Invite code: ${team.code}` };
  }

  @Post('join')
  async join(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(joinTeamSchema)) body: JoinTeamDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const team = await this.teamsService.joinTeam(me.id, body.code);
    return { success: true, team, message: `Joined squad "${team.name}".` };
  }

  @Post('leave')
  async leave(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const result = await this.teamsService.leaveTeam(me.id);
    return { ...result, message: 'You have left the squad.' };
  }
}
