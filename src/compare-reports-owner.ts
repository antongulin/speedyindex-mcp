/** Internal read owner; construction grants no paid, history or public-tool authority. */
import { SpeedyIndexClient } from './client';
import {
  CompareReportsFault,
  compareProjectedReports,
  compareReportsBlocked,
  compareReportsBlockerCodeSchema,
  compareReportsError,
  compareReportsErrorCodeSchema,
  compareReportsInputSchema,
  compareReportsToolResult,
  projectCompareBacklinkPage,
  projectCompareLinksReport,
  projectCompareStatus,
  type CompareBacklinkProjection,
  type CompareLinksProjection,
  type CompareReportProjection,
  type CompareReportsToolResult,
  type CompareStatusProjection,
  type CompareWorkRootsObserver,
} from './compare-reports';
import { createCompareOwnerRootBytes } from './compare-reports-measurements';
import {
  createInvocationReadBudget,
  ReadBudgetError,
  type ReadBudgetRuntime,
} from './read-budget';
import { TaskReportError } from './task-report';
import { TaskStatusError } from './task-status';

type BudgetLimits = NonNullable<
  Parameters<typeof createInvocationReadBudget>[1]
>['limits'];
export type CompareOwnerPhase =
  | 'before_status0'
  | 'after_status0'
  | 'after_report_a'
  | 'after_status1'
  | 'after_report_b'
  | 'after_status2'
  | 'after_comparison'
  | 'after_serialization'
  | 'before_close'
  | 'after_close';
export interface CompareOwnerLimits {
  maxReads: number;
  requestBytes: number;
  genericPerTask: number;
  genericTotal: number;
  donorsPerTask: number;
  donorsTotal: number;
  targetsPerDonor: number;
  targetsPerTask: number;
  targetsTotal: number;
  retainedBytes: number;
  resultBytes: number;
}
const ceilings: Readonly<CompareOwnerLimits> = Object.freeze({
  maxReads: 63,
  requestBytes: 65_536,
  genericPerTask: 10_000,
  genericTotal: 40_000,
  donorsPerTask: 1_500,
  donorsTotal: 6_000,
  targetsPerDonor: 1_000,
  targetsPerTask: 10_000,
  targetsTotal: 40_000,
  retainedBytes: 8_388_608,
  resultBytes: 2_097_152,
});
const budgetCeilings = {
  maxAttempts: 64,
  maxDecodedBytes: 33_554_432,
  horizonMs: 60_000,
  maxRequestMs: 10_000,
};
function lowerLimits<T extends Record<keyof T, number>>(
  base: T,
  lower?: Partial<T>,
): Readonly<T> {
  if (lower && Object.keys(lower).some((key) => !Object.hasOwn(base, key)))
    throw new RangeError('Invalid comparison limits.');
  const result = { ...base, ...lower };
  for (const key of Object.keys(base) as (keyof T)[])
    if (
      !Number.isSafeInteger(result[key]) ||
      result[key] <= 0 ||
      result[key] > base[key]
    )
      throw new RangeError('Invalid comparison limits.');
  return Object.freeze(result);
}
type BlockerCode = (typeof compareReportsBlockerCodeSchema.options)[number];
type ErrorCode = (typeof compareReportsErrorCodeSchema.options)[number];
type Phase = 'status' | 'report' | 'fence';
type Cause = 'http' | 'provider' | 'response' | 'network' | 'timeout';
type Failure = Readonly<{
  code: BlockerCode | ErrorCode;
  phase?: Phase;
  cause?: Cause;
}>;
const key = (failure: Failure, cleanup = false) =>
  `${failure.code}/${failure.phase ?? ''}/${failure.cause ?? ''}/${cleanup ? 'failed' : ''}`;
