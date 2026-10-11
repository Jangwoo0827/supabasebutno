import WebSocket from 'ws';

type Message = Record<string, any>;

/** WebSocket test client that queues every message so tests can wait for (or rule out) specific ones. */
export class TestSocket {
  readonly messages: Message[] = [];
  private waiters: (() => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  isClosed = false;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code, reason) => {
        this.isClosed = true;
        this.waiters.splice(0).forEach((w) => w());
        resolve({ code, reason: reason.toString() });
      }),
    );
    ws.on('error', () => undefined);
  }

  /** Connects and waits for the socket to open. Rejects with the HTTP status if the upgrade is refused. */
  static connect(url: string, opts: { origin?: string; maxPayload?: number } = {}): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin: opts.origin, maxPayload: opts.maxPayload });
      const sock = new TestSocket(ws);
      ws.once('open', () => resolve(sock));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', (e) => reject(e));
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  sendBinary(data: Buffer): void {
    this.ws.send(data, { binary: true });
  }

  /** Resolves with (and removes) the first queued message matching `match`, waiting up to `timeoutMs`. */
  async next(match: (m: Message) => boolean = () => true, timeoutMs = 2000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.messages.findIndex(match);
      if (i >= 0) return this.messages.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0 || this.isClosed) throw new Error(`no matching message (queued: ${JSON.stringify(this.messages)})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Next event for a subscription (skips unrelated messages). */
  event(subscription?: string, timeoutMs?: number): Promise<Message> {
    return this.next((m) => m.type === 'event' && (subscription === undefined || m.subscription === subscription), timeoutMs);
  }

  /** Asserts that no event arrives within `ms` (use after the publish queue has been flushed). */
  async expectNoEvent(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const stray = this.messages.filter((m) => m.type === 'event');
    if (stray.length) throw new Error(`unexpected event(s): ${JSON.stringify(stray)}`);
  }

  async waitClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    return Promise.race([this.closed, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('socket did not close')), timeoutMs))]);
  }

  close(): void {
    this.ws.close();
  }
}
