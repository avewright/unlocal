# Architecture

## Today (v0.1, local prototype)

```
unlocal CLI (packages/cli)            JSON contract, flags, rendering
        │
@unlocal/core (packages/core)
  validate.ts   unlocal.json → ProjectConfig (defaults, all-issues-at-once errors)
  pricing.ts    per-resource monthly estimates from list prices + platform fee
  planner.ts    config × state → ordered actions, cost delta, budget status, pinned plan id
  apply.ts      guardrails (stale/budget/data-loss), runs actions, persists after each step
  state.ts      .unlocal/state.json, atomic writes, serial number per apply
  clouds.ts     everything cloud-specific: regions, native services, list prices
  providers/    Provider interface; `sim` (deterministic fake cloud); live providers register per cloud
```

Design rules:
- **Resource model, not cloud primitives.** Users write `site` / `service` / `postgres`. Providers map those to each cloud's managed services. The surface stays small enough for agents to use reliably.
- **One project, one cloud.** `cloud` + `region` in unlocal.json. Changing either replaces resources (guarded by `--allow-data-loss` for databases).
- **Guardrails live in core**, not the CLI, so the future API and MCP server get them for free.
- **Providers must be idempotent.** Apply persists state after each action and can be re-run after a partial failure.

## Target (hosted product)

Decided 2026-11-04; the full design is [HOSTED.md](HOSTED.md). In short:

```
CLI  ·  MCP server  ·  REST API  ·  console
                 │  agent holds only an unlocal token
        Control plane (hosted, packages/control)
          tenants, hashed tokens, encrypted cloud credentials, deploy queue,
          the always-on guard and meter, approvals for purchases
                 │
        The customer's own cloud account (Cloudflare first)
          free links: <name>.unlocal.app on unlocal's Cloudflare account
```

- **The customer's cloud, not ours.** Their cloud bill is theirs; unlocal sells the guardrails and the contract, not compute. No reselling, no markup.
- **The cap is enforced by the server.** The agent's token can deploy and read usage. It can't raise a cap, add funds, unfreeze or delete data, and it never sees the cloud credential.
- **Spend is measured, not only estimated.** The meter (meter.ts) reads usage the cloud reports and the guard pauses on the measured pace.
- **Free links need no account.** $0 deploys go out with no setup; anything that can cost money needs the human's cap.

### Provider mapping (source of truth: `CLOUDS_INFO` in clouds.ts)
| unlocal | AWS | Google Cloud | Azure | Oracle Cloud | Cloudflare |
|---|---|---|---|---|---|
| `site` | S3 + CloudFront | Firebase Hosting | Static Web Apps | Object Storage + Load Balancer | Workers static assets |
| `service` | ECS Fargate + ALB | Cloud Run | Container Apps | Container Instances + Load Balancer | not offered |
| `postgres` | RDS for PostgreSQL | Cloud SQL | Database for PostgreSQL | Database with PostgreSQL | not offered |

A type a cloud doesn't offer is a `CONFIG_INVALID` error naming what it does offer. Cloudflare credentials come from `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, plus Account Analytics: Read for metering) and `CLOUDFLARE_ACCOUNT_ID`; every Worker unlocal deploys carries the `UNLOCAL_ASSETS` binding, and unlocal refuses to overwrite or delete a Worker without it.

Credentials surface as `secret://` refs on every cloud. Prices marked "unverified" in clouds.ts (Oracle Postgres; Azure and Google larger database sizes) must be confirmed before launch.

## Roadmap

See [ROADMAP.md](ROADMAP.md).
