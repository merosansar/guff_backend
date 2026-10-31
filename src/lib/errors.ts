import { z } from 'zod';

/** An error whose message is safe to show to the person using the app. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, message);
export const forbidden = (message: string) => new HttpError(403, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const tooMany = (message: string) => new HttpError(429, message);

/** Turns the first validation issue into one readable sentence. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Some of the details are not valid.';
  const field = issue.path.filter((p) => typeof p === 'string').join('.');
  // Our schemas carry their own messages; zod's defaults get the field name in front.
  return issue.message.includes(' ') && /^[A-Z]/.test(issue.message)
    ? issue.message
    : `${field || 'Value'}: ${issue.message}`;
}

/** Parses or throws a 400 with a readable message. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest(describeZodError(result.error));
  return result.data;
}

/** MongoDB duplicate key error (E11000). */
export function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}
