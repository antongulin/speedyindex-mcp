import { z } from 'zod';
import { taskFamilySchema, type TaskFamily } from './task-status';

const safeNonnegativeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const nonblankString = z.string().refine((value) => value.trim().length > 0);
const finiteNonnegativeNumber = z
  .number()
  .refine((value) => Number.isFinite(value) && value >= 0);

const genericTaskFamilySchema = taskFamilySchema.exclude(['backlink/checker']);

export const taskReportInputSchema = z.discriminatedUnion('family', [
  z.strictObject({
    family: genericTaskFamilySchema,
    taskId: nonblankString,
  }),
  z.strictObject({
    family: z.literal('backlink/checker'),
    taskId: nonblankString,
    page: safeNonnegativeInteger.default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
]);

export type TaskReportInput = z.infer<typeof taskReportInputSchema>;

const linksReportSchema = z.strictObject({
  family: genericTaskFamilySchema,
  reportKind: z.literal('links'),
  taskId: nonblankString,
  size: safeNonnegativeInteger,
  processedCount: safeNonnegativeInteger,
  indexedLinks: z.array(z.string()),
  unindexedLinks: z.array(z.string()),
  type: z.string(),
  title: z.string(),
  createdAt: z.string(),
  indexedCount: safeNonnegativeInteger.optional(),
  isCompleted: z.boolean().optional(),
  status: z.string().optional(),
  checkAfter: z.string().optional(),
  payPerIndexed: z.boolean().optional(),
  tokensCharged: finiteNonnegativeNumber.optional(),
  tokensRefunded: finiteNonnegativeNumber.optional(),
  dripFeed: z.boolean().optional(),
  days: safeNonnegativeInteger.optional(),
  daysPassed: safeNonnegativeInteger.optional(),
  isStopped: z.boolean().optional(),
  awaitingResult: z.boolean().optional(),
  childTaskIds: z.array(nonblankString).optional(),
});

const backlinkReportSchema = z.strictObject({
  family: z.literal('backlink/checker'),
  reportKind: z.literal('backlink'),
  taskId: nonblankString,
  size: safeNonnegativeInteger,
  processedCount: safeNonnegativeInteger,
  page: safeNonnegativeInteger,
  lastPage: safeNonnegativeInteger,
  donors: z.array(z.record(z.string(), z.json())),
  isCompleted: z.boolean().optional(),
});

export const taskReportOutputSchema = z.discriminatedUnion('reportKind', [
  linksReportSchema,
  backlinkReportSchema,
]);

export type TaskReport = z.infer<typeof taskReportOutputSchema>;

const providerCodeSchema = z.object({ code: z.number() });
const providerEnvelopeSchema = z.object({
  code: z.number(),
  result: z.unknown(),
});

const providerLinksSchema = z.object({
  id: nonblankString,
  size: safeNonnegativeInteger,
  processed_count: safeNonnegativeInteger,
  indexed_links: z.array(z.string()),
  unindexed_links: z.array(z.string()),
  type: z.string(),
  title: z.string(),
  created_at: z.string(),
  indexed_count: safeNonnegativeInteger.optional(),
  is_completed: z.boolean().optional(),
  status: z.string().optional(),
  check_after: z.string().optional(),
  pay_per_indexed: z.boolean().optional(),
  tokens_charged: finiteNonnegativeNumber.optional(),
  tokens_refunded: finiteNonnegativeNumber.optional(),
  drip_feed: z.boolean().optional(),
  days: safeNonnegativeInteger.optional(),
  days_passed: safeNonnegativeInteger.optional(),
  is_stopped: z.boolean().optional(),
  awaiting_result: z.boolean().optional(),
  child_task_ids: z.array(nonblankString).optional(),
});

const providerBacklinkSchema = z.object({
  id: nonblankString,
  size: safeNonnegativeInteger,
  processed_count: safeNonnegativeInteger,
  donors: z.array(z.record(z.string(), z.json())),
  page: safeNonnegativeInteger,
  last_page: safeNonnegativeInteger,
  is_completed: z.boolean().optional(),
});

const taskReportMessages = {
  input: 'Invalid task-report request.',
  credentials: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.',
  http: 'SpeedyIndex returned an unsuccessful task-report HTTP status.',
  provider: 'SpeedyIndex rejected the task-report request.',
  response: 'SpeedyIndex returned an invalid task-report response.',
  network: 'Could not read the SpeedyIndex task-report endpoint.',
  timeout: 'SpeedyIndex task-report request timed out.',
  cancelled: 'SpeedyIndex task-report request was cancelled.',
} as const;

export class TaskReportError extends Error {
  constructor(readonly kind: keyof typeof taskReportMessages) {
    super(taskReportMessages[kind]);
    this.name = 'TaskReportError';
  }
}

function mapLinksReport(
  family: Exclude<TaskFamily, 'backlink/checker'>,
  taskId: string,
  result: z.infer<typeof providerLinksSchema>,
): TaskReport {
  return taskReportOutputSchema.parse({
    family,
    reportKind: 'links',
    taskId,
    size: result.size,
    processedCount: result.processed_count,
    indexedLinks: result.indexed_links,
    unindexedLinks: result.unindexed_links,
    type: result.type,
    title: result.title,
    createdAt: result.created_at,
    ...(result.indexed_count === undefined
      ? {}
      : { indexedCount: result.indexed_count }),
    ...(result.is_completed === undefined
      ? {}
      : { isCompleted: result.is_completed }),
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.check_after === undefined
      ? {}
      : { checkAfter: result.check_after }),
    ...(result.pay_per_indexed === undefined
      ? {}
      : { payPerIndexed: result.pay_per_indexed }),
    ...(result.tokens_charged === undefined
      ? {}
      : { tokensCharged: result.tokens_charged }),
    ...(result.tokens_refunded === undefined
      ? {}
      : { tokensRefunded: result.tokens_refunded }),
    ...(result.drip_feed === undefined ? {} : { dripFeed: result.drip_feed }),
    ...(result.days === undefined ? {} : { days: result.days }),
    ...(result.days_passed === undefined
      ? {}
      : { daysPassed: result.days_passed }),
    ...(result.is_stopped === undefined
      ? {}
      : { isStopped: result.is_stopped }),
    ...(result.awaiting_result === undefined
      ? {}
      : { awaitingResult: result.awaiting_result }),
    ...(result.child_task_ids === undefined
      ? {}
      : { childTaskIds: result.child_task_ids }),
  });
}

export function normalizeTaskReport(
  input: TaskReportInput,
  response: unknown,
): TaskReport {
  const code = providerCodeSchema.safeParse(response);
  if (!code.success) throw new TaskReportError('response');
  if (code.data.code !== 0) throw new TaskReportError('provider');

  const envelope = providerEnvelopeSchema.safeParse(response);
  if (!envelope.success) throw new TaskReportError('response');

  if (input.family === 'backlink/checker') {
    const report = providerBacklinkSchema.safeParse(envelope.data.result);
    if (
      !report.success ||
      report.data.id !== input.taskId ||
      report.data.page !== input.page ||
      report.data.donors.length > input.limit ||
      report.data.donors.length > 100 ||
      (report.data.donors.length > 0 &&
        report.data.page > report.data.last_page)
    ) {
      throw new TaskReportError('response');
    }
    return taskReportOutputSchema.parse({
      family: input.family,
      reportKind: 'backlink',
      taskId: input.taskId,
      size: report.data.size,
      processedCount: report.data.processed_count,
      page: report.data.page,
      lastPage: report.data.last_page,
      donors: report.data.donors,
      ...(report.data.is_completed === undefined
        ? {}
        : { isCompleted: report.data.is_completed }),
    });
  }

  const report = providerLinksSchema.safeParse(envelope.data.result);
  if (!report.success || report.data.id !== input.taskId)
    throw new TaskReportError('response');
  return mapLinksReport(input.family, input.taskId, report.data);
}
