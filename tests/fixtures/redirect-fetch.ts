// Test preload only: the shipped CLI has no endpoint override.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const target = new URL(String(input));
  const supportedTarget =
    target.origin === 'https://api.speedyindex.com' &&
    (target.pathname === '/v2/account' ||
      /^\/v2\/task\/(google|yandex|bing)\/(indexer|checker)\/list\/\d+$/.test(
        target.pathname,
      ));
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
