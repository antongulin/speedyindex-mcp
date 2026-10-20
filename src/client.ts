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

const safeNonnegativeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const nonblankString = z.string().refine((value) => value.trim().length > 0);

export const listTasksInputSchema = z
  .strictObject({
    searchEngine: z.enum(['google', 'yandex', 'bing']),
    taskType: z.enum(['indexer', 'checker']),
    page: safeNonnegativeInteger,
    filter: z.enum(['standard', 'pay_per_indexed', 'drip_feed']).optional(),
    payPerIndexed: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (input.searchEngine === 'bing' && input.taskType === 'indexer') {
      context.addIssue({
        code: 'custom',
        path: ['taskType'],
        message: 'Bing supports checker tasks only.',
      });
    }
    if (
      input.filter !== undefined &&
      (input.searchEngine !== 'google' || input.taskType !== 'indexer')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['filter'],
        message: 'Filters are supported for Google indexer tasks only.',
      });
    }
    if (
      input.payPerIndexed !== undefined &&
      (input.searchEngine !== 'google' ||
        input.taskType !== 'indexer' ||
        input.filter !== 'drip_feed')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['payPerIndexed'],
        message: 'payPerIndexed requires the Google indexer drip_feed filter.',
      });
    }
  });

const taskSummarySchema = z.strictObject({
  id: nonblankString,
  size: safeNonnegativeInteger.optional(),
  processedCount: safeNonnegativeInteger.optional(),
  indexedCount: safeNonnegativeInteger.optional(),
  title: z.string().optional(),
  isCompleted: z.boolean().optional(),
  type: z.string().optional(),
  createdAt: z.string().optional(),
  payPerIndexed: z.boolean().optional(),
  days: safeNonnegativeInteger.optional(),
  daysPassed: safeNonnegativeInteger.optional(),
  isStopped: z.boolean().optional(),
  childTaskIds: z.array(nonblankString).optional(),
});

export const listTasksResultSchema = z.strictObject({
  searchEngine: z.enum(['google', 'yandex', 'bing']),
  taskType: z.enum(['indexer', 'checker']),
  page: safeNonnegativeInteger,
  lastPage: safeNonnegativeInteger,
  tasks: z.array(taskSummarySchema).max(1000),
});

const providerTaskSchema = z
  .object({
    id: nonblankString,
    size: safeNonnegativeInteger.optional(),
    processed_count: safeNonnegativeInteger.optional(),
    indexed_count: safeNonnegativeInteger.optional(),
    title: z.string().optional(),
    is_completed: z.boolean().optional(),
    type: z.string().optional(),
    created_at: z.string().optional(),
    pay_per_indexed: z.boolean().optional(),
    days: safeNonnegativeInteger.optional(),
    days_passed: safeNonnegativeInteger.optional(),
    is_stopped: z.boolean().optional(),
    child_task_ids: z.array(nonblankString).optional(),
  })
  .transform((task) => ({
    id: task.id,
    ...(task.size === undefined ? {} : { size: task.size }),
    ...(task.processed_count === undefined
      ? {}
      : { processedCount: task.processed_count }),
    ...(task.indexed_count === undefined
      ? {}
      : { indexedCount: task.indexed_count }),
    ...(task.title === undefined ? {} : { title: task.title }),
    ...(task.is_completed === undefined
      ? {}
      : { isCompleted: task.is_completed }),
    ...(task.type === undefined ? {} : { type: task.type }),
    ...(task.created_at === undefined ? {} : { createdAt: task.created_at }),
    ...(task.pay_per_indexed === undefined
      ? {}
      : { payPerIndexed: task.pay_per_indexed }),
    ...(task.days === undefined ? {} : { days: task.days }),
    ...(task.days_passed === undefined ? {} : { daysPassed: task.days_passed }),
    ...(task.is_stopped === undefined ? {} : { isStopped: task.is_stopped }),
    ...(task.child_task_ids === undefined
      ? {}
      : { childTaskIds: task.child_task_ids }),
  }));

const taskListEnvelopeSchema = z.object({
  code: z.literal(0),
  page: safeNonnegativeInteger,
  last_page: safeNonnegativeInteger,
  result: z.array(providerTaskSchema).max(1000),
});

const accountMessages = {
  credentials: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.',
  http: 'SpeedyIndex returned an unsuccessful HTTP status.',
  provider: 'SpeedyIndex rejected the account request.',
  response: 'SpeedyIndex returned an invalid account response.',
  network: 'Could not read the SpeedyIndex account endpoint.',
  timeout: 'SpeedyIndex account request timed out.',
  cancelled: 'SpeedyIndex account request was cancelled.',
} as const;

const taskListMessages = {
  input: 'Invalid task-list request.',
  credentials: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.',
  http: 'SpeedyIndex returned an unsuccessful task-list HTTP status.',
  provider: 'SpeedyIndex rejected the task-list request.',
  response: 'SpeedyIndex returned an invalid task-list response.',
  network: 'Could not read the SpeedyIndex task-list endpoint.',
  timeout: 'SpeedyIndex task-list request timed out.',
  cancelled: 'SpeedyIndex task-list request was cancelled.',
} as const;

type RequestErrorKind =
  'http' | 'response' | 'network' | 'timeout' | 'cancelled';

class RequestError extends Error {
  constructor(readonly kind: RequestErrorKind) {
    super(kind);
    this.name = 'RequestError';
  }
}

