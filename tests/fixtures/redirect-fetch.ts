// Test preload only: the shipped CLI has no endpoint override.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  if (String(input) !== 'https://api.speedyindex.com/v2/account') {
    throw new Error('Unexpected production URL');
  }
  if (process.env.TEST_FETCH_MODE === 'throw') {
    throw new Error(`network failure ${process.env.SPEEDYINDEX_API_KEY}`);
  }
  const origin = process.env.TEST_ACCOUNT_ORIGIN;
  if (!origin?.startsWith('http://127.0.0.1:'))
    throw new Error('Missing loopback fixture');
  return originalFetch(`${origin}/v2/account`, init);
}) as typeof fetch;
