# unlocal

**A cloud account your agents can safely operate.** Describe sites, services and databases in one file; unlocal shows what it will cost, enforces a hard budget, and deploys to Cloudflare, AWS, Google Cloud, Azure or Oracle Cloud, with one bill.

```bash
unlocal up                      # after a cap is set: this folder's built site → a live URL
unlocal init --cloud gcp        # aws | gcp | azure | oci | cloudflare
unlocal cap 10                  # account-wide ceiling across every project (set by a human)
unlocal plan                    # what changes, what it costs, budget headroom
unlocal apply --yes             # deploy (--sim to simulate)
unlocal status                  # URLs, connection info, spend
unlocal guard                   # check burn and runway; pauses everything before money runs out
unlocal freeze                  # kill switch: take everything offline, freeze deploys
unlocal console                 # add funds, set the cap, connect clouds, see spending
unlocal mcp                     # the same, for MCP clients (Claude, Cursor, …)
```

```json
{
  "project": "shop",
  "cloud": "gcp",
  "budget": { "monthlyUsd": 75 },
  "resources": {
    "web": { "type": "site", "path": "./web/dist", "spa": true },
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

Early prototype. **Static sites deploy for real** on Cloudflare (Workers static assets, free) and AWS (S3 + CloudFront). Everything else (services, Postgres, custom domains, other clouds) runs with `--sim` and fails with `PROVIDER_UNAVAILABLE` live, before any change is made. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

What the cap does and doesn't do today:
- Spend is estimated from list prices, not metered from the cloud's bill. Traffic, egress and requests aren't counted yet.
- The cap, wallet and guard are local files and processes. They stop a cooperative or confused agent: raising the cap or unfreezing needs a typed confirmation at a real terminal. An agent determined to edit `~/.unlocal` by hand isn't stopped. That takes the hosted account, still to come.
- The guard runs while `unlocal console` is open, or when `unlocal guard` runs. Nothing watches spend while neither is running.

## Development

Requires Node ≥ 23.6 (runs TypeScript natively, no build step) and pnpm.

```bash
pnpm install
pnpm check                       # typecheck + tests
pnpm unlocal --dir examples/fullstack plan
```
