/**
 * @file validate.middleware.ts
 * Request body / query / params validation using Zod schemas.
 *
 * Usage:
 *   router.post('/orders', validate(createOrderSchema), handler)
 *
 * On failure: returns 400 with an array of human-readable field errors.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

type ValidateTarget = 'body' | 'query' | 'params';

/**
 * Returns an Express middleware that validates `req[target]` against `schema`.
 * On success, replaces `req[target]` with the parsed (and coerced) value.
 */
export function validate(schema: ZodSchema, target: ValidateTarget = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const errors = formatZodErrors(result.error);
      res.status(400).json({ success: false, message: 'Validation failed', errors });
      return;
    }

    // Replace with the parsed/coerced output
    (req as Record<string, unknown>)[target] = result.data;
    next();
  };
}

function formatZodErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
}
