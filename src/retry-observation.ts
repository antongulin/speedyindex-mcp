/** Internal same-key two-pass collector. No SQL, proof, public tool or paid route. */
import { SpeedyIndexClient, TaskListError } from './client';
import { ReadBudgetError, type InvocationReadBudget } from './read-budget';
import {
  freezeSnapshot,
  type AvailableRetrySnapshot,
  type RetrySnapshot,
} from './retry-ledger-snapshot';
import { TaskReportError } from './task-report';
import { TaskStatusError } from './task-status';
import {
  submissionCredentialFingerprint,
  type ConfiguredSubmission,
} from './submission-policy';
import {
  assertRetryProviderBytes,
  classifyRetryPass,
  correlateRetryReportSafety,
  compareRetryReferences,
  mergeRetryFacts,
  parseRetryPlanInput,
  projectRetryFact,
  requireRetryId,
  requiredRetryChildReports,
  retryDripReferences,
  retryLogicalBytes,
  retryReferenceKey,
  retryRelations,
  RetrySemanticError,
  type RetryFact,
  type RetryFamily,
  type RetryObservations,
  type RetryPass,
  type RetryReference,
  type RetryReportFact,
  type RetryStream,
  type RetryBlocker,
  type RetryChildFact,
} from './plan-retry';

// A budget identifies one semantic scan; recreating the collector cannot reset it.
const collectedBudgets = new WeakSet<InvocationReadBudget>();

const ceilings = Object.freeze({
  maxReads: 64,
  roots: 2000,
  children: 4000,
  statusVisits: 12000,
  batchIds: 1000,
  requestBytes: 65536,
  rawPerReport: 10000,
  rawTotal: 40000,
  providerBytes: 8 * 1024 * 1024,
});
export type RetryCollectorLimits = { [K in keyof typeof ceilings]?: number };
export interface RetryInvocation {
  readonly startedAtMs: number;
  readonly budget: InvocationReadBudget;
  readonly clock: Readonly<{ monotonicMs(): number; utcMs(): number }>;
}
type Phase = 'list' | 'status' | 'report' | 'fence';
type Failure = Readonly<{
  status: 'error';
  code:
    | 'InvalidInput'
    | 'MissingCredentials'
    | 'Cancelled'
    | 'DeadlineExceeded'
    | 'ResourceLimitExceeded'
    | 'ReadFailed'
    | 'InternalError';
  phase?: Phase;
  cause?: 'http' | 'provider' | 'response' | 'network' | 'timeout';
}>;
export type RetryCollectionResult =
  | Readonly<{
      status: 'complete';
      observations: RetryObservations;
      meters: Readonly<{
        reads: number;
        roots: number;
        children: number;
        statusVisits: number;
        rawEntries: number;
      }>;
    }>
  | Failure
  | Readonly<{ status: 'blocked'; blockers: readonly RetryBlocker[] }>;
