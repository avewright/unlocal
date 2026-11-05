import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { deployFolder, startControlServer, type RunningControlServer } from "../src/index.ts";

const ADMIN = "test-admin-token";

async function setup(): Promise<{ server: RunningControlServer; dataDir: string; token: string; tenantId: string }> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "unlocal-client-"));
  const server = await startControlServer({ dataDir, adminToken: ADMIN, sim: true });
  const res = await fetch(`${server.url}/v1/admin/tenants`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme", monthlyCapUsd: 5, balanceUsd: 50 }),
  });
  const body = (await res.json()) as { data: { token: string; tenant: { id: string } } };
  return { server, dataDir, token: body.data.token, tenantId: body.data.tenant.id };
}

function builtSite(text = "<h1>hi</h1>"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "unlocal-site-"));
  mkdirSync(path.join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "index.html"), text);
  writeFileSync(path.join(dir, "dist", "assets", "app.js"), "console.log('hi')");
  return dir;
}

describe("remote deploy client", () => {
  it("builds, packs and deploys a folder through the control plane", async () => {
    const { server, dataDir, token, tenantId } = await setup();
    try {
      const dir = builtSite();
      const result = await deployFolder({ controlUrl: server.url, token, dir, project: "site", build: false });
      assert.match(result.url!, /^https:\/\/web--acme-site\./);
      assert.equal(result.project, "acme-site");
      assert.deepEqual(result.applied, [{ kind: "create", name: "web" }]);
      assert.equal(
        readFileSync(path.join(dataDir, "tenants", tenantId, "projects", "site", "public", "assets", "app.js"), "utf8"),
        "console.log('hi')",
      );

      const changed = builtSite("<h1>changed</h1>");
      const second = await deployFolder({ controlUrl: server.url, token, dir: changed, project: "site", build: false });
      assert.equal(second.url, result.url);
      assert.deepEqual(second.applied, [{ kind: "update", name: "web" }]);
    } finally {
      await server.close();
    }
  });

  it("surfaces the API's error code and hint", async () => {
    const { server } = await setup();
    try {
      await assert.rejects(
        deployFolder({ controlUrl: server.url, token: "ul_wrong", dir: builtSite(), build: false }),
        { code: "UNAUTHENTICATED" },
      );
    } finally {
      await server.close();
    }
  });

  it("refuses a folder with no built site, and a missing control URL", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "unlocal-empty-"));
    await assert.rejects(
      deployFolder({ controlUrl: "http://127.0.0.1:1", token: "ul_x", dir: empty, build: false }),
      { code: "SITE_NOT_FOUND" },
    );
    await assert.rejects(
      deployFolder({ controlUrl: "", token: "ul_x", dir: empty, build: false }),
      { code: "USAGE" },
    );
  });
});
