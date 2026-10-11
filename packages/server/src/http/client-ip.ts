import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/**
 * The client address used for rate limiting.
 *
 * With `hops` = 0 the socket address is used and X-Forwarded-For is ignored entirely
 * (so it cannot be spoofed). With `hops` = N the server is assumed to sit behind N
 * trusted proxies, each appending the address it saw: the client is the N-th entry
 * from the RIGHT. Entries further left are attacker-controlled and never trusted.
 */
export function clientIp(c: Context, hops: number): string {
  if (hops > 0) {
    const parts = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = parts[parts.length - hops];
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // e.g. app.request() in tests: there is no socket
  }
}
