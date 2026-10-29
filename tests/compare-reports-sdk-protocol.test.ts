import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { bounded } from './helpers';
import {
  CompareLines,
  ComparePhaseDecoder,
  CompareControlDecoder,
  parseComparePhase,
  parseCompareControl,
  COMPARE_PHASE_PREFIX,
  COMPARE_SANITY_PREFIX,
  COMPARE_PROTOCOL_ERROR,
} from './fixtures/compare-reports-sdk-protocol';
const barrier = {
  event: 'BARRIER',
  sequence: 1,
  handlers: 0,
  readsEntered: 0,
  readsSettled: 0,
  cancelsSettled: 0,
  releases: 0,
  clientsSettled: 0,
  closes: 0,
  ownersSettled: 0,
  httpAttempts: 0,
};
const boot = { event: 'BOOT_READY' };
const phase = (v: unknown) =>
  Buffer.from(COMPARE_PHASE_PREFIX + JSON.stringify(v) + '\n');
const control = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
function chunks(bytes: Buffer) {
  return Array.from(bytes, (byte) => Buffer.from([byte]));
}
function bad(run: () => void) {
  assert.throws(run, new RegExp(COMPARE_PROTOCOL_ERROR.replace('.', '\\.')));
}

test('CR-C3-P01.A fragmented/coalesced finite phases and controls preserve exact witnesses', () => {
  const events = [
    boot,
    { event: 'HANDLER_ENTER', operation: 1 },
    { event: 'READ_PENDING', operation: 1 },
    { event: 'SIGNAL_ABORTED', operation: 1 },
    { event: 'NATIVE_CANCEL', operation: 1, outcome: 'rejected' },
    { event: 'READ_SETTLED', operation: 1, outcome: 'rejected' },
    { event: 'NATIVE_CLOSED', operation: 1, outcome: 'rejected' },
    { event: 'READER_RELEASED', operation: 1 },
    { event: 'CLIENT_SETTLED', operation: 1, outcome: 'rejected' },
    { event: 'AFTER_CLOSE', operation: 1 },
    {
      event: 'OWNER_SETTLED',
      operation: 1,
      aborted: true,
      status: 'error',
      code: 'Cancelled',
      cancelledEnvelope: true,
    },
    {
      ...barrier,
      handlers: 1,
      ownersSettled: 1,
      readsEntered: 2,
      readsSettled: 2,
      cancelsSettled: 1,
      releases: 1,
      clientsSettled: 1,
      closes: 1,
      httpAttempts: 1,
    },
  ];
  const bytes = Buffer.concat(events.map(phase));
  for (const parts of [[bytes], chunks(bytes)]) {
    const parser = new ComparePhaseDecoder();
    for (const part of parts) parser.push(part);
    parser.finish();
    assert.deepEqual(parser.events, events);
    bad(() => parser.push(phase(boot)));
  }
  const commands = [
    { event: 'BARRIER', sequence: 1 },
    { event: 'BARRIER', sequence: 2 },
    { event: 'RELEASE_CANCEL', operation: 1 },
  ];
  const parser = new CompareControlDecoder();
  const received = chunks(Buffer.concat(commands.map(control))).flatMap((p) =>
    parser.push(p),
  );
  parser.finish();
  assert.deepEqual(received, commands);
  const unicode = new CompareLines(
    512,
    16_384,
    64,
    (s) => JSON.parse(s) as unknown,
  );
  const value = chunks(Buffer.from('"é☃"\n')).flatMap((p) => unicode.push(p));
  unicode.finish();
  assert.deepEqual(value, ['é☃']);
});

