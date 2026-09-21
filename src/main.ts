import 'reflect-metadata';
import * as Sentry from '@sentry/node';

// Sentry needs to be initialized before anything else runs so it can
// catch errors during app bootstrap too, not just after the server is up.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
}

import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Locked down to real frontend origins from env instead of '*'.
  // FRONTEND_URL can be a comma-separated list for web + any preview URLs.
  const allowedOrigins = process.env.FRONTEND_URL?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

  // `origin: true` reflects whatever Origin the caller sends, combined
  // with credentials: true that means *any* website can call this API
  // with a logged-in user's cookies/token. Tolerable locally, not in
  // production — so refuse to start rather than silently ship it.
  if (allowedOrigins.length === 0 && process.env.NODE_ENV === 'production') {
    throw new Error(
      'FRONTEND_URL must be set in production (comma-separated list of allowed origins).',
    );
  }

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true, // allow-all is dev-only
    credentials: true,
  });

  app.useGlobalFilters(new GlobalExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('Nearby API')
    .setDescription('Backend API for the Nearby app')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID Token' })
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document); // browse to /docs

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Nearby backend listening on port ${port}`);
}

bootstrap();
