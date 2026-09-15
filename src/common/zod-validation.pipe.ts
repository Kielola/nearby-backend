import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { ZodSchema } from 'zod';

// Wrap any Zod schema with this and drop it on a @Body()/@Query()
// param. Garbage input never reaches your service/DB layer — it gets
// rejected here with a clear 400 instead of blowing up as a confusing
// Postgres constraint error three layers down.
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.flatten());
    }
    return result.data;
  }
}