test('CR-C3-P01.A strict keys, duplicate spellings, enums and operation/sequence bounds', () => {
  for (const line of [
    '{"event":"BOOT_READY","event":"BOOT_READY"}',
    '{"event":"BOOT_READY","\\u0065vent":"BOOT_READY"}',
    '{"event":"BOOT_READY","extra":0}',
    '{"event":"unknown"}',
    'null',
    '[]',
    '{"event":"HANDLER_ENTER","operation":0}',
    '{"event":"HANDLER_ENTER","operation":33}',
    '{"event":"READ_SETTLED","operation":1,"outcome":"invented"}',
    '{"event":"OWNER_SETTLED","operation":1,"status":"compared","code":"Cancelled","aborted":true,"cancelledEnvelope":true}',
  ])
    bad(() => parseComparePhase(COMPARE_PHASE_PREFIX + line));
  assert.deepEqual(
    parseComparePhase(
      COMPARE_PHASE_PREFIX + '{"event":"HANDLER_ENTER","operation":32}',
    ),
    { event: 'HANDLER_ENTER', operation: 32 },
  );
  for (const line of [
    '{"event":"BARRIER","sequence":0}',
    '{"event":"BARRIER","sequence":9}',
    '{"event":"RELEASE_CANCEL","operation":2}',
    '{"event":"BARRIER","sequence":1,"sequence":1}',
    '{"event":"BARRIER","sequence":1,"extra":1}',
  ])
    bad(() => parseCompareControl(line));
  assert.deepEqual(parseCompareControl('{"event":"BARRIER","sequence":8}'), {
    event: 'BARRIER',
    sequence: 8,
  });
  const duplicate = new CompareControlDecoder();
  duplicate.push(control({ event: 'BARRIER', sequence: 1 }));
  bad(() => duplicate.push(control({ event: 'BARRIER', sequence: 1 })));
  const release = new CompareControlDecoder();
  bad(() => release.push(control({ event: 'RELEASE_CANCEL', operation: 1 })));
  const repeated = new CompareControlDecoder();
  repeated.push(
    Buffer.concat([
      control({ event: 'BARRIER', sequence: 1 }),
      control({ event: 'RELEASE_CANCEL', operation: 1 }),
    ]),
  );
  bad(() => repeated.push(control({ event: 'RELEASE_CANCEL', operation: 1 })));
});

test('CR-C3-P01.A malformed UTF8, incomplete EOF, order and repeated witnesses fail closed', () => {
  for (const bytes of [
    Buffer.from([0xff, 10]),
    Buffer.from([0xc3, 10]),
    Buffer.from(COMPARE_PHASE_PREFIX + '{"event":"BOOT_READY"}\r\n'),
  ]) {
    const p = new ComparePhaseDecoder();
    bad(() => p.push(bytes));
    bad(() => p.finish());
  }
  const tail = new ComparePhaseDecoder();
  tail.push(phase(boot));
  tail.push(Buffer.from('partial'));
  bad(() => tail.finish());
  for (const events of [
    [boot, boot],
    [{ event: 'HANDLER_ENTER', operation: 1 }],
    [boot, { event: 'HANDLER_ENTER', operation: 2 }],
    [
      boot,
      { event: 'HANDLER_ENTER', operation: 1 },
      { event: 'READ_PENDING', operation: 1 },
      { event: 'READ_PENDING', operation: 1 },
    ],
    [
      boot,
      { event: 'HANDLER_ENTER', operation: 1 },
      {
        event: 'OWNER_SETTLED',
        operation: 1,
        status: 'error',
        code: 'Cancelled',
        aborted: true,
        cancelledEnvelope: true,
      },
    ],
    [boot, { ...barrier, sequence: 2 }],
  ]) {
    const p = new ComparePhaseDecoder();
    bad(() => p.push(Buffer.concat(events.map(phase))));
  }
  const active = new ComparePhaseDecoder();
  active.push(
    Buffer.concat([
      phase(boot),
      phase({ event: 'HANDLER_ENTER', operation: 1 }),
    ]),
  );
  bad(() => active.finish());
  const partial = new CompareControlDecoder();
  partial.push(Buffer.from('{"event":'));
  bad(() => partial.finish());
});

test('CR-C3-P01.A inclusive line/total/frame byte ceilings and permanent failure latch', () => {
  for (const [line, total, count] of [
    [512, 16_384, 64],
    [128, 2_048, 16],
  ]) {
    const p = new CompareLines(line!, total!, count!, (s) => s);
    assert.equal(
      p.push(Buffer.from('x'.repeat(line! - 1) + '\n'))[0]!.length,
      line! - 1,
    );
    p.finish();
    const over = new CompareLines(line!, total!, count!, (s) => s);
    bad(() => over.push(Buffer.from('x'.repeat(line!) + '\n')));
    bad(() => over.push(Buffer.from('x\n')));
    const whole = new CompareLines(line!, total!, count!, (s) => s);
    const exact = Buffer.from(
      ('x'.repeat(line! - 1) + '\n').repeat(total! / line!),
    );
    assert.equal(exact.length, total);
    whole.push(exact);
    whole.finish();
    const overflow = new CompareLines(line!, total!, count!, (s) => s);
    bad(() => overflow.push(Buffer.concat([exact, Buffer.from('\n')])));
    const frames = new CompareLines(line!, total!, count!, (s) => s);
    assert.equal(frames.push(Buffer.from('x\n'.repeat(count!))).length, count);
    bad(() => frames.push(Buffer.from('x\n')));
  }
});

