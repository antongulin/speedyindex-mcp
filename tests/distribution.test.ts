import { expect, test } from 'bun:test';
import { Database, constants } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { balanceResultSchema, listTasksResultSchema } from '../src/client';
import { createIndexingTaskResultSchema } from '../src/create-indexing-task';
import { taskStatusResultSchema } from '../src/task-status';
import { taskReportOutputSchema } from '../src/task-report';
import { account, bounded, connect, dummyKey, fixture } from './helpers';
import { verifyEof } from './stdio-eof';

test('LT-08: built CLI registers and calls all four read-only tools', async () => {
  const reportBodies: string[] = [];
  const api = await fixture((req, res) => {
    if (req.url === '/v2/account') {
      res.end(JSON.stringify(account));
      return;
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      void (async () => {
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url?.endsWith('/report')) {
          reportBodies.push(body);
          const { task_id: taskId } = JSON.parse(body) as { task_id: string };
          res.end(
            JSON.stringify({
              code: 0,
              result: {
                id: taskId,
                size: 1,
                processed_count: 1,
                indexed_links: ['https://built.test/result?keep=1/'],
                unindexed_links: [],
                type: 'google/indexer',
                title: 'synthetic built report',
                created_at: '2026-10-20T10:00:00.000Z',
              },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ code: 0, result: { id: 'built-status' } }));
      })();
      return;
    }
    const page = Number(
      new URL(req.url ?? '/', 'http://fixture').pathname.split('/').at(-1),
    );
    res.end(
      JSON.stringify({
        code: 0,
        page,
        last_page: 0,
        result: [{ id: 'task-a' }],
      }),
    );
  });
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  const sessions: (() => Promise<void>)[] = [];
  const failures: unknown[] = [];
  try {
    session = await connect(api.origin, 'dist/cli.js', dummyKey, '', {
      register: (close) => sessions.push(close),
    });
    expect(session.client.getServerVersion()?.name).toBe('speedyindex-mcp');
    expect(
      (await session.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual([
      'get_balance',
      'list_tasks',
      'get_task_status',
      'get_task_report',
      'create_indexing_task',
    ]);
    const result = await session.client.callTool({
      name: 'get_balance',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(balanceResultSchema.parse(result.structuredContent).balance).toEqual(
      account.balance,
    );
    const listResult = await session.client.callTool({
      name: 'list_tasks',
      arguments: { searchEngine: 'yandex', taskType: 'checker', page: 0 },
    });
    expect(listResult.isError).not.toBe(true);
    expect(
      listTasksResultSchema.parse(listResult.structuredContent).tasks,
    ).toEqual([{ id: 'task-a' }]);
    const statusResult = await session.client.callTool({
      name: 'get_task_status',
      arguments: { family: 'backlink/checker', taskId: 'built-status' },
    });
    expect(statusResult.isError).not.toBe(true);
    expect(
      taskStatusResultSchema.parse(statusResult.structuredContent),
    ).toEqual({
      family: 'backlink/checker',
      requestedIds: ['built-status'],
      tasks: [{ id: 'built-status' }],
      unreturnedIds: [],
    });
    const reportResult = await session.client.callTool({
      name: 'get_task_report',
      arguments: { family: 'google/indexer', taskId: 'built-report' },
    });
    expect(reportResult.isError).not.toBe(true);
    const parsedReport = taskReportOutputSchema.parse(
      reportResult.structuredContent,
    );
    expect(parsedReport).toEqual({
      family: 'google/indexer',
      reportKind: 'links',
      taskId: 'built-report',
      size: 1,
      processedCount: 1,
      indexedLinks: ['https://built.test/result?keep=1/'],
      unindexedLinks: [],
      type: 'google/indexer',
      title: 'synthetic built report',
      createdAt: '2026-10-20T10:00:00.000Z',
    });
    expect(reportResult.content).toEqual([
      { type: 'text', text: JSON.stringify(parsedReport) },
    ]);
    expect(session.stderr()).toBe('');
    expect(reportBodies).toEqual([JSON.stringify({ task_id: 'built-report' })]);
    expect(api.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/v2/account' },
      { method: 'GET', path: '/v2/task/yandex/checker/list/0' },
      { method: 'POST', path: '/v2/task/backlink/checker/status' },
      { method: 'POST', path: '/v2/task/google/indexer/report' },
    ]);
  } catch (error) {
    failures.push(error);
  }
  const closed = await Promise.allSettled([
    ...sessions.map((close) => close()),
    api.close(),
  ]);
  for (const result of closed)
    if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length)
    throw new AggregateError(failures, 'Built read journey failed.');
});

test('F09: built CLI exits naturally on stdin EOF', async () => {
  await verifyEof('dist/cli.js');
});

async function withBuiltSubmission(
  operation: (h: {
    root: string;
    api: Awaited<ReturnType<typeof fixture>>;
    receipts: {
      body: string;
      contentType: string | undefined;
      accept: string | undefined;
    }[];
    open: (args?: string[], key?: string) => ReturnType<typeof connect>;
    local: (
      args: string[],
      key?: string,
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  }) => Promise<void>,
) {
  const temporaryParent = realpathSync(tmpdir());
  const root = realpathSync(
    mkdtempSync(join(temporaryParent, 'speedyindex-built-')),
  );
  chmodSync(root, 0o700);
  const home = realpathSync(
    mkdtempSync(join(temporaryParent, 'speedyindex-built-home-')),
  );
  chmodSync(home, 0o700);
  const receipts: {
    body: string;
    contentType: string | undefined;
    accept: string | undefined;
  }[] = [];
  const receivers: Promise<void>[] = [];
  const api = await fixture((req, res) => {
    const receiving = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      receipts.push({
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: req.headers['content-type'],
        accept: req.headers.accept,
      });
      res.end(
        JSON.stringify(
          receipts.length === 1
            ? {
                code: 0,
                task_id: ' opaque built provider ID /? ',
                type: 'google/indexer',
                pay_per_indexed: true,
                drip_feed: false,
              }
            : {
                code: 0,
                result: { task_id: 'nested-id-is-not-an-ack' },
                type: 'google/indexer',
                message: 'private-provider-diagnostic',
              },
        ),
      );
    })();
    receivers.push(receiving);
    void receiving.catch(() => res.destroy());
  });
  const sessions: (() => Promise<void>)[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const reads: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  try {
    await operation({
      root,
      api,
      receipts,
      open: (args = [], key = dummyKey) =>
        connect(api.origin, 'dist/cli.js', key, '', {
          args,
          register: (close) => sessions.push(close),
        }),
      async local(args, key) {
        const child = Bun.spawn(
          [
            process.execPath,
            '--no-env-file',
            '--preload',
            './tests/fixtures/redirect-fetch.ts',
            'dist/cli.js',
            ...args,
          ],
          {
            env: {
              HOME: home,
              TEST_ACCOUNT_ORIGIN: api.origin,
              ...(key === undefined ? {} : { SPEEDYINDEX_API_KEY: key }),
            },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        children.push(child); // own the child before reads or startup writes
        const reading = Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        reads.push(reading);
        const [code, stdout, stderr] = await bounded(reading, 8_000);
        return { code, stdout, stderr };
      },
    });
  } catch (error) {
    failures.push(error);
  }
  const closed = await Promise.allSettled([
    ...sessions.map((close) => close()),
    ...children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await bounded(child.exited, 5_000);
    }),
  ]);
  const cleanup: unknown[] = [];
  for (const result of closed)
    if (result.status === 'rejected') cleanup.push(result.reason);
  try {
    await api.close();
  } catch (error) {
    cleanup.push(error);
  }
  try {
    const settled = await bounded(
      Promise.allSettled([...reads, ...receivers]),
      5_000,
    );
    for (const result of settled)
      if (result.status === 'rejected') cleanup.push(result.reason);
  } catch (error) {
    cleanup.push(error);
  }
  if (cleanup.length)
    throw new AggregateError(
      [...failures, ...cleanup],
      `Built cleanup failed; preserving owned roots ${root} and ${home}.`,
    );
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (failures.length) throw failures[0];
}

test('C15 BUILT: five-tool schemas, paid annotations, no-key preview, disabled submit and SDK input rejection', async () => {
  await withBuiltSubmission(async (h) => {
    const session = await h.open([], '');
    const { tools } = await bounded(session.client.listTools());
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_balance',
      'list_tasks',
      'get_task_status',
      'get_task_report',
      'create_indexing_task',
    ]);
    const create = tools[4]!;
    expect(create.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(create.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'searchEngine', 'urls'],
    });
    expect(create.inputSchema.properties?.mode).toEqual({
      type: 'string',
      enum: ['preview', 'submit'],
    });
    expect(create.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    const input = {
      mode: 'preview',
      searchEngine: 'google',
      urls: ['https://built.test/no-key'],
    };
    const preview = await bounded(
      session.client.callTool({
        name: 'create_indexing_task',
        arguments: input,
      }),
    );
    const parsed = createIndexingTaskResultSchema.parse(
      preview.structuredContent,
    );
    expect(preview.isError).toBe(false);
    expect(parsed.status).toBe('preview');
    expect(parsed.authorization).toEqual({
      state: 'unconfigured',
      stateChecked: false,
    });
    expect(parsed.quote?.maximumExposure).toEqual({
      tokens: 100,
      indexer: 0,
      checker: 0,
    });
    expect(preview.content).toEqual([
      { type: 'text', text: JSON.stringify(parsed) },
    ]);
    const blocked = await bounded(
      session.client.callTool({
        name: 'create_indexing_task',
        arguments: { ...input, mode: 'submit', requestId: 'built-disabled' },
      }),
    );
    const parsedBlocked = createIndexingTaskResultSchema.parse(
      blocked.structuredContent,
    );
    expect(blocked.isError).toBe(true);
    expect(parsedBlocked.status).toBe('blocked');
    expect(parsedBlocked.error).toEqual({
      code: 'WritesDisabled',
      message: 'Indexing submissions are disabled.',
    });
    expect(blocked.content).toEqual([
      { type: 'text', text: JSON.stringify(parsedBlocked) },
    ]);
    for (const invalid of [
      { searchEngine: 'google', urls: input.urls },
      { ...input, mode: 'submit' },
      { ...input, caps: { tokens: 1, indexer: 1, checker: 1 } },
    ]) {
      const rejected = await bounded(
        session.client.callTool({
          name: 'create_indexing_task',
          arguments: invalid,
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
    }
    for (const arg of ['--help', '--version']) {
      const result = await h.local([arg]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      if (arg === '--version') expect(result.stdout).toBe('0.1.0\n');
      else for (const tool of tools) expect(result.stdout).toContain(tool.name);
    }
    expect(session.stderr()).toBe('');
    expect(h.api.requests).toHaveLength(0);
    expect(h.receipts).toHaveLength(0);
  });
}, 30_000);

test('C15 BUILT: explicit local setup, one accepted POST, restart replay, bad acknowledgement and malformed ACK held safely', async () => {
  await withBuiltSubmission(async (h) => {
    const state = join(h.root, 'state');
    expect(await h.local(['--init-submission-state', state])).toEqual({
      code: 0,
      stdout: '{"initialized":true,"schemaVersion":1}\n',
      stderr: '',
    });
    const fingerprint = await h.local(
      ['--submission-credential-fingerprint'],
      `  ${dummyKey}  `,
    );
    const expectedFingerprint = createHash('sha256')
      .update(`speedyindex-credential-v1\0${dummyKey}`)
      .digest('hex');
    expect(fingerprint).toEqual({
      code: 0,
      stdout: `${expectedFingerprint}\n`,
      stderr: '',
    });
    const policyPath = join(h.root, 'policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'caller_acknowledgement',
        policyRevision: 'synthetic-built-v1',
        budgetScope: 'synthetic-built-scope',
        credentialFingerprint: expectedFingerprint,
        period: { kind: 'utc_day' },
        caps: { tokens: 1000, indexer: 0, checker: 0 },
      }),
      { mode: 0o600 },
    );
    const args = [
      '--submission-policy',
      policyPath,
      '--submission-state',
      state,
    ];
    let session = await h.open(args);
    expect((await bounded(session.client.listTools())).tools).toHaveLength(5);
    async function call(input: Record<string, unknown>) {
      const result = await bounded(
        session.client.callTool({
          name: 'create_indexing_task',
          arguments: input,
        }),
        8_000,
      );
      // SDK2.3.1 skips output-schema validation on isError results.
      const parsed = createIndexingTaskResultSchema.parse(
        result.structuredContent,
      );
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(parsed) },
      ]);
      const json = JSON.stringify(result);
      for (const privateValue of [
        dummyKey,
        expectedFingerprint,
        h.root,
        'private-provider-diagnostic',
        'nested-id-is-not-an-ack',
        '  synthetic built title  ',
      ])
        expect(json).not.toContain(privateValue);
      expect(result.isError).toBe(
        !['preview', 'accepted'].includes(parsed.status),
      );
      return parsed;
    }
    const input = {
      searchEngine: 'google',
      urls: ['https://built.test/a?keep=%2f#Part'],
      title: '  synthetic built title  ',
    };
    const preview = await call({ ...input, mode: 'preview' });
    expect(preview.authorization).toMatchObject({
      state: 'configured',
      mode: 'caller_acknowledgement',
      stateChecked: false,
    });
    const acknowledgement = {
      quoteFingerprint: preview.quote!.fingerprint,
      authorizationFingerprint: preview.authorization!.fingerprint!,
    };
    const submit = {
      ...input,
      mode: 'submit',
      requestId: 'built-accepted',
      acknowledgement,
    };
    const accepted = await call(submit);
    expect(accepted.status).toBe('accepted');
    expect(accepted.intent).toMatchObject({
      state: 'accepted',
      stateVersion: 2,
      providerTaskId: ' opaque built provider ID /? ',
      providerType: 'google/indexer',
      reservation: { tokens: 100, indexer: 0, checker: 0 },
    });
    expect(accepted.authorization?.stateChecked).toBe(true);
    expect(accepted.observation).toEqual({
      kind: 'accepted_ack',
      recorded: true,
      taskId: ' opaque built provider ID /? ',
      type: 'google/indexer',
    });
    expect(h.receipts).toEqual([
      {
        body: '{"title":"  synthetic built title  ","urls":["https://built.test/a?keep=%2f#Part"],"pay_per_indexed":true,"drip_feed":false}',
        contentType: 'application/json',
        accept: 'application/json',
      },
    ]);
    expect(session.stderr()).toBe('');
    await session.close();
    session = await h.open(args); // independent current bundle reads durable identity
    const replay = await call(submit);
    expect(replay.status).toBe('accepted');
    expect(replay.replayed).toBe(true);
    expect(replay.intent).toEqual(accepted.intent);
    expect(h.receipts).toHaveLength(1);
    const badInput = {
      searchEngine: 'google',
      urls: ['https://built.test/bad-ack'],
    };
    const badPreview = await call({ ...badInput, mode: 'preview' });
    const badAck = {
      quoteFingerprint: badPreview.quote!.fingerprint,
      authorizationFingerprint: '0'.repeat(64),
    };
    const bad = await call({
      ...badInput,
      mode: 'submit',
      requestId: 'built-bad-ack',
      acknowledgement: badAck,
    });
    expect(bad.status).toBe('blocked');
    expect(bad.error?.code).toBe('AcknowledgementMismatch');
    expect(h.receipts).toHaveLength(1);
    const malformedInput = {
      searchEngine: 'google',
      urls: ['https://built.test/malformed-ack'],
    };
    const malformedPreview = await call({ ...malformedInput, mode: 'preview' });
    const malformedSubmit = {
      ...malformedInput,
      mode: 'submit',
      requestId: 'built-malformed-ack',
      acknowledgement: {
        quoteFingerprint: malformedPreview.quote!.fingerprint,
        authorizationFingerprint: malformedPreview.authorization!.fingerprint!,
      },
    };
    const malformed = await call(malformedSubmit);
    expect(malformed.status).toBe('unknown');
    expect(malformed.error?.code).toBe('OutcomeUnknown');
    expect(malformed.intent).toMatchObject({
      state: 'unknown',
      stateVersion: 2,
    });
    expect(malformed.observation).toEqual({
      kind: 'ambiguous',
      cause: 'invalid_ack',
      recorded: true,
    });
    expect(h.receipts[1]).toEqual({
      body: '{"urls":["https://built.test/malformed-ack"],"pay_per_indexed":true,"drip_feed":false}',
      contentType: 'application/json',
      accept: 'application/json',
    });
    expect((await call(malformedSubmit)).replayed).toBe(true);
    const overlap = await call({
      ...malformedSubmit,
      requestId: 'built-overlap',
    });
    expect(overlap.error?.code).toBe('UrlOverlap');
    expect(h.receipts).toHaveLength(2);
    expect(h.api.requests).toEqual(
      Array.from({ length: 2 }, () => ({
        method: 'POST',
        path: '/v2/task/google/indexer/create',
        auth: dummyKey,
        agent: 'speedyindex-mcp/0.1.0',
      })),
    );
    const db = new Database(
      join(state, 'ledger.sqlite'),
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({
        user_version: 1,
      });
      expect(
        db
          .query(
            'SELECT request_id,state,state_version,reserved_tokens,reserved_indexer,reserved_checker FROM intents ORDER BY request_id',
          )
          .all(),
      ).toEqual([
        {
          request_id: 'built-accepted',
          state: 'accepted',
          state_version: 2,
          reserved_tokens: 100,
          reserved_indexer: 0,
          reserved_checker: 0,
        },
        {
          request_id: 'built-malformed-ack',
          state: 'unknown',
          state_version: 2,
          reserved_tokens: 100,
          reserved_indexer: 0,
          reserved_checker: 0,
        },
      ]);
      expect(
        db
          .query(
            'SELECT request_id,event_kind,state_version FROM intent_events ORDER BY request_id,state_version',
          )
          .all(),
      ).toEqual(
        ['built-accepted', 'built-malformed-ack'].flatMap((request_id, index) =>
          ['prepared', 'dispatching', index === 0 ? 'accepted' : 'unknown'].map(
            (event_kind, state_version) => ({
              request_id,
              event_kind,
              state_version,
            }),
          ),
        ),
      );
    } finally {
      db.close();
    }
    expect(session.stderr()).toBe('');
    console.log(
      'C15 BUILT evidence: accepted v2, fresh replay, bad ack absent, malformed ACK unknown v2, six durable events, two exact POSTs; overlap/replays sent nothing.',
    );
  });
}, 30_000);
