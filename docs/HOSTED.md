# unlocal Cloud: the hosted control plane

Decision: **sell a hosted control plane, not cloud resale.** The customer keeps their cloud
account. unlocal holds a scoped credential for it, deploys on their behalf, and enforces the
budget server-side. The agent gets a tenant token that can deploy and read usage — nothing else.

## Why this shape

- **The cap becomes real.** The agent never holds the cloud credential, and there is no endpoint
  that raises a cap or adds funds. Local mode stays a convenience; the hosted mode is a boundary.
- **No reseller economics.** Cloudflare, AWS and the rest bill the customer directly. unlocal sells
  the permission layer, not the compute, so list-price drift and egress surprises are not our margin.
- **No content liability.** The site lives in the customer's account, under their name and domain.
- **The engine already exists.** A deploy is the same `up()` the CLI runs, pointed at a tenant
  directory with the tenant's credentials and ledger.

## Product (v1)

- **Cloudflare static sites only.** The narrowest thing that is useful and cheap.
- One tenant = one customer. Manual onboarding for the private beta; Stripe subscriptions later.
- **`unlocal up --remote`** (and an MCP tool) uploads the built folder. The control plane deploys it
  to the tenant's Cloudflare account and returns the URL.
- Dashboard: projects, URLs, spend, cap, pause, delete, reconnect the credential.
- **The tenant token cannot** change the cap, add funds, unfreeze, delete data, or read another
  tenant's anything. Those are admin or human actions.

## Non-goals (v1)

- Hosting customer content on unlocal's account.
- Reselling cloud usage or issuing one bill across clouds.
- AWS/GCP/Azure, services, Postgres, custom domains, teams, preview environments.

## Architecture

```
CLI / MCP ──HTTPS──▶ control plane (auth, tenancy, queue, ledger)
                         │
                         └──▶ provider (Cloudflare) using the tenant's encrypted token
```

- Store (`tenants`, `tokens` hashed, `credentials` AES-GCM, `projects`, `deployments`) in a single
  JSON file for the beta; Postgres when there is a second server.
- A deploy validates the bundle, materializes a persistent project directory, then runs `up()`.
  The project directory keeps `.unlocal/state.json` so the next deploy is an update, not a recreate.
- Caps: `tenant.monthlyCapUsd` is written to the tenant's isolated `UNLOCAL_HOME`; core refuses a
  plan over it or without funds. The control plane never exposes a cap mutation to a tenant token.
- One deploy per project at a time (the queue is per project). The core locks state as a second line.

## Pricing

$9/mo per tenant (up to 10 sites), $29/mo for teams; the cloud bill stays the customer's. The free
local CLI remains the funnel. Later: usage-based pricing for services and databases.

## Milestones

1. **Deploy core** (this slice): bundle validation, tenant project directory, `up()` with `--sim` or
   real credentials, isolation between two tenants with the same project name. Tested.
2. HTTP API: bearer tokens, `POST /v1/deploy`, `GET /v1/usage`, admin-only tenant creation, encrypted
   Cloudflare credentials.
3. CLI `up --remote` and an MCP tool that speaks to the same API.
4. Stripe subscriptions, dashboard, pause/delete.
5. Custom domains; then AWS as the second provider.
