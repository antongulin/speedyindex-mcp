import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HistoryControlDecoder,
  HistoryPhaseDecoder,
  HISTORY_PHASE_PREFIX,
  HISTORY_PROTOCOL_ERROR,
  HISTORY_SANITY_PREFIX,
  type HistoryPhase,
  type HistoryControl,
} from './fixtures/get-retry-history-protocol';

function root() {
  const enclosure = realpathSync(
    mkdtempSync(join(tmpdir(), 'grh-preparation-')),
  );
  chmodSync(enclosure, 0o700);
  const home = join(enclosure, 'home');
  const temporary = join(enclosure, 'tmp');
  for (const path of [home, temporary]) mkdirSync(path, { mode: 0o700 });
  const directory = realpathSync(mkdtempSync(join(temporary, 'fixture-')));
  chmodSync(directory, 0o700);
  for (const path of [enclosure, home, temporary, directory]) {
    const stat = lstatSync(path);
    if (
      realpathSync(path) !== path ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new Error('Private fixture environment required.');
  }
  return { directory, home, temporary };
}
function save(path: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  const readback = readFileSync(path);
  expect(readback.equals(bytes)).toBe(true);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  const hash = createHash('sha256').update(readback).digest('hex');
  expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
  return { bytes: readback, sha256: hash };
}
const phases: HistoryPhase[] = [
  { event: 'BOOT_READY' },
  { event: 'HANDLER_ENTER', operation: 1 },
  { event: 'NATIVE_CLOSED', operation: 1 },
  { event: 'READ_IO_HELD', operation: 1 },
  { event: 'SIGNAL_ABORTED', operation: 1 },
  { event: 'BUDGET_CLOSED', operation: 1 },
  {
    event: 'OWNER_SETTLED',
    operation: 1,
    aborted: true,
    status: 'error',
    code: 'Cancelled',
  },
  {
    event: 'BARRIER',
    sequence: 1,
    handlerEntries: 1,
    nativeReads: 1,
    nativeCloses: 1,
    budgetSettlements: 1,
    httpAttempts: 0,
  },
];
const controls: HistoryControl[] = [
  { event: 'BARRIER', sequence: 1 },
  { event: 'RELEASE_READ_IO', operation: 1 },
  { event: 'BARRIER', sequence: 2 },
];
function phaseBytes(events: readonly unknown[]) {
  return Buffer.from(
    events
      .map((event) => HISTORY_PHASE_PREFIX + JSON.stringify(event) + '\n')
      .join(''),
  );
}
function controlBytes(events: readonly unknown[]) {
  return Buffer.from(
    events.map((event) => JSON.stringify(event) + '\n').join(''),
  );
}
function fragments(bytes: Buffer, sizes: readonly number[]) {
  const chunks: Buffer[] = [];
  let index = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const size = sizes[index++ % sizes.length];
    if (!size || size < 1) throw new Error('Invalid saved fixture split.');
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}
function barrier(sequence: number, handlers = 0) {
  return {
    event: 'BARRIER',
    sequence,
    handlerEntries: handlers,
    nativeReads: 0,
    nativeCloses: 0,
    budgetSettlements: 0,
    httpAttempts: 0,
  };
}
function earlyOperations(count: number): unknown[] {
  const events: unknown[] = [{ event: 'BOOT_READY' }];
  for (let operation = 1; operation <= count; operation++)
    events.push(
      { event: 'HANDLER_ENTER', operation },
      {
        event: 'OWNER_SETTLED',
        operation,
        aborted: false,
        status: 'blocked',
        code: null,
      },
    );
  return events;
}

test('GRH-SANITY-01 finite phase/control streams preserve fragments and reject invalid or premature receipts', async () => {
  const { directory } = root();
  const badPhases: Buffer[] = [
    Buffer.from('HISTORY_PHASE {"event":"BOOT_READY","event":"BOOT_READY"}\n'),
    Buffer.from(
      'HISTORY_PHASE {"event":"BOOT_READY","\\u0065vent":"BOOT_READY"}\n',
    ),
    Buffer.from('HISTORY_PHASE {"event":"PRIVATE_SENTINEL"}\n'),
    phaseBytes([{ event: 'BOOT_READY', private: 'PRIVATE_SENTINEL' }]),
    phaseBytes([{ event: 'BOOT_READY' }, { event: 'BOOT_READY' }]),
    phaseBytes([{ event: 'HANDLER_ENTER', operation: 1 }]),
    phaseBytes([
      { event: 'BOOT_READY' },
      { event: 'HANDLER_ENTER', operation: 2 },
    ]),
    phaseBytes([phases[0], phases[1], phases[1]]),
    phaseBytes([phases[0], phases[2]]),
    phaseBytes([phases[0], phases[1], phases[3]]),
    phaseBytes([phases[0], phases[1], phases[2], phases[2]]),
    phaseBytes([phases[0], phases[1], phases[2], phases[6]]),
    phaseBytes([phases[0], phases[1], phases[2], phases[3], phases[5]]),
    phaseBytes([phases[0], phases[1], phases[4], phases[4]]),
    phaseBytes([phases[0], phases[1], phases[5], phases[5]]),
    phaseBytes([
      phases[0],
      phases[1],
      { event: 'NATIVE_CLOSED', operation: 2 },
    ]),
    phaseBytes([phases[0], phases[1], { event: 'READ_IO_HELD', operation: 2 }]),
    phaseBytes([phases[0], phases[1], { ...phases[6], code: null }]),
    phaseBytes([
      phases[0],
      phases[1],
      { ...phases[6], code: 'PRIVATE_SENTINEL' },
    ]),
    phaseBytes([phases[0], phases[1], { ...phases[6], aborted: false }]),
    phaseBytes([phases[0], phases[1], { ...phases[6], status: 'ready' }]),
    phaseBytes([phases[0], phases[1], { ...phases[6], aborted: 'true' }]),
    phaseBytes([phases[0], barrier(2)]),
    phaseBytes([phases[0], barrier(1), barrier(1)]),
    phaseBytes([phases[0], { ...barrier(1), handlerEntries: 1 }]),
    phaseBytes([phases[0], { ...barrier(1), nativeCloses: 1 }]),
    phaseBytes([phases[0], { ...barrier(1), budgetSettlements: 1 }]),
    phaseBytes([phases[0], { ...barrier(1), nativeReads: 1 }]),
    phaseBytes([phases[0], { ...barrier(1), httpAttempts: 1 }, barrier(2)]),
    phaseBytes([phases[0], { event: 'FIXTURE_ERROR' }, barrier(1)]),
    Buffer.from('OTHER_PHASE {"event":"BOOT_READY"}\n'),
    Buffer.from('HISTORY_PHASE {"event":"BOOT_READY"}\r\n'),
    Buffer.from('HISTORY_PHASE {"event":"BOOT_READY"}'),
    Buffer.concat([
      Buffer.from(HISTORY_PHASE_PREFIX),
      Buffer.from([0xc3, 0x28, 10]),
    ]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), phaseBytes([phases[0]])]),
    Buffer.from('HISTORY_PHASE []\n'),
    Buffer.from('HISTORY_PHASE {\n'),
    Buffer.alloc(16_385, 32),
    Buffer.alloc(513, 32),
    phaseBytes([]),
    phaseBytes(phases.slice(0, 2)),
    phaseBytes([...earlyOperations(31), barrier(1, 31), barrier(2, 31)]),
  ];
  for (const operation of [0, 33, 1.5, Number.MAX_SAFE_INTEGER])
    badPhases.push(
      phaseBytes([phases[0], { event: 'HANDLER_ENTER', operation }]),
    );
  const badControls = [
    controlBytes([{ event: 'BARRIER', sequence: 2 }]),
    controlBytes([controls[0], controls[0]]),
    controlBytes([controls[1]]),
    controlBytes([controls[0], controls[1], controls[1]]),
    controlBytes([controls[0], { event: 'RELEASE_READ_IO', operation: 2 }]),
    controlBytes([
      { event: 'BARRIER', sequence: 1, result: 'PRIVATE_SENTINEL' },
    ]),
    controlBytes([{ event: 'BARRIER', sequence: 9 }]),
    controlBytes([{ event: 'BARRIER', sequence: 0 }]),
    controlBytes([{ event: 'BARRIER', sequence: 1.5 }]),
    controlBytes([{ event: 'BARRIER' }]),
    controlBytes([{ event: 'ABORT', operation: 1 }]),
    Buffer.from('{"event":"BARRIER","sequence":1,"sequence":1}\n'),
    Buffer.from('{"event":"BARRIER","sequence":1}'),
    Buffer.from([0xc3, 0x28, 10]),
    Buffer.alloc(129, 32),
    Buffer.alloc(2_049, 32),
    controlBytes(Array.from({ length: 17 }, () => controls[0])),
  ];
  const fixture = {
    phase: phaseBytes(phases).toString('base64'),
    control: controlBytes(controls).toString('base64'),
    badPhases: badPhases.map((bytes) => bytes.toString('base64')),
    badControls: badControls.map((bytes) => bytes.toString('base64')),
  };
  const path = join(directory, 'finite-streams.json');
  const saved = save(path, fixture);
  const readback: typeof fixture = JSON.parse(saved.bytes.toString('utf8'));
  for (const sizes of [[1], [2, 17, 3, 89], [16_384]]) {
    const phase = new HistoryPhaseDecoder();
    const control = new HistoryControlDecoder();
    const decodedControls = [];
    for (const chunk of fragments(Buffer.from(readback.phase, 'base64'), sizes))
      phase.push(chunk);
    for (const chunk of fragments(
      Buffer.from(readback.control, 'base64'),
      sizes,
    ))
      decodedControls.push(...control.push(chunk));
    phase.finish();
    control.finish();
    expect(phase.events).toEqual(phases);
    expect(decodedControls).toEqual(controls);
    expect(Object.isFrozen(phase.events)).toBe(true);
    expect(phase.events.every(Object.isFrozen)).toBe(true);
  }
  for (const [channel, cases] of [
    ['phase', readback.badPhases],
    ['control', readback.badControls],
  ] as const) {
    for (const encoded of cases) {
      for (const sizes of [[1, 11, 2], [16_385]]) {
        const decoder =
          channel === 'phase'
            ? new HistoryPhaseDecoder()
            : new HistoryControlDecoder();
        expect(() => {
          for (const chunk of fragments(Buffer.from(encoded, 'base64'), sizes))
            decoder.push(chunk);
          decoder.finish();
        }).toThrow(HISTORY_PROTOCOL_ERROR);
      }
    }
  }
  // Inclusive line and total UTF-8 byte boundaries, independently padded on wire.
  const padded = (line: string, bytes: number) => {
    const body = line.slice(0, -1);
    return Buffer.from(
      body + ' '.repeat(bytes - Buffer.byteLength(body) - 1) + '\n',
    );
  };
  const exactLine = new HistoryPhaseDecoder();
  exactLine.push(padded(phaseBytes([phases[0]]).toString(), 512));
  exactLine.finish();
  const tooLong = new HistoryPhaseDecoder();
  expect(() =>
    tooLong.push(padded(phaseBytes([phases[0]]).toString(), 513)),
  ).toThrow(HISTORY_PROTOCOL_ERROR);
  const totalEvents = [...earlyOperations(15), barrier(1, 15)];
  expect(totalEvents.length).toBe(32);
  const exactBytes = Buffer.concat(
    totalEvents.map((event) => padded(phaseBytes([event]).toString(), 512)),
  );
  expect(exactBytes.byteLength).toBe(16_384);
  const exactTotal = new HistoryPhaseDecoder();
  exactTotal.push(exactBytes);
  exactTotal.finish();
  const overTotal = new HistoryPhaseDecoder();
  overTotal.push(exactBytes);
  expect(() => overTotal.push(Buffer.from('\n'))).toThrow(
    HISTORY_PROTOCOL_ERROR,
  );
  const exactCount = new HistoryPhaseDecoder();
  exactCount.push(phaseBytes([...earlyOperations(31), barrier(1, 31)]));
  exactCount.finish();
  expect(exactCount.events.length).toBe(64);
  const exactControl = new HistoryControlDecoder();
  exactControl.push(padded(controlBytes([controls[0]]).toString(), 128));
  exactControl.finish();
  const overControl = new HistoryControlDecoder();
  expect(() =>
    overControl.push(padded(controlBytes([controls[0]]).toString(), 129)),
  ).toThrow(HISTORY_PROTOCOL_ERROR);
  const sequences = new HistoryControlDecoder();
  expect(
    sequences.push(
      controlBytes(
        Array.from({ length: 8 }, (_, i) => ({
          event: 'BARRIER',
          sequence: i + 1,
        })),
      ),
    ).length,
  ).toBe(8);
  sequences.finish();

  const waiting = new HistoryPhaseDecoder();
  const ready = waiting.waitFor({ event: 'BOOT_READY' });
  const bytes = phaseBytes([phases[0]]);
  waiting.push(bytes.subarray(0, 4));
  waiting.push(bytes.subarray(4));
  expect(await ready).toEqual({ event: 'BOOT_READY' });
  expect(await waiting.waitFor({ event: 'BOOT_READY' })).toEqual({
    event: 'BOOT_READY',
  });
  waiting.finish();
  const eof = new HistoryPhaseDecoder();
  const eofWait = eof
    .waitFor({ event: 'BOOT_READY' })
    .catch((error: Error) => error.message);
  expect(() => eof.finish()).toThrow(HISTORY_PROTOCOL_ERROR);
  expect(await eofWait).toBe(HISTORY_PROTOCOL_ERROR);
  const malformed = new HistoryPhaseDecoder();
  const malformedWait = malformed
    .waitFor({ event: 'BOOT_READY' })
    .catch((error: Error) => error.message);
  expect(() => malformed.push(Buffer.from('private\n'))).toThrow(
    HISTORY_PROTOCOL_ERROR,
  );
  expect(await malformedWait).toBe(HISTORY_PROTOCOL_ERROR);
  const timeout = new HistoryPhaseDecoder();
  await expect(timeout.waitFor({ event: 'BOOT_READY' }, 1)).rejects.toThrow(
    HISTORY_PROTOCOL_ERROR,
  );
  timeout.push(phaseBytes([phases[0]]));
  timeout.finish();
  const bounded = new HistoryPhaseDecoder();
  const eight = Array.from({ length: 8 }, () =>
    bounded.waitFor({ event: 'BOOT_READY' }),
  );
  await expect(bounded.waitFor({ event: 'BOOT_READY' })).rejects.toThrow(
    HISTORY_PROTOCOL_ERROR,
  );
  bounded.push(phaseBytes([phases[0]]));
  expect((await Promise.all(eight)).length).toBe(8);
  bounded.finish();
  expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(
    saved.sha256,
  );
  save(join(directory, 'receipt.json'), {
    case: 'GRH-SANITY-01',
    result: 'passed',
    fixture: path,
    sha256: saved.sha256,
    validFragmentPatterns: 3,
    negativePhaseStreams: badPhases.length,
    negativeControlStreams: badControls.length,
    nativeEntries: 0,
    sdkEntries: 0,
    socketEntries: 0,
    httpAttempts: 0,
    limits:
      'Control sequence/release grammar permits at most 9 unique frames, below the independent 16-frame/2048-byte defensive ceilings.',
  });
});

