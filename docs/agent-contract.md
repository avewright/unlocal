# Agent contract

How AI agents (and scripts) should drive unlocal. These guarantees are versioned. Breaking them is a breaking change.

## Rules

1. **Always pass `--json`** (or set `UNLOCAL_OUTPUT=json`). stdout is then exactly one JSON document:
   - success: `{ "ok": true, "command": "plan", "data": { ... } }`
   - failure: `{ "ok": false, "command": "apply", "error": { "code", "message", "hint", "details" } }`
2. **Branch on `error.code` and the exit status**, never on message text.
3. **unlocal never prompts.** Anything that needs consent fails with a code and a `hint` saying what to do.
4. `unlocal help --json` lists commands, flags and exit codes.
5. `--sim` runs apply/destroy against a simulated cloud. Without it, apply deploys for real: anything that costs money needs an account-wide cap (`CAP_NOT_SET` / `CAP_EXCEEDED`); $0 deploys don't, and anything the cloud's provider can't do yet fails with `PROVIDER_UNAVAILABLE` before any change is made.
6. Every plan shows `budget` (this project) and `cap` (all live projects on the account). Edits to a site's files show up as an update with `changes: ["files"]`.

## Fastest path: `up`

```bash
npm run build                 # or whatever builds the site
unlocal up --json             # data.url is the public link
```

`up` first runs the project's `build` script, if `package.json` has one, with the package manager its lockfile names (installing dependencies only if `node_modules` is missing). A failed build is `BUILD_FAILED` with the last 40 lines in `error.details.output`; `--skip-build` deploys what's already built. `data.build` says what ran. Then `up` finds the built site (the framework's output folder first: Vite and Astro `dist`, Next.js `out`, SvelteKit and Create React App `build`; then `dist`, `build`, `out`, `_site`, `public`, `site`, or a plain folder of HTML), writes `unlocal.json` if there isn't one (Cloudflare, $5/mo budget), and deploys. It deploys unattended only when the plan deletes and replaces nothing and fits the project budget and the account cap; otherwise it fails with the usual code and hint. Running it again redeploys changed files or reports the existing URL. No built site: `SITE_NOT_FOUND`, whose hint says whether to build first. Deploys that cost $0 (a site on Cloudflare) need no cap or balance; with none, the guard pauses them as soon as the cloud measures any real cost. A deploy that costs money fails with `CAP_NOT_SET` until a human sets the cap, and `up` then removes the `unlocal.json` it wrote.

## MCP

`unlocal mcp` serves the same commands to MCP clients over stdio. Tools: `up`, `plan`, `apply` (takes the reviewed `plan_id`), `status`, `cost`, `account` (read-only), `destroy` (needs `confirm: true`, never deletes a database). Each result is the CLI's JSON document; `isError` is true when `ok` is false. No tool sets the cap, adds funds, or allows data loss. For example, with Claude Code:

```bash
claude mcp add unlocal -- node /path/to/unlocal/packages/cli/bin/unlocal.js mcp
```

## The guard

Running resources are charged to the prepaid balance as time passes. The guard (`unlocal guard`, and every 5 minutes while the console is open) reads `data.status.level`:

- `warn`: this month is on track for 80% of the cap, or the balance lasts under 7 days.
- `pause`: this month's spend reached the cap, or the balance lasts under a day. Every live site and service is taken offline (databases are always kept) and deploys freeze. Where the cloud can pause (Cloudflare: the Worker and its files stay; only its workers.dev address is turned off) `data.paused[].how` is `"paused"` and the resource's state carries `paused`; elsewhere it's `"deleted"`. The next apply resumes paused resources as an update with `changes: ["paused"]`.
- More than 50 live deploys in an hour also freezes deploys.

While frozen, live applies fail with `ACCOUNT_FROZEN`. Destroying still works, since it only lowers spend. `unlocal freeze` is the kill switch. Only a human runs `unlocal unfreeze`; after that, `unlocal apply --yes` restores paused projects from the unchanged `unlocal.json`. `unlocal cap --json` includes `balanceUsd` and the guard status.

### Metering

Each guard run (not `--dry-run`) also reads the usage each cloud measured since the last read, prices it from `clouds.ts`, and takes it from the balance. Reads stop 5 minutes short of now, since cloud analytics arrive late, and never overlap. `data.metered` has `usd`, `chargedUsd`, priced `lines` and per-project `errors` (a failed read is retried from the same point next run). `data.status.meteredPerDayUsd` is the measured part of `burnPerDayUsd`, taken at the faster of the last hour's and the last day's pace, so a sudden runaway pauses within one check. The last hour running 5× the day's pace, and at least $1/day, warns `usage spiked`. Today Cloudflare reports Worker requests; static file requests are free and not counted.

## Exit codes

| Exit | Meaning | Codes |
|---|---|---|
| 0 | success | |
| 1 | operation failed | `APPLY_FAILED`, `BUILD_FAILED`, `PROVIDER_UNAVAILABLE`, `STATE_CORRUPT`, `BUSY`, `INTERNAL` |
| 2 | **needs a decision** (often a human's) | `APPROVAL_REQUIRED`, `BUDGET_EXCEEDED`, `CAP_NOT_SET`, `CAP_EXCEEDED`, `FUNDS_INSUFFICIENT`, `ACCOUNT_FROZEN`, `HUMAN_REQUIRED`, `DESTRUCTIVE_CHANGE`, `CLOUD_AUTH` |
| 3 | bad config | `CONFIG_INVALID`, `CONFIG_NOT_FOUND`, `CONFIG_EXISTS`, `SITE_NOT_FOUND`, `NAME_TAKEN` |
| 4 | plan out of date | `PLAN_STALE`, `PLAN_INVALID` |
| 64 | bad command line | `USAGE` |

`CONFIG_INVALID` returns *every* problem in `error.details` as `[{ path, message }]`, so they can be fixed in one pass. Unknown fields are errors, which catches typos.

## Recommended loop

```bash
unlocal validate --json                       # fix all details[], repeat
unlocal plan --out deploy.plan.json --json    # inspect data.plan.cost and data.plan.budget
# show the plan to a human if data.plan.destructive or data.plan.budget.alert
unlocal apply --plan deploy.plan.json --json  # applies exactly the reviewed plan, or fails PLAN_STALE
# or: unlocal apply --plan-id <data.plan.id> --json
unlocal status --json                         # data.resources.<name>.outputs.url
```

## What agents must not do

- Raise `budget.monthlyUsd` or run `unlocal cap` on their own to get past `BUDGET_EXCEEDED` / `CAP_*`. Those are human decisions.
- Run `unlocal unfreeze` to get past `ACCOUNT_FROZEN`. Tell the human what the guard found.
- Try to fix `CLOUD_AUTH`. A human connects the cloud in the console (`unlocal console`) or logs in to it.
- Add `--allow-data-loss` without explicit human confirmation.
- Expect plaintext secrets in outputs. Credentials appear as `secret://` references.

Setting or raising the cap (`unlocal cap <usd>`), `unlocal unfreeze` and `unlocal connect aws` need an interactive terminal (and the first two a typed confirmation); without one they fail with `HUMAN_REQUIRED`. Lowering the cap works anywhere. `NAME_TAKEN` means the cloud already has something by that name that unlocal didn't make; rename the project or resource.

One apply per project runs at a time. A second one waits up to 30 seconds, then fails with `BUSY`; once the first finishes, a plan made before it is stale (`PLAN_STALE`).
