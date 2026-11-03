# Agent contract

How AI agents (and scripts) should drive unlocal. These guarantees are versioned. Breaking them is a breaking change.

## Rules

1. **Always pass `--json`** (or set `UNLOCAL_OUTPUT=json`). stdout is then exactly one JSON document:
   - success: `{ "ok": true, "command": "plan", "data": { ... } }`
   - failure: `{ "ok": false, "command": "apply", "error": { "code", "message", "hint", "details" } }`
2. **Branch on `error.code` and the exit status**, never on message text.
3. **unlocal never prompts.** Anything that needs consent fails with a code and a `hint` saying what to do.
4. `unlocal help --json` lists commands, flags and exit codes.
5. `--sim` runs apply/destroy against a simulated cloud. Without it, apply spends real money, so it needs an account-wide cap (`CAP_NOT_SET` / `CAP_EXCEEDED`), and anything the cloud's provider can't do yet fails with `PROVIDER_UNAVAILABLE` before any change is made.
6. Every plan shows `budget` (this project) and `cap` (all live projects on the account). Edits to a site's files show up as an update with `changes: ["files"]`.

## Exit codes

| Exit | Meaning | Codes |
|---|---|---|
| 0 | success | |
| 1 | operation failed | `APPLY_FAILED`, `PROVIDER_UNAVAILABLE`, `STATE_CORRUPT`, `INTERNAL` |
| 2 | **needs a decision** (often a human's) | `APPROVAL_REQUIRED`, `BUDGET_EXCEEDED`, `CAP_NOT_SET`, `CAP_EXCEEDED`, `FUNDS_INSUFFICIENT`, `DESTRUCTIVE_CHANGE`, `CLOUD_AUTH` |
| 3 | bad config | `CONFIG_INVALID`, `CONFIG_NOT_FOUND`, `CONFIG_EXISTS` |
| 4 | plan out of date | `PLAN_STALE`, `PLAN_INVALID` |
| 64 | bad command line | `USAGE` |

`CONFIG_INVALID` returns *every* problem in `error.details` as `[{ path, message }]`, so they can be fixed in one pass. Unknown fields are errors, which catches typos.

## Recommended loop

```bash
unlocal validate --json                       # fix all details[], repeat
unlocal plan --out deploy.plan.json --json    # inspect data.plan.cost and data.plan.budget
# show the plan to a human if data.plan.destructive or data.plan.budget.alert
unlocal apply --plan deploy.plan.json --json  # applies exactly the reviewed plan, or fails PLAN_STALE
unlocal status --json                         # data.resources.<name>.outputs.url
```

## What agents must not do

- Raise `budget.monthlyUsd` or run `unlocal cap` on their own to get past `BUDGET_EXCEEDED` / `CAP_*`. Those are human decisions.
- Try to fix `CLOUD_AUTH`. A human logs in to the cloud.
- Add `--allow-data-loss` without explicit human confirmation.
- Expect plaintext secrets in outputs. Credentials appear as `secret://` references.
