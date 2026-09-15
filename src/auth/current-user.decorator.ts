import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

// This is what lets you write `@CurrentUser() user: ...` as a controller
// method parameter instead of `@Req() req` + manually reaching into
// req.user every single time. Purely a convenience/readability layer —
// the guard already did the real security work.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user;
  },
);
