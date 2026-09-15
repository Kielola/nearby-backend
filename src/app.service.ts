import { Injectable } from '@nestjs/common';

// @Injectable() marks this class as something Nest's DI container is
// allowed to create and inject elsewhere. Without this decorator,
// Nest would refuse to wire it into AppController.
@Injectable()
export class AppService {
  getHealthStatus() {
    return {
      status: 'ok',
      service: 'nearby-backend',
      timestamp: new Date().toISOString(),
    };
  }
}
