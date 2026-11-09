import { z } from 'zod';

// Helpers for request validation. Empty strings from HTML forms become null.
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const optText = z.preprocess(emptyToNull, z.string().trim().nullable().optional());
export const reqText = z.string().trim().min(1, 'Required');
export const num = z.coerce.number();
export const posNum = z.coerce.number().positive('Must be more than zero');
export const id = z.coerce.number().int().positive();
export const optDate = z.preprocess(emptyToNull, z.coerce.date().nullable().optional());

export const idParam = (value: unknown) => id.parse(value);
