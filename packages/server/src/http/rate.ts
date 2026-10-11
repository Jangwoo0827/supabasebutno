import { tooManyRequests } from '../core/errors.js';
import type { RateLimiter } from '../core/rate-limit.js';

/** Throws 429 if the key is already at its limit (does not record anything). */
export function ensureAllowed(limiter: RateLimiter, key: string): void {
  if (!limiter.allowed(key)) throw tooManyRequests(limiter.retryAfterSeconds(key));
}

/** Records an attempt; throws 429 once the limit is exceeded. */
export function countAttempt(limiter: RateLimiter, key: string): void {
  if (!limiter.hit(key)) throw tooManyRequests(limiter.retryAfterSeconds(key));
}
