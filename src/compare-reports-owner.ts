/** Internal read owner; construction grants no paid, history or public-tool authority. */
import { isProxy } from 'node:util/types';
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

// Capture native descriptors once, before any invocation-local writer exists.
// Guards read descriptors, never collection hooks or caller-provided methods.
const writerNatives = [
  [Array.prototype, 'push'],
  [Map.prototype, 'entries'],
  [Map.prototype, 'get'],
  [Map.prototype, 'has'],
  [Map.prototype, 'set'],
  [Set.prototype, 'values'],
  [Set.prototype, 'has'],
  [Set.prototype, 'add'],
  [Object.getPrototypeOf(new Map().entries()) as object, 'next'],
  [Object.getPrototypeOf(new Set().values()) as object, 'next'],
  [
    Object.getPrototypeOf(
      Object.getPrototypeOf(new Map().entries()) as object,
    ) as object,
    Symbol.iterator,
  ],
] as const;
const writerDescriptors = writerNatives.map(([prototype, name]) =>
  Object.getOwnPropertyDescriptor(prototype, name),
);
function unchangedWriterNative(index: number): boolean {
  const [prototype, name] = writerNatives[index]!;
  const current = Object.getOwnPropertyDescriptor(prototype, name);
  const original = writerDescriptors[index];
  return (
    current !== undefined &&
    original !== undefined &&
    current.value === original.value &&
    current.get === original.get &&
    current.set === original.set &&
    current.writable === original.writable &&
    current.enumerable === original.enumerable &&
    current.configurable === original.configurable
  );
}
// Trusted unmodified module initialization, as for the writer kernel above.
// Descriptor equality detects later changes; it does not authenticate pre-import
// replacements. Never recapture this baseline when a meter/scope is created.
const filterArray = Array;
const filterPrototype = Array.prototype;
const filterNatives = [
  [globalThis, 'Array'],
  [filterArray, 'prototype'],
  [filterPrototype, 'filter'],
  [filterPrototype, 'constructor'],
  [filterArray, Symbol.species],
  [filterPrototype, 'every'],
  [filterArray, 'isArray'],
] as const;
const filterDescriptors = filterNatives.map(([target, name]) =>
  Object.getOwnPropertyDescriptor(target, name),
);
function unchangedFilterNatives(): boolean {
  for (let index = 0; index < filterNatives.length; index++) {
    const location = filterNatives[index]!;
    const current = Object.getOwnPropertyDescriptor(location[0], location[1]);
    const original = filterDescriptors[index];
    if (
      current === undefined ||
      original === undefined ||
      current.value !== original.value ||
      current.get !== original.get ||
      current.set !== original.set ||
      current.writable !== original.writable ||
      current.enumerable !== original.enumerable ||
      current.configurable !== original.configurable
    )
      return false;
  }
  return true;
}
interface NumericScope {
  readonly parent: NumericScope | undefined;
  readonly bytes: WeakMap<object, number>;
  readonly dependencies: WeakMap<object, number>;
  readonly kinds: WeakMap<object, number>;
  readonly sealed: WeakMap<object, number>;
  reads: PrivateReadLayer | undefined;
}
interface PrivateReadLayer {
  readonly bytes: WeakMap<object, number>;
  readonly kinds: WeakMap<object, number>;
  readonly next: PrivateReadLayer | undefined;
}
interface NumericMeasurement {
  readonly bytes: number;
  readonly dependencies: number;
}

/**
 * Invocation-local scalar accounting. Completion notifications originate only
 * at private allocation sites, after their last mutation. Certification is
 * bottom-up: every object child must already have its own closed certificate.
 * Weak keys retain no DTOs; values are byte counts, never serialized images.
 */
