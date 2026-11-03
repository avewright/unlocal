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

```
CLI  ·  MCP server  ·  REST API  ·  dashboard
                 │
        Control plane (hosted)
          auth, orgs, projects, scoped agent tokens (spend cap, resource-type allowlist, TTL)
          state store (replaces .unlocal/state.json), locking, approval queue
                 │
        Provisioning workers ── Provider: aws (then gcp, azure)
                 │
        AWS Organizations: one member account per customer project
                 │
        Metering: Cost & Usage Reports + live estimates → prepaid wallet (Stripe)
          hard stop: scale to zero / suspend when wallet or budget is exhausted
```

### Billing model (decision: prepaid credits)
Customers top up a wallet; unlocal resells cloud usage plus a platform fee (`PLATFORM_FEE_RATE`, placeholder 10%). Prepaid removes credit risk and fraud exposure while keeping "one bill". Per-customer member accounts give clean cost attribution and isolation.

### Provider mapping (source of truth: `CLOUDS_INFO` in clouds.ts)
| unlocal | AWS | Google Cloud | Azure | Oracle Cloud |
|---|---|---|---|---|
| `site` | S3 + CloudFront | Firebase Hosting | Static Web Apps | Object Storage + Load Balancer |
| `service` | ECS Fargate + ALB | Cloud Run | Container Apps | Container Instances + Load Balancer |
| `postgres` | RDS for PostgreSQL | Cloud SQL | Database for PostgreSQL | Database with PostgreSQL |

Credentials surface as `secret://` refs on every cloud. Prices marked "unverified" in clouds.ts (Oracle Postgres; Azure and Google larger database sizes) must be confirmed before launch.

## Roadmap
1. **Live `site` providers**: real static deploys with HTTPS on each cloud, starting with AWS.
2. `unlocal logs`, `unlocal secret set`, file upload for site contents.
3. **MCP server** exposing plan/apply/status with the same guardrails.
4. Live `service` and `postgres` providers on all four clouds.
5. Hosted control plane: accounts, scoped agent tokens, remote state + locking.
6. Managed AWS member accounts, prepaid wallet, metering and hard stops.
7. Preview environments with `--ttl`, idle-resource detection.
