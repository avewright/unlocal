# unlocal: dev notes

Agent-first CLI and platform for deploying to Cloudflare, AWS, Google Cloud, Azure and Oracle Cloud with hard budgets and simple billing. Cloud prices and capabilities live in packages/core/src/clouds.ts; live provider code lives in packages/core/src/providers/. Read docs/ARCHITECTURE.md (design + roadmap), docs/HOSTED.md (the hosted control plane we're building) and docs/agent-contract.md (the CLI's public contract).

## Commands
- `pnpm check`: typecheck (tsc, noEmit) + tests (`node --test`)
- `pnpm unlocal --dir examples/fullstack plan`: run the CLI from source
- `pnpm unlocal --dir <folder> up --sim`: localhost to live in one step (core/src/up.ts)
- `pnpm unlocal mcp`: MCP server over stdio (cli/src/mcp.ts); its tools wrap CLI commands, and none may set the cap or allow data loss
- `pnpm unlocal console`: the console at http://127.0.0.1:4400 (add funds, set cap, deploy; `--login` requires an account). Code in packages/console; payments use Stripe Checkout when STRIPE_SECRET_KEY is set (use sk_test_ keys), otherwise instant test credit.
- `pnpm www`: preview the website (apps/www/public) at http://localhost:4321. It's one static HTML file with no JS or web fonts, and unlocal deploys it via apps/www/unlocal.json. Its terminal block must stay real CLI output.
- `packages/control`: the hosted deploy core (validate a bundle → tenant project dir → `up()`); see docs/HOSTED.md. The HTTP layer, tenant tokens and Stripe subscriptions come next; keep it out of core.

## Conventions
- Node runs `.ts` directly (type stripping). Only erasable TS syntax: no enums, namespaces or constructor parameter properties. Import with `.ts` extensions and use `import type` for types.
- The only runtime dependencies are the AWS SDK clients in core (the AWS provider needs SigV4 and multipart uploads). Justify any you add.
- Every read-modify-write of the account goes through `withAccount` (it takes a lock). Don't pair `loadAccount` with `saveAccount`.
- Every failure is an `UnlocalError` with a stable `ErrorCode`, and a `hint` when there's a next step. New codes need an `EXIT_CODES` entry and a row in docs/agent-contract.md.
- Guardrails (budget, account cap, data loss, stale plan, the spend guard in core/src/guard.ts) belong in `@unlocal/core`, not the CLI. Never set or raise the cap (`unlocal cap`) or unfreeze (`unlocal unfreeze`) on the user's behalf. Pausing never deletes a database.
- Tests must never touch the real account file: the CLI test helper sets `UNLOCAL_HOME` per test. Live provider code is unit-tested through its pure helpers; never call a real cloud from tests.
- Changes to the JSON output shape are breaking changes for agents. Add fields; don't rename or remove them.
