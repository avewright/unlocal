import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    fund(dir, 0, 5);
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
    fund(dir, 0, 10);
    const r = cli(dir, ["apply", "--yes"], {}, { sim: false });
    assert.equal(r.code, 2);
    assert.equal(r.body.error.code, "FUNDS_INSUFFICIENT");
  });

  it("shows the cap and every project's spend", () => {
    const dir = project(fullstack);
    assert.equal(cli(dir, ["cap"]).body.data.monthlyCapUsd, null);
    assert.equal(cli(dir, ["cap", "abc"]).code, 64);
    assert.equal(cli(dir, ["cap", "40"]).body.error.code, "HUMAN_REQUIRED", "an agent's shell can't set the cap");
    fund(dir, 0, 40);
    assert.equal(cli(dir, ["cap", "50"]).body.error.code, "HUMAN_REQUIRED", "or raise it");
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

describe("unlocal up (localhost to live)", () => {
  const folder = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "unlocal-up-"));
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    return dir;
  };

  it("finds the built site, writes unlocal.json, deploys and returns the URL", () => {
    const dir = folder({ "dist/index.html": "<h1>hi</h1>", "package.json": "{}" });
    const r = cli(dir, ["up"]);
    assert.equal(r.code, 0);
    assert.match(r.body.data.url, /^https:\/\//);
    const written = JSON.parse(readFileSync(path.join(dir, "unlocal.json"), "utf8"));
    assert.equal(written.cloud, "cloudflare");
    assert.equal(written.resources.web.path, "./dist");
    assert.equal(written.budget.monthlyUsd, 5);
    const again = cli(dir, ["up"]);
    assert.equal(again.body.data.applied.length, 0);
    assert.equal(again.body.data.url, r.body.data.url);
  });

  it("returns the site's URL even when the project also has a service", () => {
    const dir = project({
      project: "shop",
      budget: { monthlyUsd: 100 },
      resources: {
        web: { type: "site", path: "./dist" },
        api: { type: "service", source: "./api" },
      },
    });
    const r = cli(dir, ["up"]);
    assert.equal(r.code, 0);
    assert.match(r.body.data.url, /^https:\/\/web--shop\./);
  });

  it("publishes a plain HTML folder as is, but never an app's root", () => {
    assert.equal(cli(folder({ "index.html": "<h1>hi</h1>" }), ["up"]).code, 0);
    const app = folder({ "index.html": "<div id=app>", "package.json": JSON.stringify({ scripts: { build: "vite build" } }) });
    const r = cli(app, ["up", "--skip-build"]);
    assert.equal(r.code, 3);
    assert.equal(r.body.error.code, "SITE_NOT_FOUND");
    assert.match(r.body.error.hint, /without --skip-build|npm run build/);
  });

  it("builds the app first, with its own build script", () => {
    const app = folder({
      "package.json": JSON.stringify({ scripts: { build: "node build.js" } }),
      "build.js": `require("fs").mkdirSync("dist", { recursive: true }); require("fs").writeFileSync("dist/index.html", "<h1>built</h1>");`,
    });
    const r = cli(app, ["up"]);
    assert.equal(r.code, 0, JSON.stringify(r.body));
    assert.equal(r.body.data.build.command, "npm run build");
    assert.equal(r.body.data.state.resources.web.spec.path, "./dist");
    assert.ok(r.body.data.url);
  });

  it("reports a failed build with its output, and writes nothing", () => {
    const app = folder({
      "package.json": JSON.stringify({ scripts: { build: "node -e \"console.error('Cannot find module ./App'); process.exit(2)\"" } }),
    });
    const r = cli(app, ["up"]);
    assert.equal(r.code, 1);
    assert.equal(r.body.error.code, "BUILD_FAILED");
    assert.ok(r.body.error.details.output.some((l: string) => /Cannot find module/.test(l)));
    assert.equal(existsSync(path.join(app, "unlocal.json")), false);
  });

  it("says what a framework needs when its build makes no static site", () => {
    const app = folder({ "package.json": JSON.stringify({ scripts: { build: "node -e 0" }, dependencies: { next: "15.0.0" } }), "node_modules/.keep": "" });
    const r = cli(app, ["up"]);
    assert.equal(r.body.error.code, "SITE_NOT_FOUND");
    assert.match(r.body.error.hint, /output: "export"/);
  });

  it("won't delete anything unattended", () => {
    const dir = folder({ "dist/index.html": "<h1>hi</h1>" });
    cli(dir, ["up"]);
    const file = path.join(dir, "unlocal.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), resources: {} }));
    const r = cli(dir, ["up"]);
    assert.equal(r.body.error.code, "APPROVAL_REQUIRED");
  });

  it("deploys free sites with no setup, but needs the human's cap for anything that costs money", () => {
    const offline = { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_BASE: "http://127.0.0.1:9" };
    const free = folder({ "dist/index.html": "<h1>hi</h1>" });
    assert.equal(cli(free, ["up"], offline, { sim: false }).body.error.code, "CLOUD_AUTH", "past the cap check, on to credentials");
    const paid = folder({ "dist/index.html": "<h1>hi</h1>" });
    assert.equal(cli(paid, ["up", "--cloud", "aws"], offline, { sim: false }).body.error.code, "CAP_NOT_SET");
    assert.equal(existsSync(path.join(paid, "unlocal.json")), false, "the folder is left as it was");
  });

  it("lets anyone lower the cap, since that only reduces risk", () => {
    const dir = project(fullstack);
    fund(dir, 0, 40);
    assert.equal(cli(dir, ["cap", "20"]).body.data.monthlyCapUsd, 20);
  });

  it("applies exactly the reviewed plan with --plan-id", () => {
    const dir = project(fullstack);
    assert.equal(cli(dir, ["apply", "--plan-id", "nope"]).body.error.code, "PLAN_STALE");
    const id = cli(dir, ["plan"]).body.data.plan.id;
    assert.equal(cli(dir, ["apply", "--plan-id", id]).code, 0);
  });
});

describe("guard and kill switch", () => {
  // Never reach a real Cloudflare account from tests, whatever the developer's environment holds.
  const offline = { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_BASE: "http://127.0.0.1:9" };

  it("freeze stops live deploys until a human unfreezes", () => {
    const dir = project({ project: "site", cloud: "cloudflare", budget: { monthlyUsd: 5 }, resources: { web: { type: "site", path: "./dist" } } });
    fund(dir, 20, 10);
    const frozen = cli(dir, ["freeze"], offline, { sim: false });
    assert.equal(frozen.code, 0);
    const refused = cli(dir, ["apply", "--yes"], offline, { sim: false });
    assert.equal(refused.code, 2);
    assert.equal(refused.body.error.code, "ACCOUNT_FROZEN");
    assert.match(refused.body.error.hint, /unfreeze/);
    assert.equal(cli(dir, ["cap"], offline, { sim: false }).body.data.guard.frozen.by, "human");
    const unfreeze = cli(dir, ["unfreeze"], offline, { sim: false });
    assert.equal(unfreeze.code, 2);
    assert.equal(unfreeze.body.error.code, "HUMAN_REQUIRED");
    const file = path.join(dir, ".home", "account.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), frozen: null })); // what the human's unfreeze does
    assert.equal(cli(dir, ["apply", "--yes"], offline, { sim: false }).body.error.code, "CLOUD_AUTH", "past the freeze, on to credentials");
  });

  it("guard reports burn and runway, and --dry-run changes nothing", () => {
    const dir = project();
    mkdirSync(path.join(dir, ".home"), { recursive: true });
    writeFileSync(path.join(dir, ".home", "account.json"), JSON.stringify({
      version: 1, monthlyCapUsd: 50, balanceUsd: 0.4, transactions: [], settledAt: new Date().toISOString(),
      projects: { "/nowhere": { project: "x", cloud: "gcp", monthlyUsd: 30, live: true, updatedAt: "" } },
    }));
    const r = cli(dir, ["guard", "--dry-run"], offline, { sim: false });
    assert.equal(r.code, 0);
    assert.equal(r.body.data.status.level, "pause");
    assert.equal(r.body.data.paused.length, 0);
    assert.equal(cli(dir, ["cap"], offline, { sim: false }).body.data.guard.frozen, null, "dry run froze nothing");
  });
});

describe("unlocal connect aws", () => {
  it("prints the CloudFormation template, but only a person can connect", () => {
    const dir = project();
    const t = cli(dir, ["connect", "aws", "--template"]);
    assert.equal(t.code, 0);
    assert.equal(t.body.data.Resources.DeployRole.Properties.RoleName, "unlocal-deploy");
    const r = cli(dir, ["connect", "aws"]);
    assert.equal(r.code, 2);
    assert.equal(r.body.error.code, "HUMAN_REQUIRED");
    assert.equal(cli(dir, ["connect", "gcp"]).code, 64);
  });

  it("disconnect forgets the saved connection and keeps the others", () => {
    const dir = project();
    const home = path.join(dir, ".home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "credentials.json"), JSON.stringify({
      cloudflare: { apiToken: "t", accountId: "a" },
      aws: { roleArn: "arn:aws:iam::123456789012:role/unlocal-deploy", accessKeyId: "AKIA", secretAccessKey: "x" },
    }));
    assert.equal(cli(dir, ["disconnect", "aws"]).code, 0);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(home, "credentials.json"), "utf8"))), ["cloudflare"]);
  });
});

describe("unlocal mcp", () => {
  const session = (dir: string, messages: object[]) => {
    const r = spawnSync(process.execPath, [BIN, "mcp", "--sim"], {
      encoding: "utf8",
      input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      env: { ...process.env, UNLOCAL_HOME: path.join(dir, ".home") },
    });
    return r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  };

  it("speaks MCP and deploys with the CLI's guardrails", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "unlocal-mcp-"));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "index.html"), "<h1>hi</h1>");
    const [init, list, call, bad] = session(dir, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "up", arguments: { dir } } },
      { jsonrpc: "2.0", id: 4, method: "nope" },
    ]);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("up") && names.includes("account"));
    assert.ok(!names.some((n: string) => /cap|fund/.test(n)), "no tool can change the cap or add money");
    assert.equal(call.result.isError, false);
    assert.match(JSON.parse(call.result.content[0].text).data.url, /^https:\/\//);
    assert.equal(bad.error.code, -32601);
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
