import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CLOUDS,
  bucketName,
  capStatus,
  creditAccount,
  distributionConfig,
  createAwsProvider,
  createCloudflareProvider,
  assess,
  recordDeploy,
  runGuard,
  connectTemplate,
  withRetries,
  awsCredentialsFor,
  assumeRoleCredentials,
  priceUsage,
  meterUsage,
  METER_LAG_MS,
  withAccount,
  withLock,
  loadAccount,
  pausedConfig,
  settle,
  type Account,
  saveCredentials,
  withCredentials,
  MARKER_BINDING,
  scriptName,
  CLOUDS_INFO,
  UnlocalError,
  applyPlan,
  createPlan,
  createSimProvider,
  emptyState,
  estimateResource,
  parseConfig,
  type Cloud,
  type ProjectConfig,
  type ProjectState,
} from "../src/index.ts";

const base = {
  project: "demo",
  budget: { monthlyUsd: 100 },
  resources: {
    web: { type: "site", path: "./dist" },
    api: { type: "service", source: "./api" },
    db: { type: "postgres" },
  },
};

const config = (overrides: Record<string, unknown> = {}): ProjectConfig => parseConfig({ ...base, ...overrides });

/** The base project on `cloud`, keeping only the resource types that cloud offers. */
const onCloud = (cloud: Cloud, overrides: Record<string, unknown> = {}): ProjectConfig => {
  const resources = Object.fromEntries(Object.entries(base.resources).filter(([, r]) => CLOUDS_INFO[cloud].native[r.type as "site"]));
  return config({ cloud, resources, ...overrides });
};

function issuesOf(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof UnlocalError);
    assert.equal(err.code, "CONFIG_INVALID");
    return err.details as { path: string; message: string }[];
  }
  assert.fail("expected CONFIG_INVALID");
}

async function apply(cfg: ProjectConfig, state: ProjectState, opts: { allowDataLoss?: boolean; failOn?: string[] } = {}) {
  const saved: ProjectState[] = [];
  const result = await applyPlan(createPlan(cfg, state), state, {
    dir: ".",
    provider: createSimProvider({ failOn: opts.failOn }),
    persist: async (s) => void saved.push(structuredClone(s)),
    allowDataLoss: opts.allowDataLoss,
  });
  return { ...result, saved };
}

describe("parseConfig", () => {
  it("fills defaults", () => {
    const c = config();
    assert.equal(c.cloud, "aws");
    assert.equal(c.region, "us-east-1");
    assert.equal(c.budget.alertAtPercent, 80);
    assert.deepEqual(c.resources.api, { type: "service", source: "./api", port: 8080, cpu: 0.25, memoryGb: 0.5, instances: 1, env: {} });
    assert.deepEqual(c.resources.db, { type: "postgres", size: "small", storageGb: 20, highAvailability: false });
  });

  it("requires a budget", () => {
    const issues = issuesOf(() => parseConfig({ project: "demo", resources: {} }));
    assert.equal(issues[0]?.path, "budget");
  });

  it("reports every problem at once, including unknown fields", () => {
    const issues = issuesOf(() =>
      parseConfig({
        project: "Bad Name",
        budget: { monthlyUsd: 10 },
        resources: {
          api: { type: "service", source: "./api", cpu: 1, memoryGb: 0.5, instnces: 2 },
          db: { type: "mysql" },
        },
      }),
    );
    const paths = issues.map((i) => i.path).sort();
    assert.deepEqual(paths, ["project", "resources.api.instnces", "resources.api.memoryGb", "resources.db.type"]);
  });
});

describe("estimateResource", () => {
  it("prices a default service at roughly $38/mo including the platform fee", () => {
    const est = estimateResource(config().resources.api!, "aws", "us-east-1");
    assert.ok(est.monthlyUsd > 30 && est.monthlyUsd < 45, `got ${est.monthlyUsd}`);
    assert.ok(est.lineItems.some((i) => i.description.includes("platform fee")));
  });

  it("doubles database cost for high availability", () => {
    const single = estimateResource({ type: "postgres", size: "small", storageGb: 20, highAvailability: false }, "aws", "us-east-1");
    const ha = estimateResource({ type: "postgres", size: "small", storageGb: 20, highAvailability: true }, "aws", "us-east-1");
    assert.ok(Math.abs(ha.monthlyUsd - single.monthlyUsd * 2) < 0.05);
  });
});

