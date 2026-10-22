import { z } from 'zod';
import { version } from '../package.json';
import { ReadBudgetError, type InvocationReadBudget } from './read-budget';
import {
  normalizeTaskReport,
  TaskReportError,
  taskReportInputSchema,
} from './task-report';
import {
  normalizeTaskStatusResult,
  TaskStatusError,
  taskStatusInputSchema,
  type TaskFamily,
} from './task-status';

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
const taskStatusRoutes: Record<TaskFamily, string> = {
  'google/indexer': '/v2/task/google/indexer/status',
  'google/checker': '/v2/task/google/checker/status',
  'yandex/indexer': '/v2/task/yandex/indexer/status',
  'yandex/checker': '/v2/task/yandex/checker/status',
  'bing/checker': '/v2/task/bing/checker/status',
  'backlink/checker': '/v2/task/backlink/checker/status',
};
const taskReportRoutes: Record<TaskFamily, string> = {
  'google/indexer': '/v2/task/google/indexer/report',
  'google/checker': '/v2/task/google/checker/report',
  'yandex/indexer': '/v2/task/yandex/indexer/report',
  'yandex/checker': '/v2/task/yandex/checker/report',
  'bing/checker': '/v2/task/bing/checker/report',
  'backlink/checker': '/v2/task/backlink/checker/report',
};

type JsonRequestOptions = {
  method: 'GET' | 'POST';
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  body?: string;
};

