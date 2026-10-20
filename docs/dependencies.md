# Dependency decisions

The foundation uses Bun for its runtime, package manager, bundler, and tests. `bun.lock` records the reproducible resolution. Runtime channels in `.mise.toml` follow stable Bun and Node LTS; pnpm is present as a baseline tool but is not used to manage this package. Do not add a second lockfile.

| Dependency                     | Foundation version | Purpose                               |
| ------------------------------ | ------------------ | ------------------------------------- |
| `@modelcontextprotocol/server` | 2.3.1              | MCP registration and stdio            |
| `zod`                          | 4.6.7              | Provider and public output validation |
| `@modelcontextprotocol/client` | 2.3.1              | Development-only protocol tests       |
| `@types/bun`                   | 1.4.3              | Runtime/test types                    |
| TypeScript                     | 6.0.3              | Static checking                       |
| ESLint / `@eslint/js`          | 10.13.0 / 10.0.1   | Linting                               |
| `typescript-eslint`            | 8.72.0             | TypeScript lint rules                 |
| Prettier                       | 3.9.10             | Formatting                            |

Exact versions record the verified foundation resolution, rather than a permanent upgrade policy. Review them together when updating dependencies. The TypeScript 6.0.3 selection is a compatibility exception: typescript-eslint 8.72.0 declares TypeScript `>=4.8.4 <6.1.0`, excluding TypeScript 7. Review this exception when the supported peer range changes. The MCP packages require Node `>=20` for their Node interfaces; the CLI itself runs under Bun. Development was exercised with Bun 1.4.2 and Node 24.21.0; CI selects stable Bun 1.4.3.

Sources: [versioned MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.3.1), [Bun bundler](https://bun.com/docs/bundler), [typescript-eslint configuration](https://typescript-eslint.io/getting-started/), and [typescript-eslint registry manifest](https://registry.npmjs.org/typescript-eslint/8.72.0). SDK declarations in the installed packages control exact integration details, including `context.mcpReq.signal` for cancellation. Context7 SDK documentation covered 2.3.1; Bun documentation coverage stopped at 1.4.2 and typescript-eslint documentation was unversioned, so exact compatibility was checked against registry metadata and installed types.

The task-status POST uses Bun Fetch request methods, JSON bodies, headers, and `AbortSignal`. Version-tagged Bun 1.4.2 [Fetch documentation](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/guides/http/fetch.mdx) covers those options. CI uses Bun 1.4.3, outside that exact documentation target; installed runtime behavior and synthetic transport tests verify this integration. The versioned SDK [tool documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/servers/tools.md) covers tool registration and structured output, and its [cancellation documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/servers/logging-progress-cancellation.md) covers forwarding `context.mcpReq.signal`.