describe("multi-cloud", () => {
  it("accepts every cloud with its own default region", () => {
    for (const cloud of CLOUDS) {
      const c = onCloud(cloud);
      assert.equal(c.region, CLOUDS_INFO[cloud].defaultRegion);
    }
  });

  it("rejects a region from a different cloud", () => {
    const issues = issuesOf(() => config({ cloud: "gcp", region: "us-east-1" }));
    assert.equal(issues[0]?.path, "region");
    assert.match(issues[0]!.message, /us-central1/);
  });

  it("prices every resource type on every cloud, in every region", () => {
    for (const cloud of CLOUDS) {
      for (const region of Object.keys(CLOUDS_INFO[cloud].regions)) {
        for (const [name, spec] of Object.entries(onCloud(cloud, { region }).resources)) {
          const est = estimateResource(spec, cloud, region);
          assert.ok(est.monthlyUsd >= 0 && Number.isFinite(est.monthlyUsd), `${cloud} ${region} ${name}`);
          if (spec.type !== "site") assert.ok(est.monthlyUsd > 0, `${cloud} ${name} should cost something`);
        }
      }
    }
  });

  it("rejects resource types a cloud doesn't offer, naming what it does", () => {
    const issues = issuesOf(() => config({ cloud: "cloudflare" }));
    assert.deepEqual(issues.map((i) => i.path), ["resources.api.type", "resources.db.type"]);
    assert.match(issues[0]!.message, /Cloudflare hosts only sites/);
  });

  it("names the native service in line items", () => {
    const est = estimateResource(config({ cloud: "gcp" }).resources.api!, "gcp", "us-central1");
    assert.match(est.lineItems[0]!.description, /Cloud Run/);
  });

  it("rounds Azure container shapes up to 2 GB per vCPU", () => {
    const est = estimateResource({ type: "service", source: ".", port: 80, cpu: 1, memoryGb: 4, instances: 1, env: {} }, "azure", "eastus");
    assert.match(est.lineItems[0]!.description, /2 vCPU, 4 GB/);
  });

  it("replaces resources when the project moves to another cloud", async () => {
    const { state } = await apply(config(), emptyState("demo"));
    const plan = createPlan(config({ cloud: "gcp" }), state);
    assert.ok(plan.actions.every((a) => a.kind === "replace" && a.reason === "cloud changes aws → gcp"));
    assert.equal(plan.destructive, true);
    const { state: moved } = await apply(config({ cloud: "gcp" }), state, { allowDataLoss: true });
    assert.ok(Object.values(moved.resources).every((r) => r.cloud === "gcp" && r.region === "us-central1"));
  });
});

describe("createPlan", () => {
  it("creates databases before services before sites", () => {
    const plan = createPlan(config(), emptyState("demo"));
    assert.deepEqual(plan.actions.map((a) => `${a.kind}:${a.name}`), ["create:db", "create:api", "create:web"]);
    assert.equal(plan.cost.currentMonthlyUsd, 0);
    assert.ok(plan.budget.withinBudget);
  });

  it("is a no-op once applied, and pins its id to config + state", async () => {
    const cfg = config();
    const { state } = await apply(cfg, emptyState("demo"));
    const plan = createPlan(cfg, state);
    assert.equal(plan.hasChanges, false);
    assert.notEqual(plan.id, createPlan(cfg, emptyState("demo")).id);
  });

  it("classifies update, replace and delete", async () => {
    const { state } = await apply(config(), emptyState("demo"));
    const next = config({
      resources: {
        api: { type: "service", source: "./api", instances: 2 },
        db: { type: "postgres", storageGb: 20, size: "medium" },
      },
    });
    const plan = createPlan(next, state);
    const byName = Object.fromEntries(plan.actions.map((a) => [a.name, a]));
    assert.equal(byName.api?.kind, "update");
    assert.deepEqual(byName.api?.changes, ["instances"]);
    assert.equal(byName.db?.kind, "update");
    assert.equal(byName.web?.kind, "delete");
    assert.equal(plan.destructive, false);

    const moved = createPlan(config({ region: "eu-west-1" }), state);
    assert.ok(moved.actions.every((a) => a.kind === "replace"));
    assert.equal(moved.destructive, true, "moving a database region loses its data");
  });

  it("flags plans over budget", () => {
    const plan = createPlan(config({ budget: { monthlyUsd: 20 } }), emptyState("demo"));
    assert.equal(plan.budget.withinBudget, false);
  });
});