for (const { label, valid, invalid } of [
  {
    label: 'event',
    valid: {
      event: 'FIXTURE_ERROR',
    },
    invalid: {
      event: ['FIXTURE_ERROR'],
    },
  },
  {
    label: 'error-code',
    valid: {
      event: 'OWNER_SETTLED',
      operation: 1,
      aborted: false,
      status: 'error',
      code: 'ReadFailed',
      cancelledEnvelope: false,
    },
    invalid: {
      event: 'OWNER_SETTLED',
      operation: 1,
      aborted: false,
      status: 'error',
      code: ['ReadFailed'],
      cancelledEnvelope: false,
    },
  },
  {
    label: 'blocker-code',
    valid: {
      event: 'OWNER_SETTLED',
      operation: 1,
      aborted: false,
      status: 'blocked',
      code: 'StatusUnavailable',
      cancelledEnvelope: false,
    },
    invalid: {
      event: 'OWNER_SETTLED',
      operation: 1,
      aborted: false,
      status: 'blocked',
      code: ['StatusUnavailable'],
      cancelledEnvelope: false,
    },
  },
] as const)
  test(`CR-C3-P01.A reject coercible ${label}`, () => {
    assert.deepEqual(
      parseComparePhase(COMPARE_PHASE_PREFIX + JSON.stringify(valid)),
      valid,
    );
    assert.throws(
      () => parseComparePhase(COMPARE_PHASE_PREFIX + JSON.stringify(invalid)),
      new Error(COMPARE_PROTOCOL_ERROR),
    );
  });

test('CR-C3-P01.B exact child --sanity exits naturally with bounded receipt and both native pipe EOF/closed/release', async () => {
  const root = mkdtempSync(join(realpathSync('/tmp'), 'crsan-'));
  const saved = join(root, 'saved'),
    home = join(root, 'home');
  mkdirSync(saved, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  const file = join(saved, 'fixture.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      phaseChunks: [
        phase(boot).subarray(0, 3),
        phase(boot).subarray(3),
        phase(barrier),
      ].map((p) => p.toString('base64')),
      controlChunks: [
        Buffer.concat([
          control({ event: 'BARRIER', sequence: 1 }),
          control({ event: 'RELEASE_CANCEL', operation: 1 }),
        ]).toString('base64'),
      ],
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      'tests/fixtures/compare-reports-sdk-child.ts',
      '--sanity',
      file,
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
        HOME: home,
        TMPDIR: root,
        TZ: 'UTC',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const errors: unknown[] = [];
  async function drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const nativeClosed = reader.closed;
    void nativeClosed.catch(() => undefined);
    const parts: Uint8Array[] = [];
    let total = 0;
    let eof: boolean;
    let released: boolean;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          eof = true;
          break;
        }
        total += part.value.byteLength;
        assert(total <= 16_384);
        parts.push(part.value);
      }
      await nativeClosed;
    } finally {
      reader.releaseLock();
      released = true;
    }
    assert(eof && released);
    return Buffer.concat(parts);
  }
  const output = drain(child.stdout),
    stderr = drain(child.stderr);
  void output.catch(() => undefined);
  void stderr.catch(() => undefined);
  try {
    await child.stdin.end();
    assert.equal(await bounded(child.exited, 5000), 0);
    assert.equal(child.signalCode, null);
    assert.equal((await bounded(output)).length, 0);
    assert.equal(
      (await bounded(stderr)).toString(),
      COMPARE_SANITY_PREFIX +
        JSON.stringify({
          event: 'SANITY_COMPLETE',
          phaseEvents: 2,
          controlFrames: 2,
          nativeEntries: 0,
          sdkEntries: 0,
          socketEntries: 0,
          httpAttempts: 0,
        }) +
        '\n',
    );
  } catch (e) {
    errors.push(e);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    const cleanup = await Promise.allSettled([child.exited, output, stderr]);
    for (const r of cleanup) if (r.status === 'rejected') errors.push(r.reason);
    if (!errors.length) rmSync(root, { recursive: true });
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Comparison sanity fixture retained ${root}`,
    );
}, 10000);
