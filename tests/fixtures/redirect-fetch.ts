// Test preload only: the shipped CLI has no endpoint override.
const originalFetch = globalThis.fetch;
const statusPaths = new Set([
  '/v2/task/google/indexer/status',
  '/v2/task/google/checker/status',
  '/v2/task/yandex/indexer/status',
  '/v2/task/yandex/checker/status',
  '/v2/task/bing/checker/status',
  '/v2/task/backlink/checker/status',
]);
globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const target = new URL(String(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const supportedGet =
    method === 'GET' &&
    (target.pathname === '/v2/account' ||
      /^\/v2\/task\/(google\/(indexer|checker)|yandex\/(indexer|checker)|bing\/checker)\/list\/\d+$/.test(
        target.pathname,
      ));
  const supportedStatusPost =
    method === 'POST' && statusPaths.has(target.pathname);
  const supportedTarget =
    target.origin === 'https://api.speedyindex.com' &&
    (supportedGet || supportedStatusPost);
  if (!supportedTarget) {
    throw new Error('Unexpected production URL');
  }
  if (process.env.TEST_FETCH_MODE === 'throw') {
    throw new Error(`network failure ${process.env.SPEEDYINDEX_API_KEY}`);
  }
  const origin = process.env.TEST_ACCOUNT_ORIGIN;
  if (!origin?.startsWith('http://127.0.0.1:'))
    throw new Error('Missing loopback fixture');
  return originalFetch(
    new URL(`${target.pathname}${target.search}`, origin),
    init,
  );
}) as typeof fetch;