test('GRH-SANITY-02 exact source child sanity entry consumes saved bounded fixture and exits without native resources', async () => {
  const { directory, home, temporary } = root();
  const fixture = join(directory, 'phase-sanity.json');
  const saved = save(fixture, {
    version: 1,
    phaseChunks: fragments(phaseBytes(phases), [7, 2, 41]).map((bytes) =>
      bytes.toString('base64'),
    ),
    controlChunks: fragments(controlBytes(controls), [1, 17, 9]).map((bytes) =>
      bytes.toString('base64'),
    ),
  });
  const entry = fileURLToPath(
    new URL('./fixtures/get-retry-history-sdk-child.ts', import.meta.url),
  );
  const command = [
    process.execPath,
    '--no-env-file',
    entry,
    '--phase-sanity',
    fixture,
  ];
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    TMPDIR: temporary,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    NO_COLOR: '1',
  };
  const resources = {
    spawned: false,
    reaped: false,
    exitCode: null as number | null,
    signalCode: null as string | number | null,
    killedForCleanup: false,
    stdoutEOF: false,
    stderrEOF: false,
    stdoutReaderClosed: false,
    stderrReaderClosed: false,
    stdoutReaderReleased: false,
    stderrReaderReleased: false,
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const drains: Promise<Buffer>[] = [];
  let completed = false;
  // Cleanup ownership exists before spawn. EOF/closed receipts come only from reads.
  async function cleanup() {
    if (child && !resources.reaped) {
      resources.killedForCleanup = true;
      child.kill('SIGKILL');
      await child.exited;
      resources.reaped = true;
    }
    await Promise.allSettled(drains);
  }
  try {
    // Saved bytes, mode and independent hash are verified before this exact entry.
    expect(readFileSync(fixture).equals(saved.bytes)).toBe(true);
    expect(
      createHash('sha256').update(readFileSync(fixture)).digest('hex'),
    ).toBe(saved.sha256);
    child = Bun.spawn(command, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    resources.spawned = true;
    if (
      !(child.stdout instanceof ReadableStream) ||
      !(child.stderr instanceof ReadableStream)
    )
      throw new Error('Expected owned fixture pipes.');
    async function drain(
      stream: ReadableStream<Uint8Array>,
      kind: 'stdout' | 'stderr',
    ) {
      const reader = stream.getReader();
      readers.push(reader);
      const closed = reader.closed;
      void closed.catch(() => undefined);
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            resources[`${kind}EOF`] = true;
            break;
          }
          total += next.value.byteLength;
          if (total > 4_096) throw new Error('Unexpected fixture pipe size.');
          chunks.push(Buffer.from(next.value));
        }
        await closed;
        resources[`${kind}ReaderClosed`] = true;
        return Buffer.concat(chunks);
      } finally {
        reader.releaseLock();
        resources[`${kind}ReaderReleased`] = true;
      }
    }
    drains.push(drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr'));
    // Deadline bounds hangs; it is not synchronization or a product deadline.
    const timer = setTimeout(() => child?.kill('SIGKILL'), 10_000);
    let output: Buffer[];
    try {
      const [code, pipes] = await Promise.all([
        child.exited,
        Promise.all(drains),
      ]);
      resources.exitCode = code;
      resources.signalCode = child.signalCode;
      resources.reaped = true;
      output = pipes;
    } finally {
      clearTimeout(timer);
    }
    expect(resources.exitCode).toBe(0);
    expect(resources.signalCode).toBeNull();
    expect(output[0]?.byteLength).toBe(0);
    const expected = {
      event: 'SANITY_COMPLETE',
      phaseEvents: 8,
      controlFrames: 3,
      nativeEntries: 0,
      sdkEntries: 0,
      socketEntries: 0,
      httpAttempts: 0,
    };
    const stderr = new TextDecoder('utf-8', { fatal: true }).decode(output[1]);
    expect(stderr).toBe(
      HISTORY_SANITY_PREFIX + JSON.stringify(expected) + '\n',
    );
    expect(resources.stdoutEOF && resources.stderrEOF).toBe(true);
    expect(resources.stdoutReaderClosed && resources.stderrReaderClosed).toBe(
      true,
    );
    expect(
      resources.stdoutReaderReleased && resources.stderrReaderReleased,
    ).toBe(true);
    expect(readers.length).toBe(2);
    expect(resources.killedForCleanup).toBe(false);
    expect(
      createHash('sha256').update(readFileSync(fixture)).digest('hex'),
    ).toBe(saved.sha256);
    save(join(directory, 'receipt.json'), {
      case: 'GRH-SANITY-02',
      result: 'passed',
      command,
      environment,
      fixture,
      sha256: saved.sha256,
      stderr,
      resources,
      entryCounters: expected,
      proofBoundary:
        'Actual exact entry, closed pipe reads, exit and guarded entry counters plus static dispatch/import inspection; no OS syscall tracing or product/native journey claimed.',
    });
    completed = true;
  } finally {
    await cleanup();
    if (!completed)
      save(join(directory, 'failure-resources.json'), {
        case: 'GRH-SANITY-02',
        result: 'failed preparation; no product evidence',
        command,
        fixture,
        resources,
      });
  }
}, 15_000);
