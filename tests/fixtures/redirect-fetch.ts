// Test preload only: the shipped CLI has no endpoint override.
const originalFetch = globalThis.fetch;
const createPaths = new Set([
  '/v2/task/google/indexer/create',
  '/v2/task/yandex/indexer/create',
  '/v2/task/google/checker/create',
  '/v2/task/yandex/checker/create',
  '/v2/task/bing/checker/create',
  '/v2/task/backlink/checker/create',
]);
const statusPaths = new Set([
  '/v2/task/google/indexer/status',
  '/v2/task/google/checker/status',
  '/v2/task/yandex/indexer/status',
  '/v2/task/yandex/checker/status',
  '/v2/task/bing/checker/status',
  '/v2/task/backlink/checker/status',
]);
const reportPaths = new Set([
  '/v2/task/google/indexer/report',
  '/v2/task/google/checker/report',
  '/v2/task/yandex/indexer/report',
  '/v2/task/yandex/checker/report',
  '/v2/task/bing/checker/report',
  '/v2/task/backlink/checker/report',
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
  const supportedReportPost =
    method === 'POST' && reportPaths.has(target.pathname);
  const supportedDripQuery =
    method === 'GET' &&
    /^\/v2\/task\/google\/indexer\/list\/\d+$/.test(target.pathname) &&
    target.search === '?filter=drip_feed';
  const supportedTarget =
    target.origin === 'https://api.speedyindex.com' &&
    !target.username &&
    !target.password &&
    (!target.search || supportedDripQuery) &&
    !target.hash &&
    (supportedGet ||
      supportedStatusPost ||
      supportedReportPost ||
      (method === 'POST' && createPaths.has(target.pathname)));
  if (!supportedTarget) {
    console.error('Test network isolation violation.');
    throw new Error('Unexpected production URL');
  }
  if (process.env.TEST_FETCH_MODE === 'throw') {
    throw new Error(`network failure ${process.env.SPEEDYINDEX_API_KEY}`);
  }
  const origin = process.env.TEST_ACCOUNT_ORIGIN;
  const loopback = origin ? new URL(origin) : undefined;
  if (
    !loopback ||
    loopback.origin !== origin ||
    loopback.protocol !== 'http:' ||
    loopback.hostname !== '127.0.0.1' ||
    loopback.username ||
    loopback.password ||
    init?.redirect !== 'error'
  ) {
    console.error('Test network isolation violation.');
    throw new Error('Missing loopback fixture');
  }
  return originalFetch(
    new URL(`${target.pathname}${target.search}`, origin),
    init,
  );
}) as typeof fetch;