describe("applyPlan", () => {
  it("records outputs and never stores plaintext secrets", async () => {
    const { state, applied } = await apply(config(), emptyState("demo"));
    assert.equal(applied.length, 3);
    assert.equal(state.serial, 1);
    assert.match(state.resources.db!.outputs.passwordRef!, /^secret:\/\//);
    assert.ok(!JSON.stringify(state).toLowerCase().includes("\"password\""));
  });

  it("doesn't bump the serial when there is nothing to do", async () => {
    const cfg = config();
    const { state } = await apply(cfg, emptyState("demo"));
    const saved: ProjectState[] = [];
    const result = await applyPlan(createPlan(cfg, state), state, {
      dir: ".", provider: createSimProvider(), persist: async (s) => void saved.push(structuredClone(s)),
    });
    assert.equal(result.state.serial, state.serial);
    assert.deepEqual(result.applied, []);
    assert.equal(saved.length, 0, "a no-op apply writes nothing");
  });

  it("refuses over-budget plans", async () => {
    await assert.rejects(apply(config({ budget: { monthlyUsd: 20 } }), emptyState("demo")), { code: "BUDGET_EXCEEDED" });
  });

  it("refuses to delete a database without allowDataLoss", async () => {
    const { state } = await apply(config(), emptyState("demo"));
    const noDb = config({ resources: { web: base.resources.web } });
    await assert.rejects(apply(noDb, state), { code: "DESTRUCTIVE_CHANGE" });
    const { state: after } = await apply(noDb, state, { allowDataLoss: true });
    assert.deepEqual(Object.keys(after.resources), ["web"]);
  });

  it("refuses a plan made against older state", async () => {
    const cfg = config();
    const stalePlan = createPlan(cfg, emptyState("demo"));
    const { state } = await apply(cfg, emptyState("demo"));
    await assert.rejects(
      applyPlan(stalePlan, state, { dir: ".", provider: createSimProvider(), persist: async () => {} }),
      { code: "PLAN_STALE" },
    );
  });

  it("saves progress when an action fails partway", async () => {
    const err = await apply(config(), emptyState("demo"), { failOn: ["api"] }).catch((e: unknown) => e);
    assert.ok(err instanceof UnlocalError);
    assert.equal(err.code, "APPLY_FAILED");
    assert.deepEqual((err.details as { applied: string[] }).applied, ["db"]);
  });
});

describe("account cap", () => {
  const account = (cap: number | null, balanceUsd = 1000) => ({
    version: 1 as const,
    monthlyCapUsd: cap,
    balanceUsd,
    transactions: [],
    projects: {
      "/a": { project: "a", cloud: "aws" as const, monthlyUsd: 30, live: true, updatedAt: "" },
      "/b": { project: "b", cloud: "gcp" as const, monthlyUsd: 99, live: false, updatedAt: "" },
      "/me": { project: "me", cloud: "aws" as const, monthlyUsd: 5, live: true, updatedAt: "" },
    },
  });

  it("counts other live projects, not simulated ones or this project's old total", () => {
    const s = capStatus(account(50), "/me", 15)!;
    assert.equal(s.otherProjectsUsd, 30);
    assert.equal(s.projectedUsd, 45);
    assert.equal(s.withinCap, true);
    assert.equal(capStatus(account(40), "/me", 15)!.withinCap, false);
    assert.equal(capStatus(account(null), "/me", 15), null);
  });

  it("blocks real-money applies without a cap, or over it", async () => {
    const cfg = config({ resources: { web: base.resources.web } });
    const noCap = createPlan(cfg, emptyState("demo"));
    const opts = { dir: ".", provider: createSimProvider(), persist: async () => {}, enforceCap: true };
    await assert.rejects(applyPlan(noCap, emptyState("demo"), opts), { code: "CAP_NOT_SET" });
    const over = createPlan(cfg, emptyState("demo"), { cap: (m) => capStatus(account(30), "/me", m) });
    await assert.rejects(applyPlan(over, emptyState("demo"), opts), { code: "CAP_EXCEEDED" });
    const broke = createPlan(cfg, emptyState("demo"), { cap: (m) => capStatus(account(100, 10), "/me", m) });
    await assert.rejects(applyPlan(broke, emptyState("demo"), opts), { code: "FUNDS_INSUFFICIENT" });
    const ok = createPlan(cfg, emptyState("demo"), { cap: (m) => capStatus(account(100), "/me", m) });
    assert.equal((await applyPlan(ok, emptyState("demo"), opts)).applied.length, 1);
  });
});

describe("aws provider", () => {
  it("makes valid, deterministic bucket names", () => {
    const long = bucketName("123456789012", "a".repeat(32), "b".repeat(32));
    assert.ok(long.length <= 63);
    assert.match(long, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    assert.equal(bucketName("1", "p", "n"), bucketName("1", "p", "n"));
    assert.notEqual(bucketName("1", "p", "n"), bucketName("2", "p", "n"));
  });

  it("builds a cautious CloudFront config", () => {
    const cfg = distributionConfig({ bucket: "b", region: "us-east-1", oacId: "o", spa: false, comment: "c" });
    assert.equal(cfg.PriceClass, "PriceClass_100");
    assert.equal(cfg.DefaultCacheBehavior?.ViewerProtocolPolicy, "redirect-to-https");
    assert.equal(cfg.CustomErrorResponses?.Quantity, 0);
    assert.equal(distributionConfig({ bucket: "b", region: "us-east-1", oacId: "o", spa: true, comment: "c" }).CustomErrorResponses?.Quantity, 2);
  });

  it("only takes on what it can do", () => {
    const aws = createAwsProvider();
    assert.equal(aws.unsupported?.({ type: "site", path: ".", spa: false }), undefined);
    assert.match(aws.unsupported?.({ type: "site", path: ".", spa: false, domain: "x.com" }) ?? "", /domains/);
    assert.match(aws.unsupported?.({ type: "postgres", size: "small", storageGb: 20, highAvailability: false }) ?? "", /postgres/);
  });
});

/** An in-memory stand-in for the Cloudflare API endpoints the provider uses. */
function fakeCloudflare() {
  const scripts = new Map<string, { bindings: { name: string; type: string }[]; metadata?: Record<string, any>; source?: string; routed?: boolean }>();
  const assets = new Map<string, { body: string; type: string }>();
  let uploads = 0;
  const hits: { script: string; at: number; n: number }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (status: number, code: number, message: string) => json(status, { success: false, errors: [{ code, message }] });
  const ok = (result: unknown, status = 200) => json(status, { success: true, errors: [], result });

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/client\/v4\/accounts\/acc/, "");
    const auth = new Headers(init.headers).get("authorization");
    const method = init.method ?? "GET";
    if (route === "/workers/assets/upload") {
      if (auth !== "Bearer upload-jwt") return fail(401, 10000, "Authentication error");
      for (const [hash, value] of (init.body as FormData).entries()) {
        const blob = value as Blob;
        assets.set(hash, { body: Buffer.from(await blob.text(), "base64").toString(), type: blob.type });
        uploads++;
      }
      return ok({ jwt: "complete-jwt" }, 201);
    }
    if (auth !== "Bearer tok") return fail(403, 10000, "Authentication error");
    if (url.pathname === "/client/v4/graphql") {
      const { variables: v } = JSON.parse(String(init.body));
      const from = Date.parse(v.from), to = Date.parse(v.to);
      const requests = hits.filter((h) => h.script === v.script && h.at >= from && h.at < to).reduce((s, h) => s + h.n, 0);
      return json(200, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests } }] }] } }, errors: null });
    }
    if (route === "/workers/subdomain") return ok({ subdomain: "avery" });
    const m = route.match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/);
    if (!m) return fail(404, 7003, "no route");
    const [, name, rest = ""] = m as unknown as [string, string, string?];
    if (rest === "/settings") return scripts.has(name) ? ok({ bindings: scripts.get(name)!.bindings }) : fail(404, 10007, "script not found");
    if (rest === "/assets-upload-session") {
      const manifest = JSON.parse(String(init.body)).manifest as Record<string, { hash: string }>;
      const missing = Object.values(manifest).map((f) => f.hash).filter((h) => !assets.has(h));
      return ok(missing.length ? { jwt: "upload-jwt", buckets: [missing] } : { jwt: "complete-jwt", buckets: [] });
    }
    if (rest === "/subdomain") {
      const enabled = JSON.parse(String(init.body)).enabled as boolean;
      if (scripts.has(name)) scripts.get(name)!.routed = enabled;
      return ok({ enabled, previews_enabled: false });
    }
    if (method === "PUT") {
      const form = init.body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
      if (metadata.assets.jwt !== "complete-jwt") return fail(400, 10021, "bad assets jwt");
      scripts.set(name, { bindings: metadata.bindings, metadata, source: await (form.get("index.js") as Blob).text(), routed: scripts.get(name)?.routed ?? false });
      return ok({ id: name });
    }
    if (method === "DELETE") return scripts.delete(name) ? ok(null) : fail(404, 10007, "script not found");
    return fail(404, 7003, "no route");
  };
  /** Requests that reached a Worker's code at a moment. */
  const hit = (script: string, at: Date, n: number) => hits.push({ script, at: at.getTime(), n });
  return { scripts, assets, uploads: () => uploads, hit, fetch: fetchImpl as typeof fetch };
}

