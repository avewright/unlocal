# unlocal

**A cloud account your agents can safely operate.** Describe sites, services and databases in one file; unlocal shows what it will cost, enforces a hard budget, and deploys to AWS, Google Cloud, Azure or Oracle Cloud, with one bill.

```bash
unlocal init --cloud gcp        # aws | gcp | azure | oci
unlocal cap 10                  # account-wide ceiling across every project (set by a human)
unlocal plan                    # what changes, what it costs, budget headroom
unlocal apply --yes             # deploy (--sim to simulate)
unlocal status                  # URLs, connection info, spend
unlocal console                 # add funds, set the cap, deploy
```

```json
{
  "project": "shop",
  "cloud": "gcp",
  "budget": { "monthlyUsd": 75 },
  "resources": {
    "web": { "type": "site", "path": "./web/dist", "spa": true, "domain": "shop.example.com" },
    "api": { "type": "service", "source": "./api", "port": 8080, "instances": 2 },
    "db":  { "type": "postgres", "size": "small", "storageGb": 20 }
  }
}
```

## Why agents need this

| Risk of handing an agent raw cloud credentials | unlocal's guardrail |
|---|---|
| Runaway spend | Every project has a hard `budget`, and the account has a `cap` across all projects; real deploys are refused without one |
| Mystery charges | Everything unlocal creates is tagged `unlocal:project` / `unlocal:resource`; `unlocal cap` lists every project's spend |
| Surprise changes | `plan` first; `apply` needs `--yes` or a saved, pinned plan file |
| Data loss | Deleting or replacing a database requires `--allow-data-loss` |
| Racing / stale decisions | Plans are pinned to config + state; stale plans are rejected |
| Unparseable output | `--json` everywhere, stable error codes and exit statuses |

See [docs/agent-contract.md](docs/agent-contract.md) for the full contract.

## Status

Early prototype. **AWS static sites deploy for real** (S3 + CloudFront). Everything else (services, Postgres, custom domains, other clouds) runs with `--sim` and fails with `PROVIDER_UNAVAILABLE` live, before any change is made. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

Requires Node ≥ 23.6 (runs TypeScript natively, no build step) and pnpm.

```bash
pnpm install
pnpm check                       # typecheck + tests
pnpm unlocal --dir examples/fullstack plan
```