function fail(code: BlockerCode | ErrorCode): never {
  throw new CompareReportsFault(code);
}
function classify(error: unknown, phase: Phase): Failure {
  if (error instanceof CompareReportsFault) return { code: error.code };
  if (error instanceof ReadBudgetError)
    return {
      code: error.code === 'ReadInProgress' ? 'InternalError' : error.code,
    };
  if (error instanceof TaskStatusError || error instanceof TaskReportError) {
    if (error.kind === 'input') return { code: 'InvalidInput' };
    if (error.kind === 'credentials') return { code: 'MissingCredentials' };
    if (error.kind === 'cancelled') return { code: 'Cancelled' };
    return { code: 'ReadFailed', phase, cause: error.kind };
  }
  return { code: 'InternalError' };
}
/** Typed equality only; no serialization/digest or opaque provider-object equality. */
function equalValue(a: unknown, b: unknown, checkpoint: () => void): boolean {
  checkpoint();
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((item, index) => equalValue(item, b[index], checkpoint))
    );
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = a as Record<string, unknown>,
      right = b as Record<string, unknown>;
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every(
        (name) =>
          Object.hasOwn(right, name) &&
          equalValue(left[name], right[name], checkpoint),
      )
    );
  }
  return false;
}
interface ReportWrapper {
  readonly projection: CompareReportProjection;
  readonly donorRawTargetCounts: readonly (number | null)[] | null;
}
type StatusPair = [CompareStatusProjection, CompareStatusProjection];
type ReportSlot = 'beforeA' | 'afterA' | 'currentB';

