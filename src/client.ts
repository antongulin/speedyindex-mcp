import { z } from 'zod';
import { version } from '../package.json';

export const balanceSchema = z.object({
  tokens: z.number().nonnegative(),
  indexer: z.number().nonnegative(),
  checker: z.number().nonnegative(),
});
export const balanceResultSchema = z.object({
  balance: balanceSchema,
  observedAt: z.iso.datetime(),
});
const accountSchema = z.object({ code: z.literal(0), balance: balanceSchema });

const messages = {
  credentials: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.',
  http: 'SpeedyIndex returned an unsuccessful HTTP status.',
  provider: 'SpeedyIndex rejected the account request.',
  response: 'SpeedyIndex returned an invalid account response.',
  network: 'Could not read the SpeedyIndex account endpoint.',
  timeout: 'SpeedyIndex account request timed out.',
  cancelled: 'SpeedyIndex account request was cancelled.',
} as const;

export class AccountError extends Error {
  constructor(readonly kind: keyof typeof messages) {
    super(messages[kind]);
    this.name = 'AccountError';
  }
}

/** One GET, no redirects or retries. The fetch seam supports isolated tests. */
export class SpeedyIndexClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchAccount: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async getBalance(signal?: AbortSignal) {
    const key = this.apiKey?.trim();
    if (!key) throw new AccountError('credentials');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const combined = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;
    try {
      combined.throwIfAborted();
      const response = await this.fetchAccount(
        'https://api.speedyindex.com/v2/account',
        {
          method: 'GET',
          headers: {
            Authorization: key,
            Accept: 'application/json',
            'User-Agent': `speedyindex-mcp/${version}`,
          },
          redirect: 'error',
          signal: combined,
        },
      );
      if (!response.ok) throw new AccountError('http');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AccountError('response');
      }
      const envelope = z.object({ code: z.number() }).safeParse(body);
      if (!envelope.success) throw new AccountError('response');
      if (envelope.data.code !== 0) throw new AccountError('provider');
      const account = accountSchema.safeParse(body);
      if (!account.success) throw new AccountError('response');
      return balanceResultSchema.parse({
        balance: account.data.balance,
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (signal?.aborted) throw new AccountError('cancelled');
      if (deadline.signal.aborted) throw new AccountError('timeout');
      if (error instanceof AccountError) throw error;
      // Never reflect fetch exceptions, provider messages, bodies, or credentials.
      throw new AccountError('network');
    } finally {
      clearTimeout(timer);
      // Release an unread HTTP error body as well as any completed request.
      deadline.abort();
    }
  }
}