export function createCompareOwnerRootBytes() {
  const ownedBytes = new WeakMap<object, number>();
  let activeScope: NumericScope | undefined;
  // A later inherited toJSON must take the ordinary native path too, including
  // when it returns its receiver. Dense arrays cannot read inherited holes.
  const plainPrototypes = () =>
    Object.getPrototypeOf(Object.prototype) === null &&
    Object.getPrototypeOf(Array.prototype) === Object.prototype &&
    !Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') &&
    !Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const currentNatives = (dependencies: number) =>
    plainPrototypes() &&
    (!(dependencies & 1) ||
      (Object.getPrototypeOf(Map.prototype) === Object.prototype &&
        !Object.getOwnPropertyDescriptor(Map.prototype, 'toJSON') &&
        Object.getPrototypeOf(writerNatives[8][0]) === writerNatives[10][0] &&
        !Object.getOwnPropertyDescriptor(
          writerNatives[8][0],
          Symbol.iterator,
        ) &&
        [1, 2, 3, 4, 8, 10].every(unchangedWriterNative))) &&
    (!(dependencies & 2) ||
      (Object.getPrototypeOf(Set.prototype) === Object.prototype &&
        !Object.getOwnPropertyDescriptor(Set.prototype, 'toJSON') &&
        Object.getPrototypeOf(writerNatives[9][0]) === writerNatives[10][0] &&
        !Object.getOwnPropertyDescriptor(
          writerNatives[9][0],
          Symbol.iterator,
        ) &&
        [5, 6, 7, 9, 10].every(unchangedWriterNative))) &&
    (!(dependencies & 4) || unchangedWriterNative(0));
  const currentContainer = (value: object, kind: number) => {
    if (Object.getOwnPropertyDescriptor(value, 'toJSON')) return false;
    if (kind === 1 || kind === 4)
      return (
        Object.getPrototypeOf(value) === Array.prototype &&
        !Object.getOwnPropertyDescriptor(value, 'push')
      );
    if (kind === 2)
      return (
        Object.getPrototypeOf(value) === Map.prototype &&
        ['entries', 'get', 'has', 'set'].every(
          (name) => !Object.getOwnPropertyDescriptor(value, name),
        )
      );
    if (kind === 3)
      return (
        Object.getPrototypeOf(value) === Set.prototype &&
        ['values', 'has', 'add'].every(
          (name) => !Object.getOwnPropertyDescriptor(value, name),
        )
      );
    if (kind === 5) {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }
    return true; // Fully preflighted immutable candidate / private own-key list.
  };
  const readMeasurement = (
    value: object,
    fromScope: NumericScope | undefined,
  ): NumericMeasurement | undefined => {
    for (let scope = fromScope; scope; scope = scope.parent) {
      // Metadata snapshots share one scope table, not one layer per node.
      if (scope.kinds.get(value) === 4) {
        const bytes = scope.bytes.get(value);
        const dependencies = scope.dependencies.get(value)!;
        if (
          bytes !== undefined &&
          currentNatives(dependencies) &&
          currentContainer(value, 4)
        )
          return { bytes, dependencies };
      }
      for (let layer = scope.reads; layer; layer = layer.next) {
        const bytes = layer.bytes.get(value);
        if (
          bytes !== undefined &&
          currentNatives(0) &&
          currentContainer(value, layer.kinds.get(value)!)
        )
          return { bytes, dependencies: 0 };
      }
    }
    return undefined;
  };
  const measured = (
    value: object,
    sealedOnly = false,
    fromScope = activeScope,
  ): NumericMeasurement | undefined => {
    for (let scope = fromScope; scope; scope = scope.parent) {
      const bytes = scope.bytes.get(value);
      if (bytes === undefined) continue;
      const dependencies = scope.dependencies.get(value)!;
      if (
        (!sealedOnly || scope.sealed.get(value) === 1) &&
        currentNatives(dependencies) &&
        currentContainer(value, scope.kinds.get(value)!)
      )
        return { bytes, dependencies };
      return undefined;
    }
    return sealedOnly ? undefined : readMeasurement(value, fromScope);
  };
  const primitiveBytes = (value: unknown): number | undefined => {
    if (value === undefined) return 4; // Array / native collection entry context.
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    return undefined;
  };
  const stableValue = (
    value: unknown,
    scope: NumericScope,
  ): NumericMeasurement | undefined => {
    if (value !== null && typeof value === 'object') {
      const bytes = ownedBytes.get(value);
      if (bytes !== undefined && plainPrototypes())
        return { bytes, dependencies: 0 };
      // A weak lookup on an unsupported/foreign child invokes no proxy/getter.
      return measured(value, true, scope);
    }
    const bytes = primitiveBytes(value);
    return bytes === undefined ? undefined : { bytes, dependencies: 0 };
  };
  const recordMeasurement = (
    scope: NumericScope,
    value: object,
    bytes: number,
    dependencies: number,
    kind: number,
    sealed = 0,
  ) => {
    scope.bytes.set(value, bytes);
    scope.dependencies.set(value, dependencies);
    scope.kinds.set(value, kind);
    scope.sealed.set(value, sealed);
  };
  const scoped = <T>(operation: (scope: NumericScope) => T): T => {
    const parent = activeScope;
    const scope: NumericScope = {
      parent,
      bytes: new WeakMap(),
      dependencies: new WeakMap(),
      kinds: new WeakMap(),
      sealed: new WeakMap(),
      reads: undefined,
    };
    activeScope = scope;
    try {
      return operation(scope);
    } finally {
      // Discard the whole unpublished layer, including failed builders, without
      // a strong key list. Nested certification restores the outer numbers.
      activeScope = parent;
    }
  };
  const encodedBytes = (root: unknown) => {
    let correction = 0;
    const json = JSON.stringify(root, (_name, value: unknown) => {
      if (value !== null && typeof value === 'object' && plainPrototypes()) {
        const bytes = ownedBytes.get(value) ?? measured(value)?.bytes;
        if (bytes !== undefined) {
          correction += bytes - 4; // Actual JSON null, once per occurrence.
          return null;
        }
      }
      return value instanceof Map
        ? [...value.entries()]
        : value instanceof Set
          ? [...value.values()]
          : value;
    });
    return Buffer.byteLength(json, 'utf8') + correction;
  };
  let baselineBytes = 4,
    fenceBytes = 4;
  let beforeABytes = 2,
    afterABytes = 2,
    currentBBytes = 2;
  let beforeACount = 0,
    afterACount = 0,
    currentBCount = 0;
  return Object.freeze({
    /** Lexical private producer lifetime; no enrollment of existing containers. */
    measurementScope<T>(
      operation: (writers: {
        array<V>(): {
          readonly value: V[];
          append(value: V): void;
          seal(): readonly V[];
        };
        map<V>(): {
          readonly value: Map<string, V>;
          put(key: string, value: V): void;
          seal(): ReadonlyMap<string, V>;
        };
        set<V>(): {
          readonly value: Set<V>;
          add(value: V): void;
          seal(): ReadonlySet<V>;
        };
        /** Trusted fresh closed structural DTOs at named private allocation sites. */
        privateRead(root: object, checkpoint?: () => void): boolean;
        privateKeys(root: object, checkpoint?: () => void): readonly string[];
        privateValues(
          root: object,
          checkpoint?: () => void,
        ): readonly unknown[];
        /** Named original readonly predicates/graphs; never generic adoption. */
        privateFilter<V>(
          rows: readonly V[],
          predicate: (value: V, index: number, array: readonly V[]) => unknown,
          checkpoint?: () => void,
        ): readonly V[];
      }) => T,
    ): T {
      return scoped((scope) => {
        const lifetime = () => {
          for (let current = activeScope; current; current = current.parent)
            if (current === scope) return activeScope;
          return undefined;
        };
        const live = (value: object) => {
          for (let current = activeScope; current; current = current.parent)
            if (current === scope) return measured(value, false, scope);
          return undefined;
        };
        const seal = <V extends object>(value: V): V => {
          Object.freeze(value); // Stabilizes own hooks/prototype, not Map entries.
          scope.sealed.set(value, 1);
          return value;
        };
        const writable = (value: object) => {
          if (scope.sealed.get(value) === 1)
            throw new TypeError('Closed comparison writer.');
        };
        const metadata = <V>(
          values: V[],
          checkpoint?: () => void,
          readView?: () => boolean,
        ): V[] => {
          const owner = lifetime();
          if (!owner) return values;
          if (readView) {
            // Fresh default-native filter provenance supplies density. Inspect
            // only transient own data slots, never a key list or descendants.
            const lengthDescriptor = Object.getOwnPropertyDescriptor(
              values,
              'length',
            );
            const length: unknown = lengthDescriptor?.value;
            if (
              !lengthDescriptor ||
              !Object.hasOwn(lengthDescriptor, 'value') ||
              typeof length !== 'number' ||
              !Number.isSafeInteger(length) ||
              length < 0 ||
              !lengthDescriptor.writable ||
              lengthDescriptor.enumerable ||
              lengthDescriptor.configurable
            )
              return values;
            let bytes = 2,
              dependencies = 0;
            checkpoint?.();
            if (!readView()) return values;
            for (let index = 0; index < length; index++) {
              checkpoint?.();
              if (!readView()) return values;
              const descriptor = Object.getOwnPropertyDescriptor(values, index);
              if (
                !descriptor ||
                !Object.hasOwn(descriptor, 'value') ||
                !descriptor.enumerable ||
                !descriptor.writable ||
                !descriptor.configurable
              )
                return values;
              const value: unknown = descriptor.value;
              const read =
                stableValue(value, owner) ??
                (value !== null && typeof value === 'object'
                  ? readMeasurement(value, owner)
                  : undefined);
              if (!read) return values;
              bytes += read.bytes + (index ? 1 : 0);
              dependencies |= read.dependencies;
            }
            checkpoint?.();
            if (
              !readView() ||
              lifetime() !== owner ||
              !currentNatives(dependencies)
            )
              return values;
            Object.freeze(values); // Only the actual native result, not its rows.
            recordMeasurement(owner, values, bytes, dependencies, 4, 0);
            return values; // Empty/all-stable views also grant no sealed proof.
          }
          let bytes = 2,
            dependencies = 0,
            stable = true;
          checkpoint?.();
          for (let index = 0; index < values.length; index++) {
            checkpoint?.();
            const value = values[index];
            const immutable = stableValue(value, owner);
            const read =
              immutable ??
              (value !== null && typeof value === 'object'
                ? readMeasurement(value, owner)
                : undefined);
            if (!read) return values;
            stable &&= immutable !== undefined;
            bytes += read.bytes + (index ? 1 : 0);
            dependencies |= read.dependencies;
          }
          checkpoint?.();
          if (lifetime() !== owner || !currentNatives(dependencies))
            return values;
          Object.freeze(values); // The native snapshot only, never source/children.
          recordMeasurement(
            owner,
            values,
            bytes,
            dependencies,
            4,
            stable ? 1 : 0,
          );
          return values;
        };
        return operation({
          privateRead(root, checkpoint) {
            const owner = lifetime();
            if (!owner) return false;
            // Staging is unreachable by observers until the entire graph and
            // final checkpoint succeed. Only weak numeric maps survive commit.
            const layer: PrivateReadLayer = {
              bytes: new WeakMap(),
              kinds: new WeakMap(),
              next: owner.reads,
            };
            const marks = new WeakMap<object, number>();
            const visit = (value: unknown): number | undefined => {
              checkpoint?.();
              if (!plainPrototypes()) return undefined;
              if (value === null || typeof value !== 'object')
                return primitiveBytes(value);
              const owned = ownedBytes.get(value);
              if (owned !== undefined) return owned;
              if (isProxy(value)) return undefined;
              const mark = marks.get(value);
              if (mark === 1) return undefined; // Cycle: no partial publication.
              if (mark === 2) return layer.bytes.get(value);
              const array = Array.isArray(value);
              const prototype = Object.getPrototypeOf(value);
              if (
                array
                  ? prototype !== Array.prototype
                  : prototype !== Object.prototype && prototype !== null
              )
                return undefined;
              marks.set(value, 1);
              const keys = Reflect.ownKeys(value);
              checkpoint?.();
              if (array && keys.length !== value.length + 1) return undefined;
              let bytes = 2,
                emitted = 0;
              for (const name of keys) {
                checkpoint?.();
                const descriptor = Object.getOwnPropertyDescriptor(
                  value,
                  name,
                )!;
                if (
                  typeof name !== 'string' ||
                  name === 'toJSON' ||
                  !Object.hasOwn(descriptor, 'value')
                )
                  return undefined;
                if (array && name === 'length') continue;
                if (
                  !descriptor.enumerable ||
                  (array &&
                    (!/^(0|[1-9][0-9]*)$/.test(name) ||
                      Number(name) >= value.length))
                )
                  return undefined;
                const child: unknown = descriptor.value;
                const childBytes = visit(child);
                if (childBytes === undefined) return undefined;
                if (!array && child === undefined) continue;
                bytes +=
                  childBytes +
                  (emitted++ ? 1 : 0) +
                  (array ? 0 : primitiveBytes(name)! + 1);
              }
              layer.bytes.set(value, bytes);
              layer.kinds.set(value, array ? 1 : 5);
              marks.set(value, 2);
              return bytes;
            };
            if (visit(root) === undefined) return false;
            checkpoint?.();
            if (lifetime() !== owner || !plainPrototypes()) return false;
            owner.reads = layer;
            return true;
          },
          privateKeys(root, checkpoint) {
            return metadata(Object.keys(root), checkpoint);
          },
          privateValues(root, checkpoint) {
            return metadata(Object.values(root), checkpoint);
          },
          privateFilter(rows, predicate, checkpoint) {
            const owner = lifetime();
            const nativeArray = (value: object) =>
              !isProxy(value) &&
              filterArray.isArray(value) &&
              Object.getPrototypeOf(value) === filterPrototype &&
              !Object.getOwnPropertyDescriptor(value, 'filter') &&
              !Object.getOwnPropertyDescriptor(value, 'constructor') &&
              currentContainer(value, 4);
            const source = () =>
              owner !== undefined &&
              lifetime() === owner &&
              unchangedFilterNatives() &&
              plainPrototypes() &&
              nativeArray(rows) &&
              (ownedBytes.has(rows) ||
                measured(rows, false, owner) !== undefined);
            const eligible = source();
            const values = rows.filter(predicate); // Same method/receiver/one arg.
            if (!eligible) return values; // No output inspection or checkpoints.
            const current = () =>
              source() && values !== rows && nativeArray(values);
            if (!current()) return values;
            return metadata(values, checkpoint, current);
          },
          array<V>() {
            const value: V[] = [];
            let count = 0;
            recordMeasurement(scope, value, 2, 4, 1);
            return Object.freeze({
              value,
              append(child: V) {
                writable(value);
                const previous = live(value);
                const next = previous && stableValue(child, scope);
                scope.bytes.delete(value);
                value.push(child); // The ordinary operation also owns fallback.
                if (
                  previous &&
                  next &&
                  currentNatives(previous.dependencies | next.dependencies) &&
                  currentContainer(value, 1)
                )
                  recordMeasurement(
                    scope,
                    value,
                    previous.bytes + next.bytes + (count ? 1 : 0),
                    previous.dependencies | next.dependencies,
                    1,
                  );
                count++;
              },
              seal: () => seal(value),
            });
          },
          map<V>() {
            const value = new Map<string, V>();
            let count = 0;
            recordMeasurement(scope, value, 2, 1, 2);
            return Object.freeze({
              value,
              put(name: string, child: V) {
                writable(value);
                const previous = live(value);
                const next =
                  previous &&
                  typeof name === 'string' &&
                  stableValue(child, scope);
                let delta: number | undefined;
                let dependencies = previous?.dependencies ?? 1;
                let inserted = false;
                if (
                  previous &&
                  next &&
                  currentNatives(dependencies) &&
                  currentContainer(value, 2)
                ) {
                  inserted = !value.has(name);
                  if (inserted) {
                    delta =
                      3 + primitiveBytes(name)! + next.bytes + (count ? 1 : 0);
                  } else {
                    const old = stableValue(value.get(name), scope);
                    if (old) delta = next.bytes - old.bytes;
                  }
                  dependencies |= next.dependencies;
                }
                scope.bytes.delete(value);
                value.set(name, child);
                if (
                  previous &&
                  delta !== undefined &&
                  currentNatives(dependencies) &&
                  currentContainer(value, 2)
                ) {
                  recordMeasurement(
                    scope,
                    value,
                    previous.bytes + delta,
                    dependencies,
                    2,
                  );
                  if (inserted) count++;
                }
              },
              seal: () => seal(value),
            });
          },
          set<V>() {
            const value = new Set<V>();
            let count = 0;
            recordMeasurement(scope, value, 2, 2, 3);
            return Object.freeze({
              value,
              add(child: V) {
                writable(value);
                const previous = live(value);
                const next = previous && stableValue(child, scope);
                const duplicate =
                  previous &&
                  next &&
                  currentNatives(previous.dependencies) &&
                  currentContainer(value, 3)
                    ? value.has(child)
                    : false;
                scope.bytes.delete(value);
                value.add(child);
                if (
                  previous &&
                  next &&
                  currentNatives(previous.dependencies | next.dependencies) &&
                  currentContainer(value, 3)
                ) {
                  recordMeasurement(
                    scope,
                    value,
                    previous.bytes +
                      (duplicate ? 0 : next.bytes + (count ? 1 : 0)),
                    previous.dependencies | next.dependencies,
                    3,
                  );
                  if (!duplicate) count++;
                }
              },
              seal: () => seal(value),
            });
          },
        });
      });
    },
    /** Trusted private ownership notification; never freezes the supplied value. */
    certifyOwned(
      root: object,
      observe?: CompareWorkRootsObserver,
      checkpoint?: () => void,
    ): boolean {
      checkpoint?.();
      if (isProxy(root) || !plainPrototypes() || !Object.isFrozen(root))
        return false;
      if (ownedBytes.has(root)) return true;
      const array = Array.isArray(root);
      const prototype = Object.getPrototypeOf(root);
      if (
        array
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        return false;
      // No serializing notification can see a candidate until every descriptor
      // is eligible. Preflight uses only the original, nonserializing checkpoint.
      checkpoint?.();
      const keys = Reflect.ownKeys(root);
      checkpoint?.();
      let candidateBytes = 2,
        keyBytes = 2,
        emitted = 0;
      // Reject sparse and decorated arrays rather than assume prototype holes
      // or ignored properties remain harmless. Private DTO arrays are dense.
      if (array && keys.length !== root.length + 1) return false;
      for (const key of keys) {
        checkpoint?.();
        const descriptor = Object.getOwnPropertyDescriptor(root, key)!;
        if (
          typeof key !== 'string' ||
          key === 'toJSON' ||
          !Object.hasOwn(descriptor, 'value')
        )
          return false;
        keyBytes += primitiveBytes(key)! + (keyBytes === 2 ? 0 : 1);
        if (array && key === 'length') continue;
        if (
          !descriptor.enumerable ||
          (array &&
            (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= root.length))
        )
          return false;
        const child: unknown = descriptor.value;
        let childBytes: number;
        if (child !== null && typeof child === 'object') {
          if (!ownedBytes.has(child)) return false;
          childBytes = ownedBytes.get(child)!;
        } else if (
          child !== null &&
          child !== undefined &&
          typeof child !== 'string' &&
          typeof child !== 'boolean' &&
          !(typeof child === 'number' && Number.isFinite(child))
        )
          return false;
        else childBytes = primitiveBytes(child)!;
        if (!array && child === undefined) continue;
        candidateBytes +=
          childBytes +
          (emitted++ ? 1 : 0) +
          (array ? 0 : primitiveBytes(key)! + 1);
      }
      // Valid scan charges the candidate, the same own-key list, the current
      // descriptor and producer ancestors. Preflight descriptors are discarded.
      Object.freeze(keys);
      return scoped((scope) => {
        recordMeasurement(scope, root, candidateBytes, 0, 0);
        recordMeasurement(scope, keys, keyBytes, 0, 0);
        checkpoint?.();
        if (keys.length === 0) observe?.([root, keys]);
        for (const key of keys) {
          checkpoint?.();
          const descriptor = Object.getOwnPropertyDescriptor(root, key)!;
          observe?.([root, keys, descriptor]);
        }
        checkpoint?.();
        const bytes = encodedBytes(root);
        checkpoint?.();
        if (!plainPrototypes()) return false;
        ownedBytes.set(root, bytes);
        return true;
      });
    },
    replaceStatus(slot: 'baseline' | 'fence', pair: readonly unknown[] | null) {
      const bytes = pair === null ? 4 : encodedBytes(pair);
      if (slot === 'baseline') baselineBytes = bytes;
      else fenceBytes = bytes;
    },
    appendReport(slot: ReportSlot, wrapper: unknown) {
      const bytes = encodedBytes(wrapper);
      // Each array is exactly 2 + sum(element bytes) + max(0, count - 1).
      if (slot === 'beforeA') beforeABytes += bytes + (beforeACount++ ? 1 : 0);
      else if (slot === 'afterA')
        afterABytes += bytes + (afterACount++ ? 1 : 0);
      else currentBBytes += bytes + (currentBCount++ ? 1 : 0);
    },
    clearCurrentB() {
      currentBBytes = 2;
      currentBCount = 0;
    },
    bytes(extraRoots: readonly unknown[]) {
      // Six slots contribute two brackets and five commas, even for aliases.
      return (
        7 +
        baselineBytes +
        beforeABytes +
        afterABytes +
        currentBBytes +
        fenceBytes +
        encodedBytes(extraRoots)
      );
    },
  });
}
/** Internal capability type only; importing it creates no runtime cycle. */
export type ComparePrivateMeasurements = Parameters<
  Parameters<
    ReturnType<typeof createCompareOwnerRootBytes>['measurementScope']
  >[0]
>[0];

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