describe("cloudflare provider", () => {
  const env = { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc" };
  const site = { type: "site" as const, path: "./dist", spa: false };
  const project = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "unlocal-cf-"));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "index.html"), "<h1>hi</h1>");
    writeFileSync(path.join(dir, "dist", "app.css"), "h1{}");
    return { project: "demo", cloud: "cloudflare" as const, region: "global", dir, log: () => {} };
  };

  it("deploys a site to workers.dev, uploading only files Cloudflare lacks", async () => {
    const cf = fakeCloudflare();
    const provider = createCloudflareProvider({ env, fetch: cf.fetch });
    const ctx = project();
    await provider.preflight!(ctx);
    const out = await provider.create(ctx, "web", site);
    assert.equal(out.url, "https://demo-web.avery.workers.dev");
    assert.equal(cf.uploads(), 2);
    assert.ok([...cf.assets.values()].some((a) => a.body === "<h1>hi</h1>" && a.type.startsWith("text/html")));
    const meta = cf.scripts.get("demo-web")!.metadata!;
    assert.equal(meta.assets.config.not_found_handling, "404-page");
    assert.equal(meta.bindings[0].name, MARKER_BINDING);

    await provider.update(ctx, "web", site, { ...site, spa: true }, out);
    assert.equal(cf.uploads(), 2, "unchanged files aren't re-uploaded");
    assert.equal(cf.scripts.get("demo-web")!.metadata!.assets.config.not_found_handling, "single-page-application");

    writeFileSync(path.join(ctx.dir, "dist", "index.html"), "<h1>v2</h1>");
    await provider.update(ctx, "web", site, site, out);
    assert.equal(cf.uploads(), 3);

    await provider.delete(ctx, "web", site, out);
    assert.equal(cf.scripts.has("demo-web"), false);
    await provider.delete(ctx, "web", site, out); // already gone: still fine
  });

  it("never overwrites a Worker it didn't make", async () => {
    const cf = fakeCloudflare();
    cf.scripts.set("demo-web", { bindings: [] });
    const provider = createCloudflareProvider({ env, fetch: cf.fetch });
    await assert.rejects(provider.create(project(), "web", site), { code: "NAME_TAKEN" });
    assert.equal(cf.uploads(), 0);
  });

  it("reports missing or rejected credentials as CLOUD_AUTH", async () => {
    const cf = fakeCloudflare();
    await assert.rejects(createCloudflareProvider({ env: {}, fetch: cf.fetch }).preflight!(project()), { code: "CLOUD_AUTH" });
    const wrong = createCloudflareProvider({ env: { ...env, CLOUDFLARE_API_TOKEN: "nope" }, fetch: cf.fetch });
    await assert.rejects(wrong.preflight!(project()), { code: "CLOUD_AUTH" });
  });

  it("makes valid, deterministic Worker names and prices sites at $0", () => {
    const long = scriptName("a".repeat(32), "b".repeat(32));
    assert.ok(long.length <= 63);
    assert.match(long, /^[a-z0-9-]+$/);
    assert.equal(scriptName("p", "n"), "p-n");
    assert.equal(estimateResource(site, "cloudflare", "global").monthlyUsd, 0);
    assert.match(createCloudflareProvider({ env }).unsupported?.({ ...site, domain: "x.com" }) ?? "", /domains/);
  });
});

