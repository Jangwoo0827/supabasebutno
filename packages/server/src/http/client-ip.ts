import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/**
 * Picks the client address from an X-Forwarded-For value and the socket address.
 *
 * With `hops` = 0 the socket address is used and X-Forwarded-For is ignored entirely
 * (so it cannot be spoofed). With `hops` = N the server is assumed to sit behind N
 * trusted proxies, each appending the address it saw: the client is the N-th entry
 * from the RIGHT. Entries further left are attacker-controlled and never trusted.
 */
export function pickClientIp(forwardedFor: string | undefined, socketAddress: string | undefined, hops: number): string {
  if (hops > 0) {
    const parts = (forwardedFor ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = parts[parts.length - hops];
    if (ip) return ip;
  }
  return socketAddress ?? 'unknown';
}

/** The client address used for rate limiting. */
export function clientIp(c: Context, hops: number): string {
  let socket: string | undefined;
  try {
    socket = getConnInfo(c).remote.address;
  } catch {
    /* no socket (e.g. app.request() in tests) */
  }
  return pickClientIp(c.req.header('x-forwarded-for'), socket, hops);
}