export class AccountError extends Error {
  constructor(readonly kind: keyof typeof accountMessages) {
    super(accountMessages[kind]);
    this.name = 'AccountError';
  }
}

export class TaskListError extends Error {
  constructor(readonly kind: keyof typeof taskListMessages) {
    super(taskListMessages[kind]);
    this.name = 'TaskListError';
  }
}

const apiOrigin = 'https://api.speedyindex.com';
const accountEndpoint = `${apiOrigin}/v2/account`;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** One authenticated GET, with the shared deadline and redirect safeguards. */
async function getJson(
  fetchRequest: typeof fetch,
  key: string,
  endpoint: string,
  timeoutMs: number,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  try {
    combined.throwIfAborted();
    const response = await fetchRequest(endpoint, {
      method: 'GET',
      headers: {
        Authorization: key,
        Accept: 'application/json',
        'User-Agent': `speedyindex-mcp/${version}`,
      },
      redirect: 'error',
      signal: combined,
    });
    if (!response.ok) throw new RequestError('http');
    try {
      const body = response.body;
      if (!body) throw new RequestError('response');
      const reader = body.getReader();
      let bytes = new Uint8Array(Math.min(maxResponseBytes, 1024));
      let byteLength = 0;
      try {
        while (true) {
          combined.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;

          const nextByteLength = byteLength + value.byteLength;
          if (nextByteLength > maxResponseBytes) {
            try {
              void reader.cancel().catch(() => undefined);
            } catch {
              // Preserve the fixed oversized-response error if cancellation fails.
            }
            throw new RequestError('response');
          }

          if (nextByteLength > bytes.byteLength) {
            let capacity = bytes.byteLength;
            while (capacity < nextByteLength)
              capacity = Math.min(
                maxResponseBytes,
                Math.max(capacity * 2, nextByteLength),
              );
            const expanded = new Uint8Array(capacity);
            expanded.set(bytes.subarray(0, byteLength));
            bytes = expanded;
          }
          bytes.set(value, byteLength);
          byteLength = nextByteLength;
        }

        return JSON.parse(
          new TextDecoder().decode(bytes.subarray(0, byteLength)),
        ) as unknown;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Releasing the reader must not replace the request's result or error.
        }
      }
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (signal?.aborted) throw new RequestError('cancelled');
      if (deadline.signal.aborted) throw new RequestError('timeout');
      throw new RequestError('response');
    }
  } catch (error) {
    if (signal?.aborted) throw new RequestError('cancelled');
    if (deadline.signal.aborted) throw new RequestError('timeout');
    if (error instanceof RequestError) throw error;
    // Never reflect fetch exceptions, provider messages, bodies, or credentials.
    throw new RequestError('network');
  } finally {
    clearTimeout(timer);
    // Release an unread HTTP error body as well as any completed request.
    deadline.abort();
  }
}

/** One GET, no redirects or retries. The fetch seam supports isolated tests. */
export class SpeedyIndexClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchAccount: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly maxResponseBytes = MAX_RESPONSE_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes <= 0 ||
      maxResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new RangeError(
        'maxResponseBytes must be a positive integer no greater than 16 MiB.',
      );
    }
  }

  async getBalance(signal?: AbortSignal) {
    const key = this.apiKey?.trim();
    if (!key) throw new AccountError('credentials');
    try {
      const body = await getJson(
        this.fetchAccount,
        key,
        accountEndpoint,
        this.timeoutMs,
        this.maxResponseBytes,
        signal,
      );
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
      if (error instanceof AccountError) throw error;
      if (error instanceof RequestError) throw new AccountError(error.kind);
      // Preserve the account endpoint's fixed network error for unexpected failures.
      throw new AccountError('network');
    }
  }

  async listTasks(input: unknown, signal?: AbortSignal) {
    const parsedInput = listTasksInputSchema.safeParse(input);
    if (!parsedInput.success) throw new TaskListError('input');
    const args = parsedInput.data;
    const key = this.apiKey?.trim();
    if (!key) throw new TaskListError('credentials');

    const endpoint = new URL(
      `/v2/task/${args.searchEngine}/${args.taskType}/list/${args.page}`,
      apiOrigin,
    );
    if (args.filter !== undefined)
      endpoint.searchParams.set('filter', args.filter);
    if (args.payPerIndexed !== undefined)
      endpoint.searchParams.set('pay_per_indexed', String(args.payPerIndexed));

    try {
      const body = await getJson(
        this.fetchAccount,
        key,
        endpoint.toString(),
        this.timeoutMs,
        this.maxResponseBytes,
        signal,
      );
      const envelope = z.object({ code: z.number() }).safeParse(body);
      if (!envelope.success) throw new TaskListError('response');
      if (envelope.data.code !== 0) throw new TaskListError('provider');
      const response = taskListEnvelopeSchema.safeParse(body);
      if (!response.success || response.data.page !== args.page)
        throw new TaskListError('response');
      if (
        response.data.result.length > 0 &&
        response.data.last_page < args.page
      )
        throw new TaskListError('response');
      return listTasksResultSchema.parse({
        searchEngine: args.searchEngine,
        taskType: args.taskType,
        page: args.page,
        lastPage: response.data.last_page,
        tasks: response.data.result,
      });
    } catch (error) {
      if (signal?.aborted) throw new TaskListError('cancelled');
      if (error instanceof TaskListError) throw error;
      if (error instanceof RequestError) throw new TaskListError(error.kind);
      // Never reflect provider validation details or response data.
      throw new TaskListError('response');
    }
  }
}
