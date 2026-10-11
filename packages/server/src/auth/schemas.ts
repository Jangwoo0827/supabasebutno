import { z } from 'zod';

/** Trimmed, lower-cased, syntactically valid e-mail (max 254 chars, the SMTP limit). */
export const emailSchema = z
  .string()
  .max(254)
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.email());

/**
 * Min 8 characters. Max 128 characters / 256 bytes so that a huge "password" cannot be
 * used to burn CPU in argon2. No composition rules: length matters more (NIST 800-63B).
 */
export const passwordSchema = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(128, 'must be at most 128 characters')
  .refine((p) => Buffer.byteLength(p) <= 256, 'is too long');

const metadata = z.record(z.string().max(64), z.unknown());

export const signUpSchema = z.strictObject({ email: emailSchema, password: passwordSchema, data: metadata.optional() });
export const signInSchema = z.strictObject({ email: emailSchema, password: z.string().min(1).max(256) });
export const refreshSchema = z.strictObject({ refresh_token: z.string().min(20).max(200) });
export const logoutSchema = z.strictObject({ scope: z.enum(['local', 'global']).default('local') });
export const updateUserSchema = z
  .strictObject({ data: metadata.optional(), password: passwordSchema.optional(), current_password: z.string().max(256).optional() })
  .refine((v) => v.data !== undefined || v.password !== undefined, 'provide data and/or password');
export const recoverSchema = z.strictObject({ email: emailSchema });
export const resetSchema = z.strictObject({ token: z.string().min(20).max(200), password: passwordSchema });
