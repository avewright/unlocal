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

## Running it (private beta)

```bash
UNLOCAL_CONTROL_ADMIN=<long random token> \
UNLOCAL_CONTROL_SECRET=<long random secret> \
UNLOCAL_CONTROL_SIM=1 \
pnpm control
```

Onboard a tenant; the token is returned once, so hand it over securely:

```bash
curl -s -X POST localhost:4401/v1/admin/tenants \
  -H "authorization: Bearer $UNLOCAL_CONTROL_ADMIN" -H "content-type: application/json" \
  -d '{"name":"Acme","monthlyCapUsd":5,"balanceUsd":0}'
```

Connect the tenant's Cloudflare credential (admin), then deploy and read usage as the tenant:

```bash
curl -s -X POST localhost:4401/v1/admin/tenants/<id>/cloudflare \
  -H "authorization: Bearer $UNLOCAL_CONTROL_ADMIN" -H "content-type: application/json" \
  -d '{"apiToken":"<token>","accountId":"<32 hex>"}'

curl -s -X POST localhost:4401/v1/deploy \
  -H "authorization: Bearer <ul_ tenant token>" -H "content-type: application/json" \
  -d '{"project":"site","files":[{"path":"index.html","content":"<base64>"}]}'

curl -s localhost:4401/v1/usage -H "authorization: Bearer <ul_ tenant token>"
```

Beta boundaries: binds to `127.0.0.1`, keeps tenants in one JSON file (`UNLOCAL_CONTROL_DATA`), and
has no TLS, rate limiting or multi-process support. Don't expose it publicly yet. Losing
`UNLOCAL_CONTROL_SECRET` makes stored cloud credentials unreadable; the tenant reconnects.

## Pricing

$9/mo per tenant (up to 10 sites), $29/mo for teams; the cloud bill stays the customer's. The free
local CLI remains the funnel. Later: usage-based pricing for services and databases.

## Milestones

1. **Deploy core**: bundle validation, tenant project directory, `up()` with `--sim` or real
   credentials, isolation between two tenants with the same project name. Done.
2. **HTTP API**: admin tenant creation and token rotation, encrypted Cloudflare credentials,
   `POST /v1/deploy`, `GET /v1/usage`, and a deploy queue per project. Done in `packages/control`.
3. CLI `up --remote` and an MCP tool that speaks to the same API. Next.
4. Free links: `$0` deploys with no account go to `<name>.unlocal.app` on our Cloudflare account.
5. Stripe subscriptions, dashboard, pause/delete.
6. Custom domains; then AWS as the second provider.
