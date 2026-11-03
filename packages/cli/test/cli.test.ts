import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/unlocal.js", import.meta.url));

/** Runs the CLI against a simulated cloud, with an account file isolated to this test. */
function cli(dir: string, args: string[], env: Record<string, string> = {}, opts: { sim?: boolean } = {}) {
  const sim = opts.sim ?? true;
  const r = spawnSync(process.execPath, [BIN, "--dir", dir, "--json", ...(sim ? ["--sim"] : []), ...args], {
    encoding: "utf8",
    env: { ...process.env, UNLOCAL_HOME: path.join(dir, ".home"), ...env },
  });
  let body: any;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return { code: r.status, body };
}

/** Pre-fund the test's isolated account (humans do this through the console). */
function fund(dir: string, balanceUsd: number, monthlyCapUsd: number) {
  mkdirSync(path.join(dir, ".home"), { recursive: true });
  writeFileSync(
    path.join(dir, ".home", "account.json"),
    JSON.stringify({ version: 1, monthlyCapUsd, balanceUsd, projects: {}, transactions: [] }),
  );
}

function project(config?: object) {
  const dir = mkdtempSync(path.join(tmpdir(), "unlocal-"));
  if (config) {
    writeFileSync(path.join(dir, "unlocal.json"), JSON.stringify(config));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "index.html"), "<h1>hi</h1>");
  }
  return dir;
}

const fullstack = {
  project: "shop",
  budget: { monthlyUsd: 100 },
  resources: {
    web: { type: "site", path: "./dist" },
    db: { type: "postgres" },
  },
};