/** Serve the in-memory Cloudflare fake over HTTP, for code paths that build their own provider. */
async function serveFake(cf: ReturnType<typeof fakeCloudflare>) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://fake${req.url}`;
    const headers = new Headers(req.headers as Record<string, string>);
    let body: RequestInit["body"] = chunks.length ? Buffer.concat(chunks) : undefined;
    if (headers.get("content-type")?.startsWith("multipart/")) body = await new Request(url, { method: req.method, headers, body }).formData();
    const r = await cf.fetch(url, { method: req.method, headers, body });
    res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`, close: () => server.close() };
}

describe("guard", () => {
  const t0 = new Date("2026-11-10T00:00:00Z");
  const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);
  const account = (over: Partial<Account> = {}): Account => ({
    version: 1, monthlyCapUsd: 100, balanceUsd: 40, transactions: [], settledAt: t0.toISOString(),
    projects: { "/a": { project: "a", cloud: "gcp", monthlyUsd: 30, live: true, updatedAt: "" } },
    ...over,
  });

  it("charges running resources to the balance by the hour, in whole cents", () => {
    const a = account();
    assert.equal(settle(a, day(1)), 1);
    assert.equal(a.balanceUsd, 39);
    assert.equal(a.transactions[0]!.kind, "charge");
    settle(a, new Date(day(1).getTime() + 3_600_000 * 12));
    assert.equal(a.transactions.length, 1, "same-day charges merge into one line");
    assert.equal(a.balanceUsd, 38.5);
    const idle = account({ projects: {} });
    settle(idle, day(5));
    assert.equal(idle.balanceUsd, 40);
    assert.equal(idle.settledAt, day(5).toISOString(), "idle time is never charged later");
  });

  it("warns as the balance or the cap gets close, and pauses before money runs out", () => {
    assert.equal(assess(account(), t0).level, "ok");
    const low = assess(account({ balanceUsd: 5 }), t0);
    assert.equal(low.level, "warn");
    assert.equal(low.runwayDays, 5);
    assert.match(low.reasons[0]!, /about 5 days/);
    assert.equal(assess(account({ balanceUsd: 0.5 }), t0).level, "pause");
    assert.equal(assess(account({ balanceUsd: 40 }), day(39.6)).level, "pause", "the balance drains as time passes");
    assert.equal(assess(account({ monthlyCapUsd: 25 }), t0).level, "warn", "on track for $20 of a $25 cap");
    const spent = account({ transactions: [{ id: "c", kind: "charge", amountUsd: 100, at: t0.toISOString() }] });
    assert.match(assess(spent, t0).reasons[0]!, /reached the \$100\.00 cap/);
  });

  it("pausing keeps every running database, even one already removed from unlocal.json", async () => {
    const { state } = await apply(config(), emptyState("demo"));
    const paused = pausedConfig(config(), state);
    assert.deepEqual(Object.keys(paused.resources), ["db"]);
    const plan = createPlan(paused, state);
    assert.equal(plan.destructive, false);
    assert.deepEqual(plan.actions.filter((a) => a.kind === "delete").map((a) => a.name).sort(), ["api", "web"]);
    const dropped = pausedConfig({ ...config(), resources: {} }, state);
    assert.deepEqual(Object.keys(dropped.resources), ["db"]);
    assert.equal(createPlan(dropped, state).destructive, false);
  });

  it("freezes on a deploy loop", () => {
    const a = account();
    for (let i = 0; i < 50; i++) assert.equal(recordDeploy(a, t0), false);
    assert.equal(recordDeploy(a, t0), true);
    assert.match(a.frozen!.reason, /51 deploys/);
    const later = account();
    for (let i = 0; i < 60; i++) recordDeploy(later, new Date(t0.getTime() + i * 120_000));
    assert.equal(later.frozen, undefined, "spread over two hours is fine");
  });

  it("takes live sites offline and freezes deploys when the balance is about to run out", async () => {
    const cf = fakeCloudflare();
    const fake = await serveFake(cf);
    try {
      const home = mkdtempSync(path.join(tmpdir(), "unlocal-guard-"));
      const dir = mkdtempSync(path.join(tmpdir(), "unlocal-guard-site-"));
      mkdirSync(path.join(dir, "dist"));
      writeFileSync(path.join(dir, "dist", "index.html"), "<h1>hi</h1>");
      writeFileSync(path.join(dir, "unlocal.json"), JSON.stringify({ project: "demo", cloud: "cloudflare", budget: { monthlyUsd: 5 }, resources: { web: { type: "site", path: "./dist" } } }));
      const env = { UNLOCAL_HOME: home, CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_BASE: fake.base };
      writeFileSync(path.join(home, "account.json"), JSON.stringify(account({ balanceUsd: 10, projects: {} })));

      const { up } = await import("../src/index.ts");
      const deployed = await up(dir, env, { sim: false });
      assert.match(deployed.url!, /workers\.dev/);
      assert.ok(cf.scripts.has("demo-web"));

      // Pretend this site costs $30/mo and the balance is nearly gone.
      const a = JSON.parse(readFileSync(path.join(home, "account.json"), "utf8")) as Account;
      a.projects[path.resolve(dir)]!.monthlyUsd = 30;
      a.balanceUsd = 0.5;
      a.settledAt = new Date().toISOString();
      writeFileSync(path.join(home, "account.json"), JSON.stringify(a));

      const r = await runGuard(env);
      assert.equal(r.status.level, "pause");
      assert.equal(r.froze, true);
      assert.deepEqual(r.paused.map((p) => [p.project, p.stopped, p.how]), [["demo", ["web"], "paused"]]);
      assert.equal(cf.scripts.get("demo-web")!.routed, false, "offline: workers.dev no longer routes to it");
      assert.ok(cf.scripts.has("demo-web"), "but the Worker and its files are kept");
      const after = JSON.parse(readFileSync(path.join(home, "account.json"), "utf8")) as Account;
      assert.equal(after.projects[path.resolve(dir)]!.monthlyUsd, 0, "paused costs nothing");
      await assert.rejects(up(dir, env, { sim: false }), { code: "ACCOUNT_FROZEN" });

      // A human unfreezes and tops up; the next deploy resumes the same Worker, uploading nothing new.
      const { unfreezeAccount } = await import("../src/index.ts");
      await unfreezeAccount(env);
      const topped = JSON.parse(readFileSync(path.join(home, "account.json"), "utf8")) as Account;
      topped.balanceUsd = 50;
      writeFileSync(path.join(home, "account.json"), JSON.stringify(topped));
      const uploadsBefore = cf.uploads();
      const resumed = await up(dir, env, { sim: false });
      assert.deepEqual(resumed.plan.actions.map((a) => [a.kind, a.changes]), [["update", ["paused"]]]);
      assert.equal(cf.uploads(), uploadsBefore);
      assert.equal(cf.scripts.get("demo-web")!.routed, true, "back online");
      assert.equal(resumed.state.resources.web!.paused, undefined);
    } finally {
      fake.close();
    }
  });
});

describe("metering", () => {
  const t0 = new Date("2026-11-10T12:00:00Z");
  const hours = (n: number) => new Date(t0.getTime() + n * 3_600_000);
  const base = (over: Partial<Account> = {}): Account => ({
    version: 1, monthlyCapUsd: 100, balanceUsd: 40, transactions: [], settledAt: t0.toISOString(), projects: {}, ...over,
  });

  it("prices only what the cloud lists a meter for, for the resource types it costs money for", () => {
    const lines = priceUsage("cloudflare", "demo", "api", "service", { workerRequests: 2_000_000, somethingElse: 5 });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.usd.toFixed(2), "0.60");
    const site = priceUsage("cloudflare", "demo", "web", "site", { workerRequests: 2_000_000 });
    assert.deepEqual(site.map((l) => [l.quantity, l.usd]), [[2_000_000, 0]], "a site's 404s are counted, not charged");
  });

  it("pauses when measured usage would drain the balance within a day", () => {
    const a = base({ balanceUsd: 5, meterLog: [{ project: "a", from: hours(-1).toISOString(), to: t0.toISOString(), usd: 2 }] });
    const s = assess(a, t0);
    assert.equal(s.meteredPerDayUsd, 48);
    assert.equal(s.level, "pause", "$2 in the last hour is $48/day against $5 left");
  });

  it("pauses a free deploy the moment it starts costing money", () => {
    const free = base({ monthlyCapUsd: null, balanceUsd: 0, meterLog: [{ project: "a", from: hours(-1).toISOString(), to: t0.toISOString(), usd: 0.001 }] });
    assert.equal(assess(free, t0).level, "pause");
  });

  it("warns on a spike against the day's pace", () => {
    const log = [
      { project: "a", from: hours(-24).toISOString(), to: hours(-1).toISOString(), usd: 0.2 },
      { project: "a", from: hours(-1).toISOString(), to: t0.toISOString(), usd: 0.2 },
    ];
    const s = assess(base({ balanceUsd: 100, meterLog: log }), t0);
    assert.ok(s.reasons.some((r) => /spiked/.test(r)), s.reasons.join("; "));
    const steady = [{ project: "a", from: hours(-1).toISOString(), to: t0.toISOString(), usd: 0.2 }];
    assert.ok(!assess(base({ balanceUsd: 100, meterLog: steady }), t0).reasons.some((r) => /spiked/.test(r)), "no history, no spike");
  });

  it("reads usage from Cloudflare, never charges a free site for it, and keeps going when a read fails", async () => {
    const cf = fakeCloudflare();
    const fake = await serveFake(cf);
    try {
      const home = mkdtempSync(path.join(tmpdir(), "unlocal-meter-"));
      const dir = mkdtempSync(path.join(tmpdir(), "unlocal-meter-site-"));
      mkdirSync(path.join(dir, "dist"));
      writeFileSync(path.join(dir, "dist", "index.html"), "<h1>hi</h1>");
      writeFileSync(path.join(dir, "unlocal.json"), JSON.stringify({ project: "demo", cloud: "cloudflare", budget: { monthlyUsd: 5 }, resources: { web: { type: "site", path: "./dist" } } }));
      const env = { UNLOCAL_HOME: home, CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_BASE: fake.base };
      // A free site: no cap, no balance.
      writeFileSync(path.join(home, "account.json"), JSON.stringify(base({ monthlyCapUsd: null, balanceUsd: 0 })));
      const { up } = await import("../src/index.ts");
      await up(dir, env, { sim: false });
      const deployedAt = new Date();

      cf.hit("demo-web", new Date(deployedAt.getTime() + 60_000), 10_000_000);
      const later = new Date(deployedAt.getTime() + 2 * 3_600_000);
      const first = await meterUsage(env, later);
      assert.equal(first.errors.length, 0);
      assert.deepEqual(first.lines.map((l) => [l.resource, l.metric, l.quantity, l.usd]), [["web", "workerRequests", 10_000_000, 0]]);
      assert.equal(first.chargedUsd, 0);
      const after = await loadAccount(env);
      assert.equal(after.balanceUsd, 0);
      assert.equal(assess(after, later).level, "ok", "a free site with traffic stays up");

      cf.hit("demo-web", new Date(later.getTime() - METER_LAG_MS - 60_000), 1); // in a window already read
      const again = await meterUsage(env, later);
      assert.equal(again.lines.length, 0, "the same window is never read twice");

      const broken = await meterUsage({ ...env, CLOUDFLARE_API_TOKEN: "wrong" }, new Date(later.getTime() + 3_600_000));
      assert.equal(broken.errors.length, 1, "a failed read is reported, not fatal");
      const entry = (await loadAccount(env)).projects[path.resolve(dir)]!;
      assert.equal(entry.meteredAt, new Date(later.getTime() - METER_LAG_MS).toISOString(), "and retried from the same point");
    } finally {
      fake.close();
    }
  });
});

describe("cloudflare retries", () => {
  it("retries a request that never got an answer, but never an HTTP error", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return new Response("ok");
    }) as typeof fetch;
    assert.equal(await (await withRetries(flaky, [0, 0, 0])("http://x")).text(), "ok");
    assert.equal(calls, 3);

    let errors = 0;
    const failing = (async () => (errors++, new Response("no", { status: 500 }))) as typeof fetch;
    assert.equal((await withRetries(failing, [0, 0])("http://x")).status, 500);
    assert.equal(errors, 1);

    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(withRetries(down, [0, 0])("http://x"), /fetch failed/);
  });
});

describe("aws connection", () => {
  const roleArn = "arn:aws:iam::123456789012:role/unlocal-deploy";
  const policyStatements = () => {
    const role = (connectTemplate() as any).Resources.DeployRole.Properties;
    return role.Policies.flatMap((p: any) => p.PolicyDocument.Statement) as { Action: string[]; Resource: unknown }[];
  };

  it("the role can never touch IAM, and S3 only on unlocal's buckets", () => {
    const actions = policyStatements().flatMap((st) => st.Action);
    assert.ok(actions.length > 0);
    assert.equal(actions.filter((a) => a.startsWith("iam:") || a.startsWith("organizations:") || a === "*").length, 0);
    for (const st of policyStatements().filter((st) => st.Action.some((a) => a.startsWith("s3:")))) {
      assert.match(JSON.stringify(st.Resource), /s3:::unlocal-\*/);
    }
  });

  it("allows every AWS call the provider makes", () => {
    const source = readFileSync(new URL("../src/providers/aws.ts", import.meta.url), "utf8");
    const commands = [...new Set([...source.matchAll(/new (\w+)Command\(/g)].map((m) => m[1]!))];
    // SDK command → IAM action, where the names differ.
    const special: Record<string, string[]> = {
      CreateDistributionWithTags: ["cloudfront:CreateDistribution", "cloudfront:TagResource"],
      PutPublicAccessBlock: ["s3:PutBucketPublicAccessBlock"],
      DeleteObjects: ["s3:DeleteObject"],
      ListObjectsV2: ["s3:ListBucket"],
      GetCallerIdentity: [], // needs no permission
    };
    const allowed = new Set(policyStatements().flatMap((st) => st.Action));
    const service = (cmd: string) => (/Distribution|Invalidation|OriginAccess/.test(cmd) ? "cloudfront" : "s3");
    const missing = commands.flatMap((cmd) => (special[cmd] ?? [`${service(cmd)}:${cmd}`]).filter((a) => !allowed.has(a)));
    assert.deepEqual(missing, [], "add these to connectTemplate() in aws-connect.ts");
    assert.ok(allowed.has("cloudfront:GetDistribution"), "the deploy waiter polls GetDistribution");
  });

  it("trusts hosted unlocal only with the customer's ExternalId, and the connector user can only assume the role", () => {
    const t = connectTemplate() as any;
    const [, hosted] = t.Resources.DeployRole.Properties.AssumeRolePolicyDocument.Statement[0]["Fn::If"].slice(1);
    assert.deepEqual(hosted.Condition, { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } });
    const user = t.Resources.ConnectorUser;
    assert.equal(user.Condition, "Local");
    assert.deepEqual(user.Properties.Policies.flatMap((p: any) => p.PolicyDocument.Statement.map((st: any) => st.Action)), ["sts:AssumeRole"]);
    assert.equal(t.Resources.DeployRole.Properties.MaxSessionDuration, 3600);
  });

  it("assumes the role once, renews it before it expires, and shares one renewal", async () => {
    let clock = Date.parse("2026-11-05T12:00:00Z");
    const calls: any[] = [];
    const assume = async (input: any) => {
      calls.push(input);
      return { Credentials: { AccessKeyId: `AK${calls.length}`, SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(clock + 3_600_000) } };
    };
    const creds = assumeRoleCredentials({ roleArn, externalId: "ul_1" }, { assume, now: () => clock });
    const [a, b] = await Promise.all([creds(), creds()]);
    assert.equal(calls.length, 1, "concurrent calls share one assume");
    assert.equal(a.accessKeyId, "AK1");
    assert.equal(b.accessKeyId, "AK1");
    assert.equal(calls[0].ExternalId, "ul_1");
    clock += 50 * 60_000;
    assert.equal((await creds()).accessKeyId, "AK1", "still fresh at 50 minutes");
    clock += 6 * 60_000;
    assert.equal((await creds()).accessKeyId, "AK2", "renewed with 4 minutes left");
  });

  it("reports a revoked connection as CLOUD_AUTH with a way back", async () => {
    const creds = assumeRoleCredentials({ roleArn }, { assume: async () => { throw new Error("AccessDenied"); } });
    await assert.rejects(creds(), (err: any) => err.code === "CLOUD_AUTH" && /connect aws/.test(err.hint));
    assert.throws(() => assumeRoleCredentials({ roleArn: "not-an-arn" }), { code: "USAGE" });
  });

  it("uses explicit AWS keys first, then the saved connection, then the machine's login", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "unlocal-aws-"));
    assert.equal(awsCredentialsFor({ UNLOCAL_HOME: home }).source, "machine");
    await saveCredentials({ aws: { roleArn, accessKeyId: "AKIA", secretAccessKey: "x" } }, { UNLOCAL_HOME: home });
    assert.equal(awsCredentialsFor({ UNLOCAL_HOME: home }).source, "connection");
    assert.equal(awsCredentialsFor({ UNLOCAL_HOME: home, AWS_ACCESS_KEY_ID: "AKIA2" }).source, "env");
  });
});

describe("account lock", () => {
  it("never loses a write when many writers run at once", async () => {
    const env = { UNLOCAL_HOME: mkdtempSync(path.join(tmpdir(), "unlocal-lock-")) };
    await Promise.all(Array.from({ length: 25 }, () => withAccount(env, (a) => void (a.balanceUsd += 1))));
    assert.equal((await loadAccount(env)).balanceUsd, 25);
  });

  it("doesn't save when the change throws", async () => {
    const env = { UNLOCAL_HOME: mkdtempSync(path.join(tmpdir(), "unlocal-lock-")) };
    await assert.rejects(withAccount(env, (a) => { a.balanceUsd = 99; throw new Error("no"); }));
    assert.equal((await loadAccount(env)).balanceUsd, 0);
    await withAccount(env, () => {}); // and the lock was released
  });
});

describe("process lock", () => {
  const lockable = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "unlocal-flock-"));
    return { dir, file: path.join(dir, "state.json") };
  };

  it("serializes read-modify-write cycles on one file", async () => {
    const { file } = lockable();
    writeFileSync(file, "0");
    await Promise.all(Array.from({ length: 25 }, () => withLock(file, async () => {
      const n = Number(readFileSync(file, "utf8"));
      await new Promise((r) => setTimeout(r, 1));
      writeFileSync(file, String(n + 1));
    })));
    assert.equal(readFileSync(file, "utf8"), "25");
  });

  it("takes over a lock whose holder stopped refreshing it", async () => {
    const { file } = lockable();
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    assert.equal(await withLock(file, () => "ran", { staleMs: 1_000, waitMs: 1_000 }), "ran");
  });

  it("fails BUSY rather than running beside a live holder", async () => {
    const { file } = lockable();
    mkdirSync(`${file}.lock`);
    await assert.rejects(withLock(file, () => "no", { waitMs: 100, staleMs: 60_000 }), { code: "BUSY" });
  });
});

describe("credentials", () => {
  it("fills in connected credentials, but the environment wins", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "unlocal-creds-"));
    assert.equal(withCredentials({ UNLOCAL_HOME: home }).CLOUDFLARE_API_TOKEN, undefined);
    await saveCredentials({ cloudflare: { apiToken: "saved", accountId: "acc" } }, { UNLOCAL_HOME: home });
    assert.equal(withCredentials({ UNLOCAL_HOME: home }).CLOUDFLARE_API_TOKEN, "saved");
    assert.equal(withCredentials({ UNLOCAL_HOME: home, CLOUDFLARE_API_TOKEN: "env" }).CLOUDFLARE_API_TOKEN, "env");
  });
});

describe("balance", () => {
  it("credits once per external reference and enforces top-up limits", () => {
    const a = { version: 1 as const, monthlyCapUsd: null, balanceUsd: 0, projects: {}, transactions: [] };
    assert.equal(creditAccount(a, 20, "topup", "cs_1"), true);
    assert.equal(creditAccount(a, 20, "topup", "cs_1"), false);
    assert.equal(a.balanceUsd, 20);
    assert.throws(() => creditAccount(a, 1, "credit"), { code: "USAGE" });
    assert.throws(() => creditAccount(a, 5000, "credit"), { code: "USAGE" });
  });
});
