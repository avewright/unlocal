# Roadmap

The goal: an agent says "put this online" and gets a working link to the real app in under a minute (site, database, domain), and can never spend more than the human allowed.

Checked items are done and committed. Who: **O** = Opus (core, CLI, console), **C** = control-plane agent (`packages/control`), **X** = Codex (website), **you** = a decision or action only the founder can take.

## Now: make what exists real

- [x] **O** Static sites aren't metered: on Workers Free their 404 requests cost nothing, and metering them paused free sites with no balance
- [x] **O** Guard pause takes the project state lock, like apply
- [x] **O** Docs agree: ARCHITECTURE target is the hosted / own-cloud-account model; README Status says spend is metered and free deploys need no setup
- [x] **O** Commit the metering and free-deploy work
- [ ] **you** Say "go": first real deploy of the website to Cloudflare (`unlocal up`, $0)
- [ ] **O** Fix whatever the real deploy shows; confirm metering reads real numbers
- [ ] **you** Push `guardrails-metering` and merge to `main`

## Next: anyone can use it

- [x] **O** `up` builds the app itself: detect Vite, Astro, Next static export, plain HTML; run the build; deploy the output
- [x] **O** npm package ready: `npx unlocal up` and `npx unlocal mcp` work from any folder
- [ ] **you** Publish to npm (needs your npm account)
- [ ] **you** Pick and buy the free-link domain (e.g. `unlocal.app`) and add it to Cloudflare
- [x] **C** Hosted API: tenants, hashed tokens, encrypted cloud credentials, `POST /v1/deploy`, `GET /v1/usage`, a deploy queue per project
- [x] **C** Remote deploy client (`unlocal-control remote`) so the API is usable before `up --remote` lands
- [ ] **C** Free links: deploys with no account go to `<name>.unlocal.app` on our Cloudflare account
- [ ] **C** Beta hardening: TLS, a real database, rate limits, request logs, and the always-on guard/meter loop
- [ ] **C** Admin CLI/console for tenant creation, funds and credential reconnect (curl is fine for now)
- [ ] **O** `unlocal up --remote` and the MCP tool talk to the hosted API; the agent holds only an unlocal token
- [ ] **X** Website: waitlist, the $100 story, the real live link
- [ ] **you** Show it to 10 agent builders; note where they get stuck

## Then: the one-stop shop

- [x] **O** Permanent AWS connection: `unlocal connect aws`, a role limited to unlocal's resources, renewed automatically
- [ ] **O** Narrow the role's CloudFront access to unlocal-tagged distributions, once tag conditions are verified
- [ ] **O** "Connect AWS" button in the console (CloudFormation quick-create link)

- [ ] **O** Server code on Workers (an API next to the site), metered by requests
- [ ] **O** Simple database: Cloudflare D1, created and connected by `up`, metered by rows written, rows read and storage; never deleted by a pause
- [ ] **O** Secrets: `unlocal secret set KEY`, never shown back to the agent
- [ ] **O** Preview link per change, and `unlocal rollback`
- [ ] **O** `unlocal logs --json` so agents can debug what they deployed
- [ ] **O** Domains via Cloudflare Registrar API: search, price, register only with a human's approval; per-purchase limit
- [ ] **O** Cost estimates from measured history ("last 7 days: $0.42"), and usage scenarios in plans
- [ ] **O** Per-project limits: a runaway project pauses alone
- [ ] **C** Always-on guard in the hosted service (no laptop needed)
- [ ] **O** Console redesign: the founder found it confusing; start from what a first-time user needs to see
- [ ] **you** Pricing: three manual beta customers before building subscriptions

## Not now

More clouds, CPU metering, AWS live services, console polish beyond the redesign.
