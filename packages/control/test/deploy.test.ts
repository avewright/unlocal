import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { deploySite, hostedProjectName, safeRelativePath, type BundleFile } from "../src/index.ts";

const file = (at: string, text: string): BundleFile => ({ path: at, content: Buffer.from(text) });

/** A tenant's isolated home, with the cap/balance the control plane would have written. */
function tenant(cap = 5, balanceUsd = 100) {
  const root = mkdtempSync(path.join(tmpdir(), "unlocal-control-"));
  const home = path.join(root, "home");
  mkdirSync(home);
  writeFileSync(path.join(home, "account.json"), JSON.stringify({
    version: 1, monthlyCapUsd: cap, balanceUsd, projects: {}, transactions: [],
  }));
  return { root, home, env: { UNLOCAL_HOME: home } };
}

const site = (text = "<h1>hi</h1>"): BundleFile[] => [file("index.html", text), file("assets/app.css", "body{}")];

describe("hosted deploy", () => {
  it("deploys an uploaded site and returns its URL", async () => {
    const t = tenant();
    const projectDir = path.join(t.root, "acme", "site");
    const r = await deploySite({
      projectDir, tenant: "acme", project: "site", files: site(), budgetUsd: 5, env: t.env, sim: true,
    });
    assert.match(r.url!, /^https:\/\/web--acme-site\.global\.cloudflare\.sim\.unlocal\.dev$/);
    assert.equal(r.monthlyUsd, 0);
    assert.deepEqual(r.applied, [{ kind: "create", name: "web" }]);
    assert.equal(readFileSync(path.join(projectDir, "public", "assets", "app.css"), "utf8"), "body{}");
    const config = JSON.parse(readFileSync(path.join(projectDir, "unlocal.json"), "utf8"));
    assert.equal(config.project, "acme-site");
    assert.equal(config.resources.web.path, "./public");
  });

  it("redeploys changed files as an update and keeps the same URL", async () => {
    const t = tenant();
    const projectDir = path.join(t.root, "acme", "site");
    const input = { projectDir, tenant: "acme", project: "site", budgetUsd: 5, env: t.env, sim: true } as const;
    const first = await deploySite({ ...input, files: site() });
    const second = await deploySite({ ...input, files: site("<h1>changed</h1>") });
    assert.equal(second.url, first.url);
    assert.deepEqual(second.applied, [{ kind: "update", name: "web" }]);
  });

  it("keeps two tenants' same-named projects apart", async () => {
    const acme = tenant();
    const beta = tenant();
    const a = await deploySite({
      projectDir: path.join(acme.root, "site"), tenant: "acme", project: "site", files: site(), budgetUsd: 5, env: acme.env, sim: true,
    });
    const b = await deploySite({
      projectDir: path.join(beta.root, "site"), tenant: "beta", project: "site", files: site(), budgetUsd: 5, env: beta.env, sim: true,
    });
    assert.equal(a.project, "acme-site");
    assert.equal(b.project, "beta-site");
    assert.notEqual(a.url, b.url);
  });
});

describe("hosted bundle", () => {
  it("refuses paths that escape the site root", async () => {
    const t = tenant();
    for (const bad of ["../evil.html", "/etc/passwd", "assets\\..\\evil.html", "a//b.html", "./index.html"]) {
      await assert.rejects(
        deploySite({
          projectDir: path.join(t.root, "site"), tenant: "acme", project: "site",
          files: [file("index.html", "ok"), file(bad, "no")], budgetUsd: 5, env: t.env, sim: true,
        }),
        { code: "USAGE" },
        bad,
      );
    }
    assert.throws(() => safeRelativePath("a/../../b"), { code: "USAGE" });
  });

  it("needs an index.html and respects size limits", async () => {
    const t = tenant();
    const base = { projectDir: path.join(t.root, "site"), tenant: "acme", project: "site", budgetUsd: 5, env: t.env, sim: true };
    await assert.rejects(deploySite({ ...base, files: [file("about.html", "x")] }), (err: unknown) => {
      return err instanceof Error && /index\.html/.test(err.message);
    });
    await assert.rejects(deploySite({ ...base, files: site(), limits: { maxBytes: 10 } }), (err: unknown) => {
      return err instanceof Error && /byte limit/.test(err.message);
    });
    await assert.rejects(deploySite({ ...base, files: [], }), { code: "USAGE" });
    await assert.rejects(
      deploySite({ ...base, files: [file("index.html", "same"), file("INDEX.html", "clash")] }),
      (err: unknown) => err instanceof Error && /duplicate/.test(err.message),
    );
  });
});

describe("hosted project names", () => {
  it("is unique, cloud-safe and bounded", () => {
    assert.equal(hostedProjectName("Acme Inc", "Docs Site"), "acme-inc-docs-site");
    assert.equal(hostedProjectName("123", "site"), "p-123-site");
    const long = hostedProjectName("a".repeat(32), "b".repeat(32));
    assert.ok(long.length <= 32, long);
    assert.match(long, /^[a-z][a-z0-9-]*[a-z0-9]$/);
    assert.notEqual(long, hostedProjectName("a".repeat(32), "b".repeat(31) + "c"));
  });
});