function conflict(): never {
  throw new RetrySemanticError('ConflictingEvidence');
}
function incomplete(): never {
  throw new RetrySemanticError('IncompleteScan');
}
function resource(): never {
  throw new ReadBudgetError('ResourceLimitExceeded');
}
export function packRetryStatusIds(
  ids: readonly string[],
  construction: { batchIds?: number; requestBytes?: number } = {},
): string[][] {
  const maxIds = construction.batchIds ?? ceilings.batchIds,
    maxBytes = construction.requestBytes ?? ceilings.requestBytes;
  if (
    !Number.isSafeInteger(maxIds) ||
    maxIds < 1 ||
    maxIds > ceilings.batchIds ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > ceilings.requestBytes
  )
    throw new RangeError('Invalid retry status limits.');
  const batches: string[][] = [];
  let batch: string[] = [];
  if (new Set(ids).size !== ids.length) conflict();
  for (const id of ids) {
    requireRetryId(id);
    if (
      batch.length === maxIds ||
      retryLogicalBytes({ task_ids: [...batch, id] }) > maxBytes
    ) {
      if (!batch.length) resource();
      batches.push(batch);
      batch = [];
    }
    if (retryLogicalBytes({ task_ids: [id] }) > maxBytes) resource();
    batch.push(id);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
type StatusJob = { family: RetryFamily; ids: string[]; single: boolean };
type WorkingPass = {
  streams: RetryStream[];
  facts: Map<string, RetryFact>;
  relations: RetryPass[2];
  selected: RetryReportFact | null;
  reports: RetryReportFact[];
};
const passTuple = (pass: WorkingPass): RetryPass => [
  pass.streams,
  [...pass.facts.values()].sort(compareRetryReferences),
  pass.relations,
  pass.selected,
  pass.reports,
];
const streams = [
  ['google/indexer', 'regular'],
  ['google/indexer', 'drip'],
  ['yandex/indexer', 'regular'],
] as const;
function emptyPass(): WorkingPass {
  return {
    streams: [],
    facts: new Map(),
    relations: [],
    selected: null,
    reports: [],
  };
}
function enrichChildren(
  pass: WorkingPass,
  accept: (facts: Map<string, RetryFact>) => void,
) {
  for (const [key, fact] of pass.facts) {
    const ids = fact[15] ?? fact[16]?.map((child) => child[1]);
    if (!ids) continue;
    const children = ids
      .map((id) => {
        const child = pass.facts.get(retryReferenceKey([fact[0], id]));
        if (!child) return incomplete();
        const embedded = fact[16]?.find((item) => item[1] === id);
        return [
          ...(embedded
            ? mergeRetryFacts(
                child,
                embedded.slice(0, 17) as unknown as RetryFact,
              )
            : child),
          embedded?.[17] ?? null,
        ] as RetryChildFact;
      })
      .sort(compareRetryReferences);
    const facts = new Map(pass.facts);
    facts.set(key, [
      ...fact.slice(0, 15),
      ids,
      children,
    ] as unknown as RetryFact);
    accept(facts);
  }
}
function supplementNeeded(fact: RetryFact): boolean {
  return (
    fact[5] === null ||
    (fact[5] === true &&
      (fact[6] === null ||
        fact[9] === null ||
        (fact[0] === 'google/indexer' && fact[8] === null)))
  );
}

export function createRetryObservationCollector(
  construction: Readonly<{
    configuration: ConfiguredSubmission;
    fetch?: typeof fetch;
    limits?: RetryCollectorLimits;
  }>,
) {
  const configuration = construction.configuration;
  if (
    configuration?.state !== 'configured' ||
    typeof configuration.credential?.effectiveKey !== 'string'
  )
    throw new RangeError('Invalid retry collector configuration.');
  const key = configuration.credential.effectiveKey;
  if (
    submissionCredentialFingerprint(key) !==
      configuration.credential.fingerprint ||
    configuration.snapshot.policy.credentialFingerprint !==
      configuration.credential.fingerprint
  )
    throw new RangeError('Invalid retry collector configuration.');
  const limits = { ...ceilings, ...construction.limits };
  for (const name of Object.keys(limits) as (keyof typeof ceilings)[])
    if (
      !Object.hasOwn(ceilings, name) ||
      !Number.isSafeInteger(limits[name]) ||
      limits[name] < 1 ||
      limits[name] > ceilings[name]
    )
      throw new RangeError('Invalid retry collector limits.');
  const client = new SpeedyIndexClient(
    key,
    construction.fetch ?? globalThis.fetch,
  );
  const list = client.listTasks.bind(client),
    status = client.getTaskStatus.bind(client),
    report = client.getTaskReport.bind(client);
  return Object.freeze({
    async collect(
      input: unknown,
      suppliedLocal: RetrySnapshot,
      invocation: RetryInvocation,
      signal?: AbortSignal,
    ): Promise<RetryCollectionResult> {
      let args: ReturnType<typeof parseRetryPlanInput>;
      try {
        args = parseRetryPlanInput(input);
      } catch {
        return { status: 'error', code: 'InvalidInput' };
      }
      let phase: Phase = 'list';
      try {
        const startedAtMs = invocation.startedAtMs;
        if (
          !Number.isFinite(startedAtMs) ||
          typeof invocation.budget?.checkpoint !== 'function' ||
          typeof invocation.clock?.monotonicMs !== 'function' ||
          typeof invocation.clock?.utcMs !== 'function'
        )
          throw new RangeError('Invalid retry invocation.');
        const budget = invocation.budget,
          checkpointBudget = budget.checkpoint.bind(budget),
          monotonic = invocation.clock.monotonicMs.bind(invocation.clock),
          utc = invocation.clock.utcMs.bind(invocation.clock);
        let lastNow = startedAtMs;
        const checkpoint = () => {
          checkpointBudget();
          if (signal?.aborted) throw new ReadBudgetError('Cancelled');
          let now = Number.NaN;
          try {
            now = monotonic();
          } catch {
            /* Invalid clocks expire this scan. */
          }
          if (
            !Number.isFinite(now) ||
            now < lastNow ||
            now - startedAtMs >= 60000
          )
            throw new ReadBudgetError('DeadlineExceeded');
          lastNow = now;
        };
        checkpoint();
        if (collectedBudgets.has(budget))
          return { status: 'error', code: 'InternalError' };
        collectedBudgets.add(budget);
        if (suppliedLocal.availability !== 'available')
          return {
            status: 'blocked',
            blockers: [
              suppliedLocal.reason === 'UpgradeRequired'
                ? 'UpgradeRequired'
                : suppliedLocal.reason === 'LimitExceeded'
                  ? 'SnapshotLimitExceeded'
                  : 'StateUnavailable',
            ],
          };
        const local = freezeSnapshot(
          JSON.parse(JSON.stringify(suppliedLocal)) as AvailableRetrySnapshot,
        );
        checkpoint();
        let reads = 0,
          visits = 0,
          rawEntries = 0;
        const roots = new Set<string>(),
          children = new Set<string>();
        const reserve = (remaining: number) => {
          if (
            !Number.isSafeInteger(remaining) ||
            reads + remaining > limits.maxReads
          )
            resource();
          checkpoint();
        };
        const chargeRef = (ref: RetryReference, kind: 'root' | 'child') => {
          requireRetryId(ref[1]);
          const set = kind === 'root' ? roots : children;
          set.add(retryReferenceKey(ref));
          if (set.size > (kind === 'root' ? limits.roots : limits.children))
            resource();
        };
        const rawMeter = Object.freeze({
          chargeRawEntries(count: number) {
            rawEntries += count;
            if (
              !Number.isSafeInteger(count) ||
              count < 0 ||
              count > limits.rawPerReport ||
              rawEntries > limits.rawTotal
            )
              resource();
            checkpoint();
          },
        });
        const perform = async <T>(operation: () => Promise<T>): Promise<T> => {
          reserve(1);
          reads++;
          const result = await operation();
          checkpoint();
          return result;
        };
        const measured = (pass: WorkingPass, previous?: RetryPass) => {
          checkpoint();
          assertRetryProviderBytes(
            previous ? [previous, passTuple(pass)] : [passTuple(pass)],
            limits.providerBytes,
          );
          checkpoint();
        };
        // Validate the entire prospective tuple, including wrappers, before retention.
        const retain = (
          pass: WorkingPass,
          patch: Partial<WorkingPass>,
          previous?: RetryPass,
        ) => {
          const candidate = { ...pass, ...patch };
          measured(candidate, previous);
          Object.assign(pass, patch);
        };
        const merge = (
          pass: WorkingPass,
          fact: RetryFact,
          previous?: RetryPass,
          patch: Partial<WorkingPass> = {},
        ) => {
          const id = retryReferenceKey(fact),
            old = pass.facts.get(id);
          const facts = new Map(pass.facts);
          facts.set(
            id,
            old ? mergeRetryFacts(old, fact) : mergeRetryFacts(fact, fact),
          );
          retain(pass, { ...patch, facts }, previous);
        };
        const counts = [1, 1, 1];
        const first = emptyPass();
        let initialLists = 0;
        const collectLists = async (pass: WorkingPass, fence?: RetryPass) => {
          const memberships = new Set<string>();
          for (
            let streamIndex = 0;
            streamIndex < streams.length;
            streamIndex++
          ) {
            const [family, scope] = streams[streamIndex]!;
            let pages: (readonly [number, readonly RetryReference[]])[] = [];
            let lastPage = fence?.[0][streamIndex]?.[2] ?? 0;
            const expectedStream = fence?.[0][streamIndex];
            for (let page = 0; page <= lastPage; page++) {
              phase = fence ? 'fence' : 'list';
              const result = await perform(() =>
                list(
                  {
                    searchEngine: family.split('/')[0],
                    taskType: 'indexer',
                    page,
                    ...(scope === 'drip' ? { filter: 'drip_feed' } : {}),
                  },
                  signal,
                  budget,
                ),
              );
              if (
                result.page !== page ||
                (page > 0 && result.lastPage !== lastPage) ||
                (fence && result.lastPage !== lastPage) ||
                result.lastPage < page
              )
                incomplete();
              if (page === 0) {
                lastPage = result.lastPage;
                counts[streamIndex] = lastPage + 1;
              }
              if (!fence) {
                initialLists++;
                reserve(2 * counts.reduce((a, b) => a + b, 0) - initialLists);
              }
              let refs: RetryReference[] = [];
              for (const task of result.tasks) {
                const ref: RetryReference = [family, task.id],
                  id = retryReferenceKey(ref);
                // Same reference in regular and drip lists is incompatible membership.
                if (memberships.has(id)) conflict();
                memberships.add(id);
                chargeRef(ref, 'root');
                const fact = projectRetryFact(family, task);
                if (scope === 'drip' && fact[10] === false) conflict();
                const nextRefs = [...refs, ref];
                const nextStreams = [...pass.streams];
                nextStreams[streamIndex] = [
                  family,
                  scope,
                  lastPage,
                  [...pages, [page, nextRefs]],
                ];
                merge(pass, fact, fence, { streams: nextStreams });
                refs = nextRefs;
              }
              if (
                fence &&
                JSON.stringify(refs) !==
                  JSON.stringify(expectedStream?.[3][page]?.[1])
              )
                incomplete();
              const nextPages = [...pages, [page, refs] as const];
              const nextStreams = [...pass.streams];
              nextStreams[streamIndex] = [family, scope, lastPage, nextPages];
              retain(pass, { streams: nextStreams }, fence);
              pages = nextPages;
            }
          }
          checkpoint();
          for (const manifest of local.acceptedManifests) {
            if (
              manifest.taskFamily !== 'google/indexer' &&
              manifest.taskFamily !== 'yandex/indexer'
            )
              continue;
            const ref: RetryReference = [
              manifest.taskFamily,
              manifest.providerTaskId,
            ];
            chargeRef(ref, 'root');
            if (!pass.facts.has(retryReferenceKey(ref)))
              merge(pass, projectRetryFact(ref[0], { id: ref[1] }), fence);
          }
          for (const ambiguous of local.ambiguousProviderRefs) {
            if (
              ambiguous.taskFamily !== 'google/indexer' &&
              ambiguous.taskFamily !== 'yandex/indexer'
            )
              continue;
            const ref: RetryReference = [
              ambiguous.taskFamily,
              ambiguous.providerTaskId,
            ];
            chargeRef(ref, 'root');
            if (!pass.facts.has(retryReferenceKey(ref)))
              merge(pass, projectRetryFact(ref[0], { id: ref[1] }), fence);
          }
          measured(pass, fence);
        };
        reserve(6);
        await collectLists(first);
        checkpoint();
        const fenceLists = counts.reduce((a, b) => a + b, 0);
        const dripRefs = retryDripReferences(passTuple(first));
        const jobs: StatusJob[] = [];
        for (const family of ['google/indexer', 'yandex/indexer'] as const) {
          const refs = [...first.facts.values()]
            .filter((fact) => fact[0] === family)
            .sort(compareRetryReferences);
          for (const ids of packRetryStatusIds(
            refs
              .filter((ref) => !dripRefs.has(retryReferenceKey(ref)))
              .map((ref) => ref[1]),
            limits,
          ))
            jobs.push({ family, ids, single: false });
          for (const fact of refs.filter((ref) =>
            dripRefs.has(retryReferenceKey(ref)),
          )) {
            if (retryLogicalBytes({ task_id: fact[1] }) > limits.requestBytes)
              resource();
            jobs.push({ family, ids: [fact[1]], single: true });
          }
        }
        const readStatus = async (
          pass: WorkingPass,
          job: StatusJob,
          fence?: RetryPass,
        ) => {
          phase = fence ? 'fence' : 'status';
          visits += job.ids.length;
          if (visits > limits.statusVisits) resource();
          const result = await perform(() =>
            status(
              {
                family: job.family,
                ...(job.single ? { taskId: job.ids[0] } : { taskIds: job.ids }),
              },
              signal,
              budget,
            ),
          );
          if (result.unreturnedIds.length) incomplete();
          for (const task of result.tasks)
            merge(pass, projectRetryFact(job.family, task), fence);
          measured(pass, fence);
        };
        const reserveStatusVisits = () => {
          if (
            2 * jobs.reduce((sum, job) => sum + job.ids.length, 0) >
            limits.statusVisits
          )
            resource();
        };
        reserveStatusVisits();
        let completedJobs = 0;
        const discoverChildren = (pass: WorkingPass, previous?: RetryPass) => {
          const relations = retryRelations([...pass.facts.values()]);
          for (const [parent, child] of relations) {
            if (
              !dripRefs.has(retryReferenceKey(parent)) ||
              parent[0] !== 'google/indexer'
            )
              conflict();
            chargeRef(child, 'child');
          }
          for (const fact of [...pass.facts.values()])
            for (const child of fact[16] ?? [])
              merge(pass, child.slice(0, 17) as unknown as RetryFact, previous);
          retain(pass, { relations }, previous);
        };
        for (let index = 0; index < jobs.length; index++) {
          reserve(jobs.length - completedJobs + fenceLists + jobs.length);
          await readStatus(first, jobs[index]!);
          completedJobs++;
        }
        // A missing-list ACK may reveal a drip root only in its first status.
        const regularListed = new Set(
          first.streams
            .filter((stream) => stream[1] === 'regular')
            .flatMap((stream) =>
              stream[3].flatMap((page) => page[1].map(retryReferenceKey)),
            ),
        );
        for (const fact of first.facts.values()) {
          if (fact[10] !== true || dripRefs.has(retryReferenceKey(fact)))
            continue;
          if (regularListed.has(retryReferenceKey(fact))) conflict();
          if (retryLogicalBytes({ task_id: fact[1] }) > limits.requestBytes)
            resource();
          dripRefs.add(retryReferenceKey(fact));
          jobs.push({ family: fact[0], ids: [fact[1]], single: true });
        }
        reserveStatusVisits();
        reserveStatusVisits();
        for (let index = completedJobs; index < jobs.length; index++) {
          reserve(jobs.length - completedJobs + fenceLists + jobs.length);
          await readStatus(first, jobs[index]!);
          completedJobs++;
        }
        discoverChildren(first);
        const scheduled = new Set(
          jobs.flatMap((job) =>
            job.ids.map((id) => retryReferenceKey([job.family, id])),
          ),
        );
        const supplementary = new Map<RetryFamily, string[]>();
        for (const [, child] of first.relations) {
          const fact = first.facts.get(retryReferenceKey(child));
          if (
            !scheduled.has(retryReferenceKey(child)) &&
            (!fact || supplementNeeded(fact))
          ) {
            const ids = supplementary.get(child[0]) ?? [];
            ids.push(child[1]);
            supplementary.set(child[0], ids);
          }
        }
        for (const [family, ids] of supplementary)
          for (const batch of packRetryStatusIds(ids, limits))
            jobs.push({ family, ids: batch, single: false });
        reserveStatusVisits();
        for (let index = completedJobs; index < jobs.length; index++) {
          reserve(jobs.length - completedJobs + fenceLists + jobs.length);
          await readStatus(first, jobs[index]!);
          completedJobs++;
        }
        for (const fact of first.facts.values())
          if (fact[10] === true && regularListed.has(retryReferenceKey(fact)))
            conflict();
        discoverChildren(first);
        enrichChildren(first, (facts) => retain(first, { facts }));
        measured(first);
        const observedUtcMs = utc();
        if (!Number.isSafeInteger(observedUtcMs)) conflict();
        const selection = classifyRetryPass(
          passTuple(first),
          local,
          args.searchEngine,
          observedUtcMs,
        );
        const reportRefs =
          selection.kind === 'selected'
            ? [
                selection.reference,
                ...requiredRetryChildReports(
                  passTuple(first),
                  local,
                  selection.reference,
                  observedUtcMs,
                ),
              ]
            : [];
        reserve(reportRefs.length * 2 + fenceLists + jobs.length);
        const readReport = async (
          pass: WorkingPass,
          ref: RetryReference,
          selected: boolean,
          fence?: RetryPass,
        ) => {
          phase = fence ? 'fence' : 'report';
          const value = await perform(() =>
            report(
              { family: ref[0], taskId: ref[1] },
              signal,
              budget,
              rawMeter,
            ),
          );
          if (value.reportKind !== 'links') conflict();
          const fact = pass.facts.get(retryReferenceKey(ref));
          if (!fact) incomplete();
          const merged = mergeRetryFacts(
            fact,
            projectRetryFact(ref[0], { ...value, id: value.taskId }),
          );
          const retained: RetryReportFact = [
            ref[0],
            ref[1],
            value.size,
            value.processedCount,
            value.indexedCount ?? null,
            [...new Set(value.indexedLinks)],
            [...new Set(value.unindexedLinks)],
            merged,
          ];
          correlateRetryReportSafety(passTuple(pass), retained);
          // Retain the status projection separately; report finality carries its merged fields.
          retain(
            pass,
            selected
              ? { selected: retained }
              : { reports: [...pass.reports, retained] },
            fence,
          );
        };
        for (const [index, ref] of reportRefs.entries())
          await readReport(first, ref, index === 0);
        checkpoint();
        const initial = passTuple(first);
        const second = emptyPass();
        await collectLists(second, initial);
        for (const job of jobs) await readStatus(second, job, initial);
        discoverChildren(second, initial);
        enrichChildren(second, (facts) => retain(second, { facts }, initial));
        measured(second, initial);
        if (
          JSON.stringify(passTuple(second).slice(0, 3)) !==
          JSON.stringify(initial.slice(0, 3))
        )
          incomplete();
        checkpoint();
        for (const [index, ref] of reportRefs.entries())
          await readReport(second, ref, index === 0, initial);
        if (JSON.stringify(passTuple(second)) !== JSON.stringify(initial))
          incomplete();
        checkpoint();
        const finalUtc = utc();
        if (!Number.isSafeInteger(finalUtc) || finalUtc < observedUtcMs)
          conflict();
        const observations = freezeSnapshot({
          facts: initial,
          initialLedgerId: local.ledgerId,
          initialRevision: local.revision,
          observedUtcMs: finalUtc,
          nonAtomic: true as const,
          finality: 'provider_observed' as const,
        });
        checkpoint();
        return Object.freeze({
          status: 'complete',
          observations,
          meters: Object.freeze({
            reads,
            roots: roots.size,
            children: children.size,
            statusVisits: visits,
            rawEntries,
          }),
        });
      } catch (error) {
        if (error instanceof RetrySemanticError)
          return Object.freeze({
            status: 'blocked',
            blockers: Object.freeze([error.code]),
          });
        if (error instanceof ReadBudgetError)
          return {
            status: 'error',
            code:
              error.code === 'ReadInProgress' || error.code === 'CleanupFailed'
                ? 'InternalError'
                : error.code,
            phase,
          };
        if (
          error instanceof TaskListError ||
          error instanceof TaskStatusError ||
          error instanceof TaskReportError
        ) {
          if (error.kind === 'credentials')
            return { status: 'error', code: 'MissingCredentials', phase };
          if (error.kind === 'cancelled')
            return { status: 'error', code: 'Cancelled', phase };
          if (
            error.kind === 'http' ||
            error.kind === 'provider' ||
            error.kind === 'response' ||
            error.kind === 'network' ||
            error.kind === 'timeout'
          )
            return {
              status: 'error',
              code: 'ReadFailed',
              cause: error.kind,
              phase,
            };
        }
        return { status: 'error', code: 'InternalError', phase };
      }
    },
  });
}
