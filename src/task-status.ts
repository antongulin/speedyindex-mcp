import { z } from 'zod';

const safeNonnegativeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const nonblankString = z.string().refine((value) => value.trim().length > 0);
const finiteNonnegativeNumber = z
  .number()
  .refine((value) => Number.isFinite(value) && value >= 0);

export const taskFamilySchema = z.enum([
  'google/indexer',
  'google/checker',
  'yandex/indexer',
  'yandex/checker',
  'bing/checker',
  'backlink/checker',
]);

export type TaskFamily = z.infer<typeof taskFamilySchema>;

export const taskStatusInputSchema = z
  .strictObject({
    family: taskFamilySchema,
    taskId: nonblankString.optional(),
    taskIds: z.array(nonblankString).min(1).max(1000).optional(),
  })
  .superRefine((input, context) => {
    const hasTaskId = input.taskId !== undefined;
    const hasTaskIds = input.taskIds !== undefined;
    if (hasTaskId === hasTaskIds) {
      context.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'Provide exactly one of taskId or taskIds.',
      });
    }
    if (hasTaskIds) {
      const seen = new Set<string>();
      for (const [index, taskId] of input.taskIds!.entries()) {
        if (seen.has(taskId)) {
          context.addIssue({
            code: 'custom',
            path: ['taskIds', index],
            message: 'taskIds must contain unique IDs.',
          });
        }
        seen.add(taskId);
      }
    }
  });

const commonTaskFields = {
  id: nonblankString,
  size: safeNonnegativeInteger.optional(),
  processedCount: safeNonnegativeInteger.optional(),
  indexedCount: safeNonnegativeInteger.optional(),
  isCompleted: z.boolean().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  createdAt: z.string().optional(),
  status: z.string().optional(),
  payPerIndexed: z.boolean().optional(),
  tokensCharged: finiteNonnegativeNumber.optional(),
  tokensRefunded: finiteNonnegativeNumber.optional(),
  checkAfter: z.string().optional(),
};

const taskStatusChildSchema = z.strictObject({
  ...commonTaskFields,
  day: safeNonnegativeInteger.optional(),
});

export const taskStatusTaskSchema = z.strictObject({
  ...commonTaskFields,
  days: safeNonnegativeInteger.optional(),
  daysPassed: safeNonnegativeInteger.optional(),
  isStopped: z.boolean().optional(),
  dripFeed: z.boolean().optional(),
  awaitingResult: z.boolean().optional(),
  childTaskIds: z.array(nonblankString).optional(),
  children: z.array(taskStatusChildSchema).optional(),
  targetDomains: z.array(z.string()).optional(),
});

export const taskStatusResultSchema = z.strictObject({
  family: taskFamilySchema,
  requestedIds: z.array(nonblankString).min(1).max(1000),
  tasks: z.array(taskStatusTaskSchema).max(1000),
  unreturnedIds: z.array(nonblankString).max(1000),
});

const providerCommonTaskSchema = z.object({
  id: nonblankString,
  size: safeNonnegativeInteger.optional(),
  processed_count: safeNonnegativeInteger.optional(),
  indexed_count: safeNonnegativeInteger.optional(),
  is_completed: z.boolean().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  created_at: z.string().optional(),
  status: z.string().optional(),
  pay_per_indexed: z.boolean().optional(),
  tokens_charged: finiteNonnegativeNumber.optional(),
  tokens_refunded: finiteNonnegativeNumber.optional(),
  check_after: z.string().optional(),
});

type ProviderCommonTask = z.infer<typeof providerCommonTaskSchema>;

function mapCommonTask(task: ProviderCommonTask) {
  return {
    id: task.id,
    ...(task.size === undefined ? {} : { size: task.size }),
    ...(task.processed_count === undefined
      ? {}
      : { processedCount: task.processed_count }),
    ...(task.indexed_count === undefined
      ? {}
      : { indexedCount: task.indexed_count }),
    ...(task.is_completed === undefined
      ? {}
      : { isCompleted: task.is_completed }),
    ...(task.title === undefined ? {} : { title: task.title }),
    ...(task.type === undefined ? {} : { type: task.type }),
    ...(task.created_at === undefined ? {} : { createdAt: task.created_at }),
    ...(task.status === undefined ? {} : { status: task.status }),
    ...(task.pay_per_indexed === undefined
      ? {}
      : { payPerIndexed: task.pay_per_indexed }),
    ...(task.tokens_charged === undefined
      ? {}
      : { tokensCharged: task.tokens_charged }),
    ...(task.tokens_refunded === undefined
      ? {}
      : { tokensRefunded: task.tokens_refunded }),
    ...(task.check_after === undefined ? {} : { checkAfter: task.check_after }),
  };
}

