import { Types } from 'mongoose';
import { z } from 'zod';

export const objectIdString = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'That ID is not valid.')
  .transform((s) => s.toLowerCase());

export const toId = (value: string | Types.ObjectId): Types.ObjectId =>
  typeof value === 'string' ? new Types.ObjectId(value) : value;

export const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

/** The time an ObjectId was created, as an ISO string. */
export const idTime = (id: Types.ObjectId): string => id.getTimestamp().toISOString();
