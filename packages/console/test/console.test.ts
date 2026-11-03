import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startConsole, type RunningConsole } from "../src/server.ts";

const EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery";

/** Minimal browser: keeps the session cookie and sends a same-origin Origin header. */
function client(base: string) {
  let cookie = "";
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
}

function siteProject(root: string, name: string, extra: object = {}) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "index.html"), "<h1>hi</h1>");
  writeFileSync(path.join(dir, "unlocal.json"), JSON.stringify({
    project: name, budget: { monthlyUsd: 5 }, resources: { web: { type: "site", path: "./dist" } }, ...extra,
  }));
  return dir;
}

async function setupOwner(base: string) {
  const api = client(base);
  const r = await api("POST", "/api/setup", { email: EMAIL, password: PASSWORD });
  assert.equal(r.status, 200);
  return api;
}

describe("console", () => {
  let root: string;
  let server: RunningConsole;
  const env = () => ({ ...process.env, UNLOCAL_HOME: path.join(root, "home") });

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "unlocal-console-"));
  });

  async function fresh(extraEnv: Record<string, string> = {}, login = true) {
    await server?.close();
    root = mkdtempSync(path.join(tmpdir(), "unlocal-console-"));
    server = await startConsole({ env: { ...env(), ...extraEnv }, port: 0, login });
    return server.url;
  }

  after(async () => server?.close());

  it("creates one owner, then requires logging in", async () => {
    const base = await fresh();
    const anon = client(base);
    assert.equal((await anon("GET", "/api/session")).body.setupRequired, true);
    assert.equal((await anon("GET", "/api/overview")).status, 401);

    const api = await setupOwner(base);
    assert.equal((await api("GET", "/api/session")).body.user.email, EMAIL);
    assert.equal((await client(base)("POST", "/api/setup", { email: "x@y.co", password: PASSWORD })).status, 401);

    const other = client(base);
    assert.equal((await other("POST", "/api/login", { email: EMAIL, password: "wrong password!!" })).status, 401);
    assert.equal((await other("POST", "/api/login", { email: EMAIL, password: PASSWORD })).status, 200);
    assert.equal((await other("GET", "/api/overview")).status, 200);

    await other("POST", "/api/logout");
    assert.equal((await other("GET", "/api/overview")).status, 401);
  });

  it("without login, acts as the local owner but only answers to its own host", async () => {
    const base = await fresh({}, false);
    const api = client(base);
    assert.equal((await api("GET", "/api/session")).body.login, false);
    assert.equal((await api("POST", "/api/cap", { usd: 10 })).status, 200);
    assert.equal((await api("GET", "/api/overview")).body.monthlyCapUsd, 10);
    // fetch can't fake the Host header, so send a raw request like a DNS-rebound page would.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request(base + "/api/overview", { headers: { host: "evil.example:4400" } }, (res) => { res.resume(); resolve(res.statusCode); })
        .on("error", reject).end();
    });
    assert.equal(status, 403);
  });

  it("rejects weak passwords and cross-site requests", async () => {
    const base = await fresh();
    assert.equal((await client(base)("POST", "/api/setup", { email: EMAIL, password: "short" })).status, 400);
    const api = await setupOwner(base);
    const evil = await api("POST", "/api/cap", { usd: 99999 }, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
  });

  it("sets the cap and adds test credit", async () => {
    const base = await fresh();
    const api = await setupOwner(base);
    assert.equal((await api("POST", "/api/cap", { usd: 10 })).status, 200);
    assert.equal((await api("POST", "/api/funds", { usd: 2 })).status, 400, "below the minimum top-up");
    assert.equal((await api("POST", "/api/funds", { usd: 20 })).body.balanceUsd, 20);
    const o = (await api("GET", "/api/overview")).body;
    assert.equal(o.monthlyCapUsd, 10);
    assert.equal(o.balanceUsd, 20);
    assert.equal(o.payments, "test");
    assert.equal(o.transactions[0].kind, "credit");
  });

  it("plans and deploys a project, pinned to the reviewed plan", async () => {
    const base = await fresh();
    const api = await setupOwner(base);
    const dir = siteProject(root, "blog");
    assert.equal((await api("POST", "/api/projects", { dir: path.join(root, "nope") })).body.error.code, "CONFIG_NOT_FOUND");
    assert.equal((await api("POST", "/api/projects", { dir })).status, 200);

    const plan = (await api("POST", "/api/plan", { dir })).body.plan;
    assert.equal(plan.summary.create, 1);
    assert.equal((await api("POST", "/api/deploy", { dir, planId: "stale", sim: true })).body.error.code, "PLAN_STALE");

    const r = await api("POST", "/api/deploy", { dir, planId: plan.id, sim: true });
    assert.equal(r.status, 200);
    assert.match(r.body.url, /^https:\/\//);

    const project = (await api("GET", "/api/overview")).body.projects.find((p: { dir: string }) => p.dir === dir);
    assert.equal(project.pending, false);
    assert.equal(project.url, r.body.url);
  });

  it("refuses live deploys without a cap, without funds, or on an unsupported cloud", async () => {
    const base = await fresh();
    const api = await setupOwner(base);
    const dir = siteProject(root, "shop", { cloud: "gcp" });
    await api("POST", "/api/projects", { dir });
    const deploy = async () => {
      const plan = (await api("POST", "/api/plan", { dir })).body.plan;
      return (await api("POST", "/api/deploy", { dir, planId: plan.id })).body.error.code;
    };
    assert.equal(await deploy(), "CAP_NOT_SET");
    await api("POST", "/api/cap", { usd: 10 });
    assert.equal(await deploy(), "FUNDS_INSUFFICIENT");
    await api("POST", "/api/funds", { usd: 10 });
    assert.equal(await deploy(), "PROVIDER_UNAVAILABLE");
  });

  it("credits a Stripe payment once, only after verifying it with Stripe", async () => {
    const sessions: Record<string, { payment_status: string; amount_total: number; metadata: { unlocal_user: string } }> = {};
    let owner = "";
    const stripe = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
        let body = "";
        req.on("data", (c) => (body += c)).on("end", () => {
          const form = new URLSearchParams(body);
          owner = form.get("metadata[unlocal_user]")!;
          const id = `cs_test_${Object.keys(sessions).length + 1}`;
          sessions[id] = { payment_status: "paid", amount_total: Number(form.get("line_items[0][price_data][unit_amount]")), metadata: { unlocal_user: owner } };
          res.end(JSON.stringify({ id, url: `https://checkout.stripe.test/${id}` }));
        });
        return;
      }
      const id = req.url!.split("/").pop()!;
      if (sessions[id]) return res.end(JSON.stringify(sessions[id]));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "No such session" } }));
    });
    await new Promise<void>((r) => stripe.listen(0, "127.0.0.1", r));
    const stripeBase = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

    try {
      const base = await fresh({ STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_API_BASE: stripeBase });
      const api = await setupOwner(base);
      const r = await api("POST", "/api/funds", { usd: 25 });
      assert.match(r.body.checkoutUrl, /checkout\.stripe\.test\/cs_test_1$/);
      assert.equal((await api("GET", "/api/overview")).body.balanceUsd, 0, "nothing credited before payment");

      const back = await api("GET", "/api/funds/return?session_id=cs_test_1");
      assert.equal(back.status, 303);
      await api("GET", "/api/funds/return?session_id=cs_test_1");
      const o = (await api("GET", "/api/overview")).body;
      assert.equal(o.balanceUsd, 25, "credited exactly once");
      assert.equal(o.payments, "stripe");

      sessions.cs_test_9 = { payment_status: "unpaid", amount_total: 50000, metadata: { unlocal_user: owner } };
      await api("GET", "/api/funds/return?session_id=cs_test_9");
      assert.equal((await api("GET", "/api/overview")).body.balanceUsd, 25, "unpaid sessions credit nothing");
    } finally {
      stripe.close();
    }
  });
});
