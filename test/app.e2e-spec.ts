import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/global-exception.filter';

describe('Nearby backend (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
      });
  });

  it('GET /me with no token is rejected', () => {
    return request(app.getHttpServer())
      .get('/me')
      .expect(401)
      .expect((res) => {
        expect(res.body.message.message).toBe('Missing bearer token');
      });
  });

  it('POST /radar/location with no token is rejected before validation runs', () => {
    return request(app.getHttpServer())
      .post('/radar/location')
      .send({ latitude: 999, longitude: 4.5 }) // invalid, but auth should fail first
      .expect(401);
  });

  it('GET /friends/requests with no token is rejected', () => {
    return request(app.getHttpServer()).get('/friends/requests').expect(401);
  });
});
