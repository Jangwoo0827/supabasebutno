import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (hashes first so length differences don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
