import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  startControlServer,
  type RunningControlServer,
} from "../src/index.ts";

const ADMIN = "test-admin-token";
const SECRET = "test-encryption-secret";
const b64 = (text: string) => Buffer.from(text).toString("base64");
const site = (text = "<h1>hi</h1>") => [
  { path: "index.html", content: b64(text) },
  { path: "assets/app.css", content: b64("body{}") },
];

async function withServer(
  fn: (server: RunningControlServer, dataDir: string) => Promise<void>,
  options: { sim?: boolean; secret?: string } = {},
): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "unlocal-control-"));
  const server = await startControlServer({
    dataDir,
    adminToken: ADMIN,
    secret: options.secret ?? SECRET,
    sim: options.sim ?? true,
  });
  try {
    await fn(server, dataDir);
  } finally {
    await server.close();
  }
}

async function call(
  server: RunningControlServer,
  method: string,
  route: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.url}${route}`, {
    method,
    headers: {
      connection: "close",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: await res.json() };
}

async function tenant(server: RunningControlServer, overrides: Record<string, unknown> = {}) {
  const res = await call(server, "POST", "/v1/admin/tenants", {
    token: ADMIN,
    body: { name: "Acme", monthlyCapUsd: 5, balanceUsd: 50, ...overrides },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data as { tenant: { id: string; slug: string; name: string }; token: string };
}

describe("control plane", () => {
  it("creates a tenant, deploys a site, and reports usage", async () => {
    await withServer(async (server) => {
      const { token } = await tenant(server);
      const deploy = await call(server, "POST", "/v1/deploy", { token, body: { project: "site", files: site() } });
      assert.equal(deploy.status, 200, JSON.stringify(deploy.body));
      assert.match(deploy.body.data.url, /^https:\/\/web--acme-site\./);
      assert.equal(deploy.body.data.project, "acme-site");
      assert.equal(deploy.body.data.balanceUsd, 50);

      const usage = await call(server, "GET", "/v1/usage", { token });
      assert.equal(usage.status, 200);
      assert.equal(usage.body.data.balanceUsd, 50);
      assert.equal(usage.body.data.monthlyCapUsd, 5);
      assert.equal(usage.body.data.projects.length, 1);
      assert.equal(usage.body.data.projects[0].url, deploy.body.data.url);
      assert.equal(usage.body.data.guard.level, "ok");
    });
  });

  it("refuses missing, wrong and admin tokens where they don't belong", async () => {
    await withServer(async (server) => {
      const { token } = await tenant(server);
      assert.equal((await call(server, "POST", "/v1/deploy", { body: { project: "site", files: site() } })).status, 401);
      assert.equal((await call(server, "GET", "/v1/usage", { token: "ul_nope" })).status, 401);
      assert.equal((await call(server, "POST", "/v1/admin/tenants", { token, body: { name: "Evil", monthlyCapUsd: 5 } })).status, 401);
      assert.equal((await call(server, "GET", "/v1/health")).status, 200);
    });
  });

  it("keeps two tenants' same-named projects apart", async () => {
    await withServer(async (server) => {
      const acme = await tenant(server);
      const beta = await tenant(server, { name: "Beta" });
      const a = await call(server, "POST", "/v1/deploy", { token: acme.token, body: { project: "site", files: site("<h1>acme</h1>") } });
      const b = await call(server, "POST", "/v1/deploy", { token: beta.token, body: { project: "site", files: site("<h1>beta</h1>") } });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(a.body.data.project, "acme-site");
      assert.equal(b.body.data.project, "beta-site");
      assert.notEqual(a.body.data.url, b.body.data.url);
      const usage = await call(server, "GET", "/v1/usage", { token: acme.token });
      assert.equal(usage.body.data.projects.length, 1);
      assert.equal(usage.body.data.projects[0].url, a.body.data.url);
    });
  });

  it("rejects paths that escape the site root", async () => {
    await withServer(async (server) => {
      const { token } = await tenant(server);
      for (const at of ["../evil.html", "/etc/passwd", "a/../../b.html"]) {
        const res = await call(server, "POST", "/v1/deploy", {
          token,
          body: { project: "site", files: [{ path: at, content: b64("no") }, ...site()] },
        });
        assert.equal(res.status, 400, at);
        assert.equal(res.body.error.code, "USAGE");
      }
    });
  });

  it("rotates a token and invalidates the old one", async () => {
    await withServer(async (server) => {
      const created = await tenant(server);
      assert.equal((await call(server, "GET", "/v1/usage", { token: created.token })).status, 200);
      const rotated = await call(server, "POST", `/v1/admin/tenants/${created.tenant.id}/tokens`, { token: ADMIN });
      assert.equal(rotated.status, 200);
      assert.equal((await call(server, "GET", "/v1/usage", { token: created.token })).status, 401);
      assert.equal((await call(server, "GET", "/v1/usage", { token: rotated.body.data.token })).status, 200);
    });
  });

  it("adds funds only through the admin route", async () => {
    await withServer(async (server) => {
      const created = await tenant(server, { balanceUsd: 0 });
      assert.equal((await call(server, "POST", `/v1/admin/tenants/${created.tenant.id}/funds`, { token: created.token, body: { usd: 10 } })).status, 401);
      const funded = await call(server, "POST", `/v1/admin/tenants/${created.tenant.id}/funds`, { token: ADMIN, body: { usd: 10 } });
      assert.equal(funded.status, 200);
      const usage = await call(server, "GET", "/v1/usage", { token: created.token });
      assert.equal(usage.body.data.balanceUsd, 10);
    });
  });

  it("stores cloud credentials encrypted, never in plaintext", async () => {
    await withServer(async (server, dataDir) => {
      const created = await tenant(server);
      const apiToken = "cf-super-secret-token";
      const saved = await call(server, "POST", `/v1/admin/tenants/${created.tenant.id}/cloudflare`, {
        token: ADMIN,
        body: { apiToken, accountId: "a".repeat(32) },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const raw = readFileSync(path.join(dataDir, "control.json"), "utf8");
      assert.ok(!raw.includes(apiToken), "the token is not stored in plaintext");
      const blob = (JSON.parse(raw) as { tenants: Record<string, { cloudflare: string }> }).tenants[created.tenant.id]!.cloudflare;
      assert.equal((JSON.parse(decryptSecret(blob, SECRET)) as { apiToken: string }).apiToken, apiToken);
    });
  });

  it("refuses to store credentials without an encryption secret", async () => {
    await withServer(async (server) => {
      const created = await tenant(server);
      const res = await call(server, "POST", `/v1/admin/tenants/${created.tenant.id}/cloudflare`, {
        token: ADMIN,
        body: { apiToken: "x", accountId: "a".repeat(32) },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "CONFIG_INVALID");
    }, { secret: "" });
  });

  it("serializes concurrent deploys to one project", async () => {
    await withServer(async (server, dataDir) => {
      const created = await tenant(server);
      const [first, second] = await Promise.all([
        call(server, "POST", "/v1/deploy", { token: created.token, body: { project: "site", files: site("<h1>one</h1>") } }),
        call(server, "POST", "/v1/deploy", { token: created.token, body: { project: "site", files: site("<h1>two</h1>") } }),
      ]);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(first.body.data.url, second.body.data.url);
      const html = readFileSync(path.join(dataDir, "tenants", created.tenant.id, "projects", "site", "public", "index.html"), "utf8");
      assert.ok(html === "<h1>one</h1>" || html === "<h1>two</h1>", "the last deploy wins, with no mixed files");
    });
  });
});

describe("control store encryption", () => {
  it("round-trips and refuses the wrong key or a tampered blob", () => {
    const blob = encryptSecret("hello", "key-one");
    assert.equal(decryptSecret(blob, "key-one"), "hello");
    assert.throws(() => decryptSecret(blob, "key-two"), { code: "STATE_CORRUPT" });
    assert.throws(() => decryptSecret("v1.a.b.c", "key-one"), { code: "STATE_CORRUPT" });
  });
});