const providerChildSchema = z
  .object({
    ...providerCommonTaskSchema.shape,
    day: safeNonnegativeInteger.optional(),
  })
  .transform(({ day, ...task }) => ({
    ...mapCommonTask(task),
    ...(day === undefined ? {} : { day }),
  }));

const providerTaskSchema = z
  .object({
    ...providerCommonTaskSchema.shape,
    days: safeNonnegativeInteger.optional(),
    days_passed: safeNonnegativeInteger.optional(),
    is_stopped: z.boolean().optional(),
    drip_feed: z.boolean().optional(),
    awaiting_result: z.boolean().optional(),
    child_task_ids: z.array(nonblankString).optional(),
    children: z.array(providerChildSchema).optional(),
    target_domains: z.array(z.string()).optional(),
  })
  .transform((task) => ({
    ...mapCommonTask(task),
    ...(task.days === undefined ? {} : { days: task.days }),
    ...(task.days_passed === undefined ? {} : { daysPassed: task.days_passed }),
    ...(task.is_stopped === undefined ? {} : { isStopped: task.is_stopped }),
    ...(task.drip_feed === undefined ? {} : { dripFeed: task.drip_feed }),
    ...(task.awaiting_result === undefined
      ? {}
      : { awaitingResult: task.awaiting_result }),
    ...(task.child_task_ids === undefined
      ? {}
      : { childTaskIds: task.child_task_ids }),
    ...(task.children === undefined ? {} : { children: task.children }),
    ...(task.target_domains === undefined
      ? {}
      : { targetDomains: task.target_domains }),
  }));

const providerResultSchema = z.union([
  providerTaskSchema,
  z.array(providerTaskSchema),
]);
const providerCodeSchema = z.object({ code: z.number() });
const providerEnvelopeSchema = z.object({ result: providerResultSchema });

const taskStatusMessages = {
  input: 'Invalid task-status request.',
  credentials: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.',
  http: 'SpeedyIndex returned an unsuccessful task-status HTTP status.',
  provider: 'SpeedyIndex rejected the task-status request.',
  response: 'SpeedyIndex returned an invalid task-status response.',
  network: 'Could not read the SpeedyIndex task-status endpoint.',
  timeout: 'SpeedyIndex task-status request timed out.',
  cancelled: 'SpeedyIndex task-status request was cancelled.',
} as const;

export class TaskStatusError extends Error {
  constructor(readonly kind: keyof typeof taskStatusMessages) {
    super(taskStatusMessages[kind]);
    this.name = 'TaskStatusError';
  }
}

export function normalizeTaskStatusResult(
  family: TaskFamily,
  requestedIds: string[],
  response: unknown,
) {
  const code = providerCodeSchema.safeParse(response);
  if (!code.success) throw new TaskStatusError('response');
  if (code.data.code !== 0) throw new TaskStatusError('provider');

  const envelope = providerEnvelopeSchema.safeParse(response);
  if (!envelope.success) throw new TaskStatusError('response');
  const returnedTasks = Array.isArray(envelope.data.result)
    ? envelope.data.result
    : [envelope.data.result];
  const requested = new Set(requestedIds);
  const tasksById = new Map<string, (typeof returnedTasks)[number]>();

  for (const task of returnedTasks) {
    if (!requested.has(task.id) || tasksById.has(task.id))
      throw new TaskStatusError('response');
    tasksById.set(task.id, task);
  }

  const tasks = requestedIds.flatMap((id) => {
    const task = tasksById.get(id);
    return task === undefined ? [] : [task];
  });
  const unreturnedIds = requestedIds.filter((id) => !tasksById.has(id));

  return taskStatusResultSchema.parse({
    family,
    requestedIds,
    tasks,
    unreturnedIds,
  });
}