export interface CompareReportsOwner {
  compare(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CompareReportsToolResult>;
}

export function createCompareReportsOwner(
  client: SpeedyIndexClient,
  construction: Readonly<{
    limits?: Partial<CompareOwnerLimits>;
    budgetLimits?: BudgetLimits;
    runtime?: ReadBudgetRuntime;
    onPhase?: (phase: CompareOwnerPhase) => void;
  }> = {},
): Readonly<CompareReportsOwner> {
  const getStatus = client.getTaskStatus.bind(client),
    getReport = client.getTaskReport.bind(client);
  const limits = lowerLimits(ceilings, construction.limits);
  const budgetLimits = lowerLimits(budgetCeilings, construction.budgetLimits);
  const runtime = construction.runtime;
  if (
    runtime &&
    (typeof runtime.now !== 'function' ||
      typeof runtime.setTimeout !== 'function' ||
      typeof runtime.clearTimeout !== 'function')
  )
    throw new RangeError('Invalid comparison runtime.');
  const now = runtime
    ? runtime.now.bind(runtime)
    : performance.now.bind(performance);
  const nativeArm = globalThis.setTimeout.bind(globalThis),
    nativeDisarm = globalThis.clearTimeout.bind(globalThis),
    nativeImmediate = globalThis.setImmediate.bind(globalThis);
  const arm = runtime
    ? runtime.setTimeout.bind(runtime)
    : (callback: () => void, delay: number) => nativeArm(callback, delay);
  const disarm = runtime
    ? runtime.clearTimeout.bind(runtime)
    : (handle: unknown) =>
        nativeDisarm(handle as ReturnType<typeof setTimeout>);
  const onPhase = construction.onPhase;
  if (onPhase !== undefined && typeof onPhase !== 'function')
    throw new RangeError('Invalid comparison observer.');

  // Post-close publication selects only these finite, prevalidated frozen values.
  const fixed = new Map<string, CompareReportsToolResult>();
  let fixedMaximum = 0;
  const store = (failure: Failure, cleanup: boolean) => {
    const blocked = compareReportsBlockerCodeSchema.safeParse(failure.code);
    const value = blocked.success
      ? compareReportsBlocked(blocked.data, cleanup ? 'failed' : undefined)
      : compareReportsError(compareReportsErrorCodeSchema.parse(failure.code), {
          ...(failure.phase === undefined ? {} : { phase: failure.phase }),
          ...(failure.cause === undefined ? {} : { cause: failure.cause }),
          ...(cleanup ? { cleanup: 'failed' as const } : {}),
        });
    const envelope = compareReportsToolResult(value);
    fixedMaximum = Math.max(
      fixedMaximum,
      Buffer.byteLength(JSON.stringify(envelope), 'utf8'),
    );
    fixed.set(key(failure, cleanup), envelope);
  };
  for (const code of [
    ...compareReportsBlockerCodeSchema.options,
    ...compareReportsErrorCodeSchema.options,
  ]) {
    for (const cleanup of [false, true]) {
      store({ code }, cleanup);
      if (code === 'ReadFailed')
        for (const phase of ['status', 'report', 'fence'] as const)
          for (const cause of [
            'http',
            'provider',
            'response',
            'network',
            'timeout',
          ] as const)
            store({ code, phase, cause }, cleanup);
    }
  }
  if (limits.resultBytes < fixedMaximum)
    throw new RangeError('Invalid comparison result limit.');
  const select = (failure: Failure, cleanup = false) =>
    fixed.get(key(failure, cleanup))!;

  return Object.freeze<CompareReportsOwner>({
    async compare(input, signal) {
      let startedAtMs: number;
      try {
        startedAtMs = now();
      } catch {
        return select({ code: 'DeadlineExceeded' });
      }
      if (!Number.isFinite(startedAtMs))
        return select({ code: 'DeadlineExceeded' });
      const clock = {
        startedAtMs,
        lastNow: startedAtMs,
        deadlineFailed: false,
        horizonMs: budgetLimits.horizonMs,
        signal,
      };
      const trackedNow = () => {
        let value: number;
        try {
          value = now();
        } catch {
          value = Number.NaN;
        }
        if (
          !Number.isFinite(value) ||
          value < clock.lastNow ||
          value - clock.startedAtMs >= clock.horizonMs
        )
          clock.deadlineFailed = true;
        else clock.lastNow = value;
        return value;
      };
      const budget = createInvocationReadBudget(
        { startedAtMs, ...(signal === undefined ? {} : { signal }) },
        {
          limits: budgetLimits,
          runtime: { now: trackedNow, setTimeout: arm, clearTimeout: disarm },
        },
      );
      const budgetCheckpoint = budget.checkpoint.bind(budget),
        close = budget.close.bind(budget);
      const checkpoint = () => {
        budgetCheckpoint();
        if (clock.signal?.aborted) fail('Cancelled');
        if (clock.deadlineFailed) fail('DeadlineExceeded');
      };
      let baseline: StatusPair | null, fence: StatusPair | null;
      const beforeA: ReportWrapper[] = [],
        afterA: ReportWrapper[] = [];
      let currentB: ReportWrapper[] = [];
      const rootBytes = createCompareOwnerRootBytes();
      const observeWork: CompareWorkRootsObserver = (roots, completedOwned) => {
        checkpoint();
        const bytes = rootBytes.bytes(roots);
        checkpoint();
        if (bytes > limits.retainedBytes) fail('ResourceLimitExceeded');
        if (completedOwned)
          rootBytes.certifyOwned(
            completedOwned,
            (certificationRoots) =>
              observeWork([...roots, ...certificationRoots]),
            checkpoint,
          );
      };
      const phase = (value: CompareOwnerPhase) => {
        onPhase?.(value);
        checkpoint();
      };
      let primary: Failure | undefined,
        pending: CompareReportsToolResult | undefined;
      let activePhase: Phase = 'status',
        cleanupFailed = false;
      let reads = 0,
        genericTotal = 0,
        donorsTotal = 0,
        targetsTotal = 0;
      const preRead = async () => {
        checkpoint();
        if (reads > 0)
          await new Promise<void>((resolve) => {
            nativeArm(() => nativeImmediate(resolve), 0);
          });
        checkpoint();
      };
      const pages: [number | null, number | null] = [null, null];
      const reserve = () => {
        if (3 + 2 * ((pages[0] ?? 1) + (pages[1] ?? 1)) > limits.maxReads)
          fail('ResourceLimitExceeded');
      };
      const admit = (body: unknown) => {
        checkpoint();
        reserve();
        if (
          reads >= limits.maxReads ||
          Buffer.byteLength(JSON.stringify(body), 'utf8') > limits.requestBytes
        )
          fail('ResourceLimitExceeded');
        reads++;
      };
      try {
        checkpoint();
        const parsed = compareReportsInputSchema.safeParse(input);
        if (!parsed.success) fail('InvalidInput');
        const args = parsed.data;
        const statusPair = async (): Promise<StatusPair> => {
          await preRead();
          admit({ task_ids: [args.beforeTaskId, args.afterTaskId] });
          const raw = await getStatus(
            {
              family: args.family,
              taskIds: [args.beforeTaskId, args.afterTaskId],
            },
            signal,
            budget,
          );
          checkpoint();
          const pair: CompareStatusProjection[] = [];
          for (const id of [args.beforeTaskId, args.afterTaskId]) {
            const status = projectCompareStatus(
              raw.tasks.find((task) => task.id === id),
              {
                checkpoint,
                observeWork: (roots, completedOwned) =>
                  observeWork(
                    pair.length ? [pair, ...roots] : roots,
                    completedOwned,
                  ),
              },
            );
            pair.push(status);
            observeWork([pair]);
          }
          const result: StatusPair = [pair[0]!, pair[1]!];
          Object.freeze(result);
          observeWork([pair, result], result);
          return result;
        };
        const scope = (pair: StatusPair) => {
          if (
            pair.some(
              (status) => status.type !== null && status.type !== args.family,
            )
          )
            fail('IncompatibleTaskType');
          if (args.family === 'backlink/checker') {
            if (!pair[0].targetDomains || !pair[1].targetDomains)
              fail('TargetScopeUnavailable');
            if (
              !equalValue(
                pair[0].targetDomains,
                pair[1].targetDomains,
                checkpoint,
              )
            )
              fail('IncompatibleTargetScope');
          }
        };
        const readTask = async (
          index: 0 | 1,
          pass: 'a' | 'b',
          slot: ReportSlot,
        ) => {
          const destination =
            slot === 'beforeA'
              ? beforeA
              : slot === 'afterA'
                ? afterA
                : currentB;
          const taskId = index === 0 ? args.beforeTaskId : args.afterTaskId;
          let lastPage = 0,
            donors = 0,
            targets = 0;
          for (let page = 0; page <= lastPage; page++) {
            activePhase = pass === 'a' ? 'report' : 'fence';
            {
              const body =
                args.family === 'backlink/checker'
                  ? { task_id: taskId, page, limit: 100 }
                  : { task_id: taskId };
              await preRead();
              admit(body);
              const raw = await getReport(
                args.family === 'backlink/checker'
                  ? { family: args.family, taskId, page, limit: 100 }
                  : { family: args.family, taskId },
                signal,
                budget,
              );
              checkpoint();
              let projection: CompareReportProjection;
              let donorRawTargetCounts: (number | null)[] | null = null;
              if (raw.reportKind === 'links') {
                const count =
                  raw.indexedLinks.length + raw.unindexedLinks.length;
                genericTotal += count;
                if (
                  count > limits.genericPerTask ||
                  genericTotal > limits.genericTotal
                )
                  fail('ResourceLimitExceeded');
                projection = projectCompareLinksReport(
                  raw,
                  checkpoint,
                  observeWork,
                );
              } else {
                donors += raw.donors.length;
                donorsTotal += raw.donors.length;
                donorRawTargetCounts = [];
                for (const donor of raw.donors) {
                  checkpoint();
                  const count = Array.isArray(donor.target_links)
                    ? donor.target_links.length
                    : null;
                  donorRawTargetCounts.push(count);
                  targets += count ?? 0;
                  targetsTotal += count ?? 0;
                  if (
                    (count !== null && count > limits.targetsPerDonor) ||
                    donors > limits.donorsPerTask ||
                    donorsTotal > limits.donorsTotal ||
                    targets > limits.targetsPerTask ||
                    targetsTotal > limits.targetsTotal
                  )
                    fail('ResourceLimitExceeded');
                  observeWork([donorRawTargetCounts]);
                }
                projection = projectCompareBacklinkPage(
                  raw,
                  checkpoint,
                  (roots, completedOwned) =>
                    observeWork(
                      [donorRawTargetCounts, ...roots],
                      completedOwned,
                    ),
                );
                if (page === 0) {
                  lastPage = projection.lastPage;
                  if (pass === 'a') {
                    pages[index] = lastPage + 1;
                    reserve();
                  } else if (lastPage + 1 !== pages[index])
                    fail('EvidenceChanged');
                } else {
                  const first = destination[0]!.projection;
                  if (
                    first.reportKind !== 'backlink' ||
                    !equalValue(
                      [
                        first.size,
                        first.processedCount,
                        first.isCompleted,
                        first.lastPage,
                      ],
                      [
                        projection.size,
                        projection.processedCount,
                        projection.isCompleted,
                        projection.lastPage,
                      ],
                      checkpoint,
                    )
                  )
                    fail('ConflictingEvidence');
                }
              }
              const wrapper = Object.freeze({
                projection,
                donorRawTargetCounts:
                  donorRawTargetCounts === null
                    ? null
                    : Object.freeze(donorRawTargetCounts),
              });
              if (wrapper.donorRawTargetCounts)
                observeWork([wrapper], wrapper.donorRawTargetCounts);
              observeWork([wrapper], wrapper);
              destination.push(wrapper);
              checkpoint();
              rootBytes.appendReport(slot, wrapper);
              checkpoint();
              observeWork([]);
            }
            phase(pass === 'a' ? 'after_report_a' : 'after_report_b');
          }
        };
        const equalLinks = (
          a: CompareLinksProjection,
          b: CompareLinksProjection,
        ) => {
          if (
            !equalValue(a.metadata, b.metadata, checkpoint) ||
            a.family !== b.family ||
            a.taskId !== b.taskId ||
            a.indexedDuplicateCount !== b.indexedDuplicateCount ||
            a.unindexedDuplicateCount !== b.unindexedDuplicateCount
          )
            return false;
          for (const field of ['indexedLinks', 'unindexedLinks'] as const) {
            const keys = new Set(b[field]);
            observeWork([keys]);
            if (
              keys.size !== a[field].length ||
              a[field].some((url) => {
                checkpoint();
                return !keys.has(url);
              })
            )
              return false;
          }
          return true;
        };
        const equalTask = (
          a: readonly ReportWrapper[],
          b: readonly ReportWrapper[],
        ) => {
          const first = a[0]!.projection,
            other = b[0]!.projection;
          if (first.reportKind === 'links' || other.reportKind === 'links')
            return (
              first.reportKind === 'links' &&
              other.reportKind === 'links' &&
              equalLinks(first, other)
            );
          if (
            a.length !== b.length ||
            !equalValue(
              [
                first.taskId,
                first.size,
                first.processedCount,
                first.isCompleted,
                first.lastPage,
              ],
              [
                other.taskId,
                other.size,
                other.processedCount,
                other.isCompleted,
                other.lastPage,
              ],
              checkpoint,
            )
          )
            return false;
          type IndexedDonor = {
            donor: CompareBacklinkProjection['donors'][number];
            rawTargetCount: number | null;
          };
          const flatten = (
            wrappers: readonly ReportWrapper[],
            previous: readonly IndexedDonor[] = [],
          ) => {
            const rows: IndexedDonor[] = [];
            for (const wrapper of wrappers) {
              const projection = wrapper.projection;
              if (projection.reportKind !== 'backlink')
                fail('ConflictingEvidence');
              for (const [index, donor] of projection.donors.entries()) {
                checkpoint();
                rows.push({
                  donor,
                  rawTargetCount: wrapper.donorRawTargetCounts![index]!,
                });
                observeWork([previous, rows]);
              }
            }
            return rows;
          };
          const before = flatten(a),
            after = flatten(b, before);
          if (before.length !== after.length) return false;
          const matched = after.map(() => false);
          const work = () => observeWork([before, after, matched]);
          const equalDonor = (a: IndexedDonor, b: IndexedDonor) => {
            if (
              a.rawTargetCount !== b.rawTargetCount ||
              a.donor.donorUrl !== b.donor.donorUrl ||
              a.donor.processedWitness !== b.donor.processedWitness
            )
              return false;
            const x = a.donor.evidence,
              y = b.donor.evidence;
            if (x.state === 'unknown' || y.state === 'unknown')
              return (
                x.state === 'unknown' &&
                y.state === 'unknown' &&
                x.reason === y.reason
              );
            return (
              x.targetLinks.length === y.targetLinks.length &&
              x.targetLinks.every((link) =>
                y.targetLinks.some((other) => {
                  checkpoint();
                  return (
                    link.url === other.url &&
                    link.anchor === other.anchor &&
                    link.nofollow === other.nofollow
                  );
                }),
              )
            );
          };
          // Paired rows and owner roots stay fixed during these searches.
          // Each false (5 JSON bytes) becomes true (4), so this frame dominates.
          work();
          for (const donor of before) {
            let found = false;
            for (let i = 0; i < after.length; i++) {
              checkpoint();
              if (!matched[i] && equalDonor(donor, after[i]!)) {
                matched[i] = true;
                found = true;
                break;
              }
            }
            if (!found) return false;
          }
          return true;
        };
        phase('before_status0');
        baseline = await statusPair();
        checkpoint();
        rootBytes.replaceStatus('baseline', baseline);
        checkpoint();
        scope(baseline);
        observeWork([]);
        phase('after_status0');
        await readTask(0, 'a', 'beforeA');
        checkpoint();
        await readTask(1, 'a', 'afterA');
        checkpoint();
        activePhase = 'fence';
        fence = await statusPair();
        checkpoint();
        rootBytes.replaceStatus('fence', fence);
        checkpoint();
        observeWork([]);
        if (!equalValue(baseline, fence, checkpoint)) fail('EvidenceChanged');
        fence = null;
        rootBytes.replaceStatus('fence', null);
        phase('after_status1');
        currentB = [];
        rootBytes.clearCurrentB();
        await readTask(0, 'b', 'currentB');
        checkpoint();
        if (!equalTask(beforeA, currentB)) fail('EvidenceChanged');
        currentB = [];
        rootBytes.clearCurrentB();
        await readTask(1, 'b', 'currentB');
        checkpoint();
        if (!equalTask(afterA, currentB)) fail('EvidenceChanged');
        currentB = [];
        rootBytes.clearCurrentB();
        fence = await statusPair();
        checkpoint();
        rootBytes.replaceStatus('fence', fence);
        checkpoint();
        observeWork([]);
        if (!equalValue(baseline, fence, checkpoint)) fail('EvidenceChanged');
        fence = null;
        rootBytes.replaceStatus('fence', null);
        phase('after_status2');
        const comparisonBaseline = baseline;
        const result = rootBytes.measurementScope((measurements) => {
          const before = {
            status: comparisonBaseline[0],
            reports: (() => {
              const reports = measurements.array<CompareReportProjection>();
              for (const wrapper of beforeA) reports.append(wrapper.projection);
              reports.seal();
              return reports.value;
            })(),
          };
          const after = {
            status: comparisonBaseline[1],
            reports: (() => {
              const reports = measurements.array<CompareReportProjection>();
              for (const wrapper of afterA) reports.append(wrapper.projection);
              reports.seal();
              return reports.value;
            })(),
          };
          return compareProjectedReports(
            args,
            before,
            after,
            checkpoint,
            observeWork,
            measurements,
          );
        });
        phase('after_comparison');
        pending = rootBytes.measurementScope((measurements) =>
          compareReportsToolResult(result, {
            maxBytes: limits.resultBytes,
            checkpoint,
            observeWork,
            measurements,
          }),
        );
        observeWork([result, pending]);
        phase('after_serialization');
        if (pending.structuredContent.status === 'blocked')
          primary = { code: pending.structuredContent.blocker.code };
        else if (pending.structuredContent.status === 'error')
          primary = { code: pending.structuredContent.error.code };
      } catch (error) {
        primary = classify(error, activePhase);
      }
      try {
        onPhase?.('before_close');
      } catch (error) {
        primary ??= classify(error, activePhase);
      }
      try {
        await close();
      } catch {
        cleanupFailed = true;
      }
      try {
        onPhase?.('after_close');
      } catch (error) {
        primary ??= classify(error, activePhase);
      }
      trackedNow();
      if (!primary && clock.signal?.aborted) primary = { code: 'Cancelled' };
      if (!primary && clock.deadlineFailed)
        primary = { code: 'DeadlineExceeded' };
      if (cleanupFailed)
        return select(primary ?? { code: 'CleanupFailed' }, true);
      return primary
        ? select(primary)
        : (pending ?? select({ code: 'InternalError' }));
    },
  });
}
