import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

// @Controller('') means every route in this class is prefixed with
// nothing — so @Get('health') below becomes GET /health
@Controller()
export class AppController {
  // Nest sees AppService in the constructor and automatically creates
  // (or reuses) an instance and hands it to us. This is "dependency
  // injection" — you never write `new AppService()` yourself.
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return this.appService.getHealthStatus();
  }
}
