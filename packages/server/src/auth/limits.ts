import { RateLimiter } from '../core/rate-limit.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * All rate limiters. "failures" limiters only count unsuccessful attempts, so honest
 * users are never throttled; "attempts" limiters count every request.
 * Layered on purpose: per-IP stops one machine, per-account+IP stops guessing against
 * one account from one machine without letting a stranger lock the real owner out, and
 * the per-account cap bounds distributed guessing.
 */
export function createLimits(now: () => number = Date.now) {
  return {
    loginIp: new RateLimiter(30, 15 * MIN, now), // failures
    loginAccountIp: new RateLimiter(5, 15 * MIN, now), // failures
    loginAccount: new RateLimiter(40, 15 * MIN, now), // failures
    refreshIp: new RateLimiter(60, 15 * MIN, now), // failures
    resetIp: new RateLimiter(10, 15 * MIN, now), // failures
    signupIp: new RateLimiter(10, HOUR, now), // attempts
    recoverIp: new RateLimiter(5, HOUR, now), // attempts
    recoverAccount: new RateLimiter(3, HOUR, now), // attempts
    adminFailIp: new RateLimiter(10, 15 * MIN, now), // failures
    uploadUser: new RateLimiter(60, 10 * MIN, now), // attempts: bounds disk churn from one signed-in user
  };
}

export type Limits = ReturnType<typeof createLimits>;
