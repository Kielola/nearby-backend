import 'reflect-metadata';
import * as Sentry from '@sentry/node';

// Sentry needs to be initialized before anything else runs so it can
// catch errors during app bootstrap too, not just after the server is up.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
}

import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/global-exception.filter';

async function bootstrap() {
  // bodyParser is disabled here so the limit can be set explicitly below.
  // Nest's default is Express's default: 100 kb. Anything larger was rejected
  // with a 413 `PayloadTooLargeError` that surfaced in the logs as nothing more
  // than "request entity too large" — no route, no user, no hint of what sent
  // it.
  //
  // The payload that hit it was ~195 kb: a profile photo. When a Cloudinary
  // upload fails, `uploadToStorage` falls back to returning the image as a
  // base64 data URL, and that string is then sent to `PATCH /users/me` as
  // `avatarUrl`. At 100 kb that is a guaranteed 413, so the photo silently
  // failed to save — the user saw it on their own screen (it was still in local
  // state) and nowhere else.
  //
  // 12 mb comfortably covers a base64 JPEG after client-side compression, which
  // is the largest thing this API is legitimately sent. File uploads proper go
  // to Cloudinary from the browser, not through here.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '12mb' }));
  app.use(urlencoded({ extended: true, limit: '12mb' }));

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
