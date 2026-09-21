import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AiService, myAiChatSchema, MyAiChatDto, icebreakerSchema, IcebreakerDto } from './ai.service';

/**
 * AI routes.
 *
 * Note the two things the old Express versions did not have:
 *   - @UseGuards(FirebaseAuthGuard): only signed-in users of YOUR app can
 *     call these. The Express server was open — anyone who found the URL
 *     could spend your Gemini quota.
 *   - @Throttle: a per-IP cap so one client can't loop these endpoints.
 */
@UseGuards(FirebaseAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('my-ai-chat')
  async myAiChat(
    @Body(new ZodValidationPipe(myAiChatSchema)) body: MyAiChatDto,
  ) {
    return this.aiService.myAiChat(body);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('icebreaker')
  async icebreakers(
    @Body(new ZodValidationPipe(icebreakerSchema)) body: IcebreakerDto,
  ) {
    return this.aiService.icebreakers(body);
  }
}
