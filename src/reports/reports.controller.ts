import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ReportsService } from './reports.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { createReportSchema, CreateReportDto } from './reports.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly reportsService: ReportsService,
  ) {}

  @Post()
  async create(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(createReportSchema)) body: CreateReportDto,
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    return this.reportsService.create(me.id, body.reportedUserId, body.reason);
  }
}
