import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOUDS,
  bucketName,
  capStatus,
  creditAccount,
  distributionConfig,
  createAwsProvider,
  CLOUDS_INFO,
  UnlocalError,
  applyPlan,
  createPlan,
  createSimProvider,
  emptyState,
  estimateResource,
  parseConfig,
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
      const c = config({ cloud });
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
        for (const [name, spec] of Object.entries(config({ cloud, region }).resources)) {
          const est = estimateResource(spec, cloud, region);
          assert.ok(est.monthlyUsd >= 0 && Number.isFinite(est.monthlyUsd), `${cloud} ${region} ${name}`);
          if (spec.type !== "site") assert.ok(est.monthlyUsd > 0, `${cloud} ${name} should cost something`);
        }
      }
    }
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