/** One authenticated GET or POST, with shared deadline and redirect safeguards. */
async function requestJson(
  fetchRequest: typeof fetch,
  key: string,
  endpoint: string,
  options: JsonRequestOptions,
): Promise<unknown> {
  const { method, timeoutMs, maxResponseBytes, signal, body } = options;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  try {
    combined.throwIfAborted();
    const response = await fetchRequest(endpoint, {
      method,
      headers: {
        Authorization: key,
        Accept: 'application/json',
        'User-Agent': `speedyindex-mcp/${version}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: combined,
      ...(body === undefined ? {} : { body }),
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

type Receipt<T> = { ok: true; value: T } | { ok: false; error: unknown };
function observe<T>(operation: Promise<T>): Promise<Receipt<T>> {
  return operation.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/** Opt-in settlement boundary, including synchronous normalization/checkpoints. */
async function requestBudgetedJson<T>(
  fetchRequest: typeof fetch,
  key: string,
  endpoint: string,
  options: JsonRequestOptions,
  budget: InvocationReadBudget,
  normalize: (body: unknown) => T,
): Promise<T> {
  let responseBody: ReadableStream<Uint8Array> | null | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed: Promise<Receipt<void>> | undefined;
  let read:
    | Promise<
        Receipt<
          Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
        >
      >
    | undefined;
  let cancellation: Promise<Receipt<void>> | undefined;
  let cancelStarted = false;
  let eof = false;
  const readErrors: unknown[] = [];
  function cancelOwned() {
    if (!responseBody || cancelStarted || eof) return;
    cancelStarted = true;
    try {
      cancellation = observe(reader ? reader.cancel() : responseBody.cancel());
    } catch (error) {
      cancellation = Promise.resolve({ ok: false, error });
    }
  }
  const lease = budget.acquire(
    options.signal,
    options.timeoutMs,
    new RequestError('timeout'),
    cancelOwned,
  );
  let result: T | undefined;
  let failure: Error | undefined;
  let stage: RequestErrorKind = 'network';
  let cleanupFailed = false;
  try {
    lease.enterFetch();
    // Entered fetches stay charged, including a synchronous transport throw.
    const response = await fetchRequest(endpoint, {
      method: options.method,
      headers: {
        Authorization: key,
        Accept: 'application/json',
        'User-Agent': `speedyindex-mcp/${version}`,
        ...(options.method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      redirect: 'error',
      signal: lease.signal,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    // Register a late response before checking an abort/deadline selected meanwhile.
    responseBody = response.body;
    lease.checkpoint();
    if (!response.ok) throw new RequestError('http');
    stage = 'response';
    if (!responseBody) throw new RequestError('response');
    reader = responseBody.getReader();
    closed = observe(reader.closed);
    let bytes = new Uint8Array(Math.min(options.maxResponseBytes, 1024));
    let byteLength = 0;
    while (true) {
      lease.checkpoint();
      read = observe(reader.read());
      const receipt = await read;
      if (!receipt.ok) {
        readErrors.push(receipt.error);
        throw new RequestError('response');
      }
      const { done, value } = receipt.value;
      // Every delivered chunk is charged BEFORE cancellation/expiry and copying.
      if (value) lease.chargeDecodedBytes(value.byteLength);
      else lease.checkpoint();
      if (done) {
        eof = true;
        break;
      }
      const nextByteLength = byteLength + value.byteLength;
      if (nextByteLength > options.maxResponseBytes)
        throw new RequestError('response');
      if (nextByteLength > bytes.byteLength) {
        const capacity = Math.min(
          options.maxResponseBytes,
          Math.max(bytes.byteLength * 2, nextByteLength),
        );
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, byteLength));
        bytes = expanded;
      }
      bytes.set(value, byteLength);
      byteLength = nextByteLength;
    }
    lease.checkpoint();
    const body: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, byteLength)),
    );
    lease.checkpoint();
    result = normalize(body);
    lease.checkpoint();
  } catch (error) {
    failure = lease.fail(
      error instanceof RequestError ||
        error instanceof ReadBudgetError ||
        error instanceof TaskListError ||
        error instanceof TaskStatusError ||
        error instanceof TaskReportError
        ? error
        : new RequestError(stage),
    );
  } finally {
    // Await actual owned receipts. Cancellation never races a surviving fetch/read.
    if (!eof || failure) cancelOwned();
    const readReceipt = await read;
    if (readReceipt && !readReceipt.ok) readErrors.push(readReceipt.error);
    const closedReceipt = await closed;
    if (closedReceipt && !closedReceipt.ok) {
      readErrors.push(closedReceipt.error);
      if (!failure) cleanupFailed = true;
    }
    const cancelReceipt = await cancellation;
    if (cancelReceipt && !cancelReceipt.ok) {
      const error = cancelReceipt.error;
      const expectedAbort =
        error instanceof Error && error.name === 'AbortError';
      if (!expectedAbort && !readErrors.includes(error)) cleanupFailed = true;
    }
    try {
      reader?.releaseLock();
    } catch {
      cleanupFailed = true;
    }
    failure = lease.finish(cleanupFailed) ?? failure;
  }
  if (failure) throw failure;
  return result!;
}

function readJson<T>(
  fetchRequest: typeof fetch,
  key: string,
  endpoint: string,
  options: JsonRequestOptions,
  budget: InvocationReadBudget | undefined,
  normalize: (body: unknown) => T,
): Promise<T> {
  if (budget)
    return requestBudgetedJson(
      fetchRequest,
      key,
      endpoint,
      options,
      budget,
      normalize,
    );
  return requestJson(fetchRequest, key, endpoint, options).then(normalize);
}

/** Trusted internal raw-entry hook; only budgeted indexer reports use it. */
export interface RetryRawReportMeter {
  chargeRawEntries(count: number): void;
}

/** One read request, no redirects or retries. The fetch seam supports tests. */
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
      const body = await requestJson(this.fetchAccount, key, accountEndpoint, {
        method: 'GET',
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
        ...(signal === undefined ? {} : { signal }),
      });
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

  async listTasks(
    input: unknown,
    signal?: AbortSignal,
    budget?: InvocationReadBudget,
  ) {
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
      return await readJson(
        this.fetchAccount,
        key,
        endpoint.toString(),
        {
          method: 'GET',
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
          ...(signal === undefined ? {} : { signal }),
        },
        budget,
        (body) => {
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
        },
      );
    } catch (error) {
      if (budget) {
        if (error instanceof ReadBudgetError || error instanceof RangeError)
          throw error;
        if (error instanceof TaskListError) throw error;
        if (error instanceof RequestError) throw new TaskListError(error.kind);
      }
      if (signal?.aborted) throw new TaskListError('cancelled');
      if (error instanceof TaskListError) throw error;
      if (error instanceof RequestError) throw new TaskListError(error.kind);
      // Never reflect provider validation details or response data.
      throw new TaskListError('response');
    }
  }

  async getTaskStatus(
    input: unknown,
    signal?: AbortSignal,
    budget?: InvocationReadBudget,
  ) {
    const parsedInput = taskStatusInputSchema.safeParse(input);
    if (!parsedInput.success) throw new TaskStatusError('input');
    const args = parsedInput.data;
    const key = this.apiKey?.trim();
    if (!key) throw new TaskStatusError('credentials');

    const requestedIds =
      args.taskId === undefined ? args.taskIds! : [args.taskId];
    const requestBody =
      args.taskId === undefined
        ? { task_ids: args.taskIds! }
        : { task_id: args.taskId };

    try {
      return await readJson(
        this.fetchAccount,
        key,
        new URL(taskStatusRoutes[args.family], apiOrigin).toString(),
        {
          method: 'POST',
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
          ...(signal === undefined ? {} : { signal }),
          body: JSON.stringify(requestBody),
        },
        budget,
        (response) =>
          normalizeTaskStatusResult(args.family, requestedIds, response),
      );
    } catch (error) {
      if (budget) {
        if (error instanceof ReadBudgetError || error instanceof RangeError)
          throw error;
        if (error instanceof TaskStatusError) throw error;
        if (error instanceof RequestError)
          throw new TaskStatusError(error.kind);
      }
      if (signal?.aborted) throw new TaskStatusError('cancelled');
      if (error instanceof TaskStatusError) throw error;
      if (error instanceof RequestError) throw new TaskStatusError(error.kind);
      throw new TaskStatusError('response');
    }
  }

  async getTaskReport(
    input: unknown,
    signal?: AbortSignal,
    budget?: InvocationReadBudget,
    reportMeter?: RetryRawReportMeter,
  ) {
    const parsedInput = taskReportInputSchema.safeParse(input);
    if (!parsedInput.success) throw new TaskReportError('input');
    const args = parsedInput.data;
    let chargeRawEntries: ((count: number) => void) | undefined;
    if (reportMeter !== undefined) {
      try {
        if (
          !budget ||
          typeof budget.checkpoint !== 'function' ||
          (args.family !== 'google/indexer' && args.family !== 'yandex/indexer')
        )
          throw new RangeError();
        const charge = reportMeter.chargeRawEntries;
        if (typeof charge !== 'function') throw new RangeError();
        chargeRawEntries = charge.bind(reportMeter);
      } catch {
        throw new RangeError('Invalid raw report meter construction.');
      }
    }
    const key = this.apiKey?.trim();
    if (!key) throw new TaskReportError('credentials');

    const isBacklink = args.family === 'backlink/checker';
    const requestBody = isBacklink
      ? { task_id: args.taskId, page: args.page, limit: args.limit }
      : { task_id: args.taskId };

    try {
      return await readJson(
        this.fetchAccount,
        key,
        new URL(taskReportRoutes[args.family], apiOrigin).toString(),
        {
          method: 'POST',
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
          ...(signal === undefined ? {} : { signal }),
          body: JSON.stringify(requestBody),
        },
        budget,
        (response) => {
          if (chargeRawEntries) {
            const result =
              response && typeof response === 'object'
                ? (response as { result?: unknown }).result
                : undefined;
            const arrays =
              result && typeof result === 'object'
                ? (result as {
                    indexed_links?: unknown;
                    unindexed_links?: unknown;
                  })
                : undefined;
            chargeRawEntries(
              (Array.isArray(arrays?.indexed_links)
                ? arrays.indexed_links.length
                : 0) +
                (Array.isArray(arrays?.unindexed_links)
                  ? arrays.unindexed_links.length
                  : 0),
            );
          }
          return normalizeTaskReport(args, response);
        },
      );
    } catch (error) {
      if (budget) {
        if (error instanceof ReadBudgetError || error instanceof RangeError)
          throw error;
        if (error instanceof TaskReportError) throw error;
        if (error instanceof RequestError)
          throw new TaskReportError(error.kind);
      }
      if (signal?.aborted) throw new TaskReportError('cancelled');
      if (error instanceof TaskReportError) throw error;
      if (error instanceof RequestError) throw new TaskReportError(error.kind);
      throw new TaskReportError('response');
    }
  }
}