describe("unlocal CLI (agent contract)", () => {
  it("init → plan → apply --yes → status", () => {
    const dir = project();
    assert.equal(cli(dir, ["init", "--project", "blog", "--budget", "10"]).code, 0);
    assert.equal(cli(dir, ["init"]).body.error.code, "CONFIG_EXISTS");

    const plan = cli(dir, ["plan"]);
    assert.equal(plan.code, 0);
    assert.equal(plan.body.data.plan.summary.create, 1);

    const applied = cli(dir, ["apply", "--yes"]);
    assert.equal(applied.code, 0);
    assert.deepEqual(applied.body.data.applied, [{ kind: "create", name: "web" }]);

    const status = cli(dir, ["status"]);
    assert.equal(status.body.data.pendingChanges, 0);
    assert.match(status.body.data.resources.web.outputs.url, /^https:\/\//);
  });

  it("never prompts: apply without approval fails with exit 2", () => {
    const r = cli(project(fullstack), ["apply"]);
    assert.equal(r.code, 2);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "APPROVAL_REQUIRED");
    assert.ok(r.body.error.hint);
  });

  it("applies a saved plan, and rejects it once stale", () => {
    const dir = project(fullstack);
    const planFile = path.join(dir, "deploy.plan.json");
    cli(dir, ["plan", "--out", planFile]);

    const cfg = JSON.parse(readFileSync(path.join(dir, "unlocal.json"), "utf8"));
    cfg.resources.db.storageGb = 40;
    writeFileSync(path.join(dir, "unlocal.json"), JSON.stringify(cfg));
    const stale = cli(dir, ["apply", "--plan", planFile]);
    assert.equal(stale.code, 4);
    assert.equal(stale.body.error.code, "PLAN_STALE");

    cli(dir, ["plan", "--out", planFile]);
    assert.equal(cli(dir, ["apply", "--plan", planFile]).code, 0);
  });

  it("enforces the budget", () => {
    const r = cli(project({ ...fullstack, budget: { monthlyUsd: 5 } }), ["apply", "--yes"]);
    assert.equal(r.code, 2);
    assert.equal(r.body.error.code, "BUDGET_EXCEEDED");
  });

  it("guards databases on destroy", () => {
    const dir = project(fullstack);
    cli(dir, ["apply", "--yes"]);
    assert.equal(cli(dir, ["destroy", "--yes"]).body.error.code, "DESTRUCTIVE_CHANGE");
    const r = cli(dir, ["destroy", "--yes", "--allow-data-loss"]);
    assert.equal(r.code, 0);
    assert.equal(r.body.data.applied.length, 2);
  });

  it("reports structured validation errors with exit 3", () => {
    const r = cli(project({ project: "x", budget: { monthlyUsd: 10 }, resources: { api: { type: "service" } } }), ["validate"]);
    assert.equal(r.code, 3);
    assert.deepEqual(r.body.error.details, [{ path: "resources.api.source", message: "is required" }]);
  });

  it("surfaces partial failures", () => {
    const r = cli(project(fullstack), ["apply", "--yes"], { UNLOCAL_SIM_FAIL: "web" });
    assert.equal(r.code, 1);
    assert.equal(r.body.error.code, "APPLY_FAILED");
    assert.deepEqual(r.body.error.details.applied, ["db"]);
  });

  it("describes itself for agents", () => {
    const r = cli(project(), ["help"]);
    assert.ok(r.body.data.commands.some((c: { name: string }) => c.name === "apply"));
    assert.equal(r.body.data.exitCodes.BUDGET_EXCEEDED, 2);
  });

  it("starts a project on any cloud", () => {
    const dir = project();
    const r = cli(dir, ["init", "--cloud", "azure"]);
    assert.equal(r.body.data.config.cloud, "azure");
    assert.equal(r.body.data.config.region, "eastus");
    assert.equal(cli(project(), ["init", "--cloud", "ibm"]).body.error.code, "CONFIG_INVALID");
  });

  it("refuses real deploys until a human sets an account cap", () => {
    const dir = project({ ...fullstack, resources: { web: fullstack.resources.web } });
    const r = cli(dir, ["apply", "--yes"], {}, { sim: false });
    assert.equal(r.code, 2);
    assert.equal(r.body.error.code, "CAP_NOT_SET");
  });

  it("enforces the account cap on real deploys", () => {
    const dir = project(fullstack);
    cli(dir, ["cap", "5"]);
    const r = cli(dir, ["apply", "--yes"], {}, { sim: false });
    assert.equal(r.body.error.code, "CAP_EXCEEDED");
    assert.equal(r.body.error.details.limitUsd, 5);
  });

  it("refuses before touching anything when the cloud can't do every step", () => {
    const dir = project(fullstack);
    fund(dir, 100, 100);
    const r = cli(dir, ["apply", "--yes"], {}, { sim: false });
    assert.equal(r.code, 1);
    assert.equal(r.body.error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(r.body.error.details.resource, "db");

    const azure = project({ ...fullstack, cloud: "azure" });
    fund(azure, 100, 100);
    assert.equal(cli(azure, ["apply", "--yes"], {}, { sim: false }).body.error.code, "PROVIDER_UNAVAILABLE");
  });

  it("refuses real deploys the balance can't cover", () => {
    const dir = project({ ...fullstack, resources: { web: fullstack.resources.web } });
    cli(dir, ["cap", "10"]);
    const r = cli(dir, ["apply", "--yes"], {}, { sim: false });
    assert.equal(r.code, 2);
    assert.equal(r.body.error.code, "FUNDS_INSUFFICIENT");
  });

  it("shows the cap and every project's spend", () => {
    const dir = project(fullstack);
    assert.equal(cli(dir, ["cap"]).body.data.monthlyCapUsd, null);
    assert.equal(cli(dir, ["cap", "abc"]).code, 64);
    cli(dir, ["cap", "40"]);
    cli(dir, ["apply", "--yes"]);
    const r = cli(dir, ["cap"]);
    assert.equal(r.body.data.monthlyCapUsd, 40);
    assert.equal(r.body.data.liveMonthlyUsd, 0, "simulated deploys cost nothing");
    assert.equal(r.body.data.projects[0].project, "shop");
    assert.equal(r.body.data.projects[0].live, false);
    cli(dir, ["destroy", "--yes", "--allow-data-loss"]);
    assert.deepEqual(cli(dir, ["cap"]).body.data.projects, []);
  });

  it("redeploys when site files change", () => {
    const dir = project(fullstack);
    cli(dir, ["apply", "--yes"]);
    assert.equal(cli(dir, ["plan"]).body.data.plan.hasChanges, false);
    writeFileSync(path.join(dir, "dist", "index.html"), "<h1>changed</h1>");
    const web = cli(dir, ["plan"]).body.data.plan.actions.find((a: { name: string }) => a.name === "web");
    assert.equal(web.kind, "update");
    assert.deepEqual(web.changes, ["files"]);
  });

  it("rejects a site without index.html", () => {
    const dir = project(fullstack);
    writeFileSync(path.join(dir, "dist", "index.html"), "");
    mkdirSync(path.join(dir, "empty"));
    const cfg = { ...fullstack, resources: { web: { type: "site", path: "./empty" } } };
    writeFileSync(path.join(dir, "unlocal.json"), JSON.stringify(cfg));
    const r = cli(dir, ["plan"]);
    assert.equal(r.code, 3);
    assert.match(r.body.error.message, /no index\.html/);
  });

  it("rejects unknown flags and commands", () => {
    assert.equal(cli(project(), ["deploy"]).code, 64);
    assert.equal(cli(project(), ["plan", "--force"]).code, 64);
  });
});

describe("apps/www", () => {
  it("deploys with unlocal, within its own budget", () => {
    const dir = fileURLToPath(new URL("../../../apps/www", import.meta.url));
    const r = cli(dir, ["plan"]);
    assert.equal(r.code, 0);
    assert.equal(r.body.data.plan.budget.withinBudget, true);
  });
});
