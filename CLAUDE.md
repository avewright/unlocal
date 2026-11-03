# unlocal: dev notes

Agent-first CLI and platform for deploying to AWS, Google Cloud, Azure and Oracle Cloud with hard budgets and simple billing. All cloud-specific data lives in packages/core/src/clouds.ts. Read docs/ARCHITECTURE.md (design + roadmap) and docs/agent-contract.md (the CLI's public contract).

## Commands
- `pnpm check`: typecheck (tsc, noEmit) + tests (`node --test`)
- `pnpm unlocal --dir examples/fullstack plan`: run the CLI from source
- `pnpm unlocal console`: the console at http://127.0.0.1:4400 (add funds, set cap, deploy; `--login` requires an account). Code in packages/console; payments use Stripe Checkout when STRIPE_SECRET_KEY is set (use sk_test_ keys), otherwise instant test credit.
- `pnpm www`: preview the website (apps/www/public) at http://localhost:4321. It's one static HTML file with no JS or web fonts, and unlocal deploys it via apps/www/unlocal.json. Its terminal block must stay real CLI output.

## Conventions
- Node runs `.ts` directly (type stripping). Only erasable TS syntax: no enums, namespaces or constructor parameter properties. Import with `.ts` extensions and use `import type` for types.
- No runtime dependencies so far; justify any you add.
- Every failure is an `UnlocalError` with a stable `ErrorCode`, and a `hint` when there's a next step. New codes need an `EXIT_CODES` entry and a row in docs/agent-contract.md.
- Guardrails (budget, account cap, data loss, stale plan) belong in `@unlocal/core`, not the CLI. Never set or raise the cap (`unlocal cap`) on the user's behalf.
- Tests must never touch the real account file: the CLI test helper sets `UNLOCAL_HOME` per test. Live provider code is unit-tested through its pure helpers; never call a real cloud from tests.
- Changes to the JSON output shape are breaking changes for agents. Add fields; don't rename or remove them.
