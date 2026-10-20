import { expect, test } from 'bun:test';
import { balanceResultSchema, listTasksResultSchema } from '../src/client';
import { taskStatusResultSchema } from '../src/task-status';
import { taskReportOutputSchema } from '../src/task-report';
import { account, connect, fixture } from './helpers';
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
  try {
    session = await connect(api.origin, 'dist/cli.js');
    expect(session.client.getServerVersion()?.name).toBe('speedyindex-mcp');
    expect(
      (await session.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual([
      'get_balance',
      'list_tasks',
      'get_task_status',
      'get_task_report',
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
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('F09: built CLI exits naturally on stdin EOF', async () => {
  await verifyEof('dist/cli.js');
});
