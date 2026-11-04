import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  CLOUDS_INFO,
  MAX_CAP_USD,
  assess,
  runGuard,
  settledAccount,
  stopEverything,
  unfreezeAccount,
  UnlocalError,
  createCloudflareProvider,
  loadCredentials,
  saveCredentials,
  creditAccount,
  liveSpendUsd,
  loadAccount,
  openProject,
  planProject,
  round2,
  runPlan,
  withAccount,
  type ErrorCode,
} from "@unlocal/core";
import {
  authenticate,
  checkCredentials,
  createUser,
  endSession,
  loadData,
  saveData,
  SESSION_DAYS,
  startSession,
  userForToken,
  type User,
} from "./store.ts";
import { createCheckout, fetchCheckout, stripeEnabled } from "./stripe.ts";

/**
 * The unlocal console: log in, add funds, set the cap, deploy.
 * A small JSON API plus one static page. Binds to 127.0.0.1 only.
 */

export interface ConsoleOptions {
  env?: NodeJS.ProcessEnv;
  port?: number;
  /** Require an account and password. Off for the local console: only this machine can reach it. */
  login?: boolean;
  /** How often the guard checks spending while the console runs; 0 turns it off. */
  guardEveryMs?: number;
}

export const GUARD_EVERY_MS = 5 * 60_000;

/** The user every request acts as when login is off. */
const LOCAL_USER: User = { id: "local", email: "", password: "", createdAt: "" };

export interface RunningConsole {
  url: string;
  close(): Promise<void>;
}

const PUBLIC = path.join(import.meta.dirname, "..", "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/favicon.svg": "favicon.svg",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
const COOKIE = "unlocal_session";
const MAX_BODY = 64 * 1024;

const STATUS: Partial<Record<ErrorCode, number>> = {
  USAGE: 400,
  CONFIG_NOT_FOUND: 400,
  CONFIG_INVALID: 400,
  UNAUTHENTICATED: 401,
  PLAN_STALE: 409,
  APPROVAL_REQUIRED: 409,
  BUDGET_EXCEEDED: 409,
  CAP_NOT_SET: 409,
  CAP_EXCEEDED: 409,
  FUNDS_INSUFFICIENT: 409,
  DESTRUCTIVE_CHANGE: 409,
  CLOUD_AUTH: 409,
  PROVIDER_UNAVAILABLE: 422,
  APPLY_FAILED: 502,
  PAYMENT_FAILED: 502,
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new UnlocalError("USAGE", "request too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    throw new UnlocalError("USAGE", "body must be JSON");
  }
}

const cookieToken = (req: IncomingMessage) =>
  req.headers.cookie?.split(";").map((c) => c.trim().split("=")).find(([k]) => k === COOKIE)?.[1];

const sessionCookie = (token: string, maxAge: number) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

const amount = (value: unknown, what: string): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UnlocalError("USAGE", `${what} must be a positive number`);
  return n;
};

export async function startConsole(options: ConsoleOptions = {}): Promise<RunningConsole> {
  const env = options.env ?? process.env;
  const login = options.login ?? true;
  const deploying = new Set<string>();
  let baseUrl = "";

  async function projectsView(user: User) {
    const data = await loadData(env);
    const account = await settledAccount(env);
    const dirs = [...new Set([...data.projects, ...Object.keys(account.projects)])];
    const projects = await Promise.all(dirs.map(async (dir) => {
      try {
        const p = await openProject(dir, env);
        const plan = await planProject(p);
        const resources = Object.values(p.state.resources);
        return {
          dir,
          project: p.config.project,
          cloud: p.config.cloud,
          url: resources.find((r) => r.outputs.url)?.outputs.url ?? null,
          monthlyUsd: round2(resources.reduce((s, r) => s + r.monthlyUsd, 0)),
          live: account.projects[p.key]?.live ?? false,
          pending: plan.hasChanges,
          deploying: deploying.has(p.key),
        };
      } catch (err) {
        return { dir, error: err instanceof Error ? err.message : String(err) };
      }
    }));
    // Committed spend grouped by provider, so every cloud's cost is visible in one place.
    const byCloud = new Map<string, { cloud: string; name: string; projects: number; monthlyUsd: number }>();
    for (const e of Object.values(account.projects)) {
      if (!e.live) continue;
      const row = byCloud.get(e.cloud) ?? { cloud: e.cloud, name: CLOUDS_INFO[e.cloud]?.name ?? e.cloud, projects: 0, monthlyUsd: 0 };
      row.projects++;
      row.monthlyUsd = round2(row.monthlyUsd + e.monthlyUsd);
      byCloud.set(e.cloud, row);
    }
    const cf = loadCredentials(env).cloudflare;
    return {
      user: { email: user.email },
      login,
      guard: assess(account),
      spend: [...byCloud.values()].sort((a, b) => b.monthlyUsd - a.monthlyUsd),
      connections: {
        cloudflare: env.CLOUDFLARE_API_TOKEN
          ? { connected: true, source: "env", accountId: env.CLOUDFLARE_ACCOUNT_ID ?? null }
          : { connected: Boolean(cf), source: cf ? "console" : null, accountId: cf?.accountId ?? null },
      },
      balanceUsd: account.balanceUsd,
      monthlyCapUsd: account.monthlyCapUsd,
      liveMonthlyUsd: liveSpendUsd(account),
      payments: stripeEnabled(env) ? "stripe" : "test",
      projects,
      transactions: account.transactions.slice(0, 20),
    };
  }

  type Handler = (req: IncomingMessage, res: ServerResponse, user: User | undefined, body: Record<string, unknown>) => Promise<void>;
  const authed = (fn: (req: IncomingMessage, res: ServerResponse, user: User, body: Record<string, unknown>) => Promise<void>): Handler =>
    async (req, res, user, body) => {
      if (!user) throw new UnlocalError("UNAUTHENTICATED", "log in first");
      await fn(req, res, user, body);
    };

  const routes: Record<string, Handler> = {
    "GET /api/session": async (_req, res, user) => {
      const data = await loadData(env);
      send(res, 200, { ok: true, user: user ? { email: user.email } : null, setupRequired: data.users.length === 0, login });
    },

    "POST /api/setup": async (_req, res, _user, body) => {
      const data = await loadData(env);
      if (data.users.length > 0) throw new UnlocalError("UNAUTHENTICATED", "this console already has an owner; log in");
      const { email, password } = checkCredentials(body.email, body.password);
      const user = await createUser(data, email, password);
      const token = startSession(data, user.id);
      await saveData(env, data);
      send(res, 200, { ok: true, user: { email } }, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86_400) });
    },

    "POST /api/login": async (_req, res, _user, body) => {
      const data = await loadData(env);
      const { email, password } = checkCredentials(body.email, body.password);
      const user = await authenticate(data, email, password);
      const token = startSession(data, user.id);
      await saveData(env, data);
      send(res, 200, { ok: true, user: { email } }, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86_400) });
    },

    "POST /api/logout": async (req, res) => {
      const data = await loadData(env);
      endSession(data, cookieToken(req));
      await saveData(env, data);
      send(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    },

    "GET /api/overview": authed(async (_req, res, user) => {
      send(res, 200, { ok: true, ...(await projectsView(user)) });
    }),

    "POST /api/cap": authed(async (_req, res, _user, body) => {
      const usd = amount(body.usd, "cap");
      if (usd > MAX_CAP_USD) throw new UnlocalError("USAGE", `cap can't exceed $${MAX_CAP_USD}`);
      const monthlyCapUsd = await withAccount(env, (account) => (account.monthlyCapUsd = round2(usd)));
      send(res, 200, { ok: true, monthlyCapUsd });
    }),

    "POST /api/funds": authed(async (_req, res, user, body) => {
      const usd = amount(body.usd, "amount");
      if (stripeEnabled(env)) {
        creditAccount({ version: 1, monthlyCapUsd: null, balanceUsd: 0, projects: {}, transactions: [] }, usd, "topup"); // validates range
        const checkoutUrl = await createCheckout(env, { amountUsd: usd, userId: user.id, baseUrl });
        return send(res, 200, { ok: true, checkoutUrl });
      }
      const balanceUsd = await withAccount(env, (account) => {
        creditAccount(account, usd, "credit");
        return account.balanceUsd;
      });
      send(res, 200, { ok: true, balanceUsd });
    }),

    "GET /api/funds/return": authed(async (req, res, user) => {
      const id = new URL(req.url ?? "", baseUrl).searchParams.get("session_id") ?? "";
      const checkout = await fetchCheckout(env, id);
      if (checkout.paid && checkout.userId === user.id) {
        await withAccount(env, (account) => creditAccount(account, checkout.amountUsd, "topup", id));
      }
      res.writeHead(303, { location: "/" }).end();
    }),

    "POST /api/connect/cloudflare": authed(async (_req, res, _user, body) => {
      const apiToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";
      const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
      if (!apiToken || !/^[0-9a-f]{32}$/i.test(accountId)) {
        throw new UnlocalError("USAGE", "enter your Cloudflare account ID (32 characters) and an API token");
      }
      // Check the token works and the account can serve workers.dev sites before saving it.
      const probe = createCloudflareProvider({
        env: { CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_BASE: env.CLOUDFLARE_API_BASE },
      });
      await probe.preflight!({ project: "unlocal", cloud: "cloudflare", region: "global", dir: ".", log: () => {} });
      const credentials = loadCredentials(env);
      credentials.cloudflare = { apiToken, accountId };
      await saveCredentials(credentials, env);
      send(res, 200, { ok: true, accountId });
    }),

    "POST /api/disconnect/cloudflare": authed(async (_req, res) => {
      const credentials = loadCredentials(env);
      delete credentials.cloudflare;
      await saveCredentials(credentials, env);
      send(res, 200, { ok: true });
    }),

    "POST /api/stop": authed(async (_req, res) => {
      send(res, 200, { ok: true, paused: await stopEverything(env, "stopped from the console") });
    }),

    "POST /api/unfreeze": authed(async (_req, res) => {
      await unfreezeAccount(env);
      send(res, 200, { ok: true });
    }),

    "POST /api/projects": authed(async (_req, res, _user, body) => {
      if (typeof body.dir !== "string" || !body.dir) throw new UnlocalError("USAGE", "enter the project's folder");
      const dir = path.resolve(body.dir.trim().replace(/^~(?=$|\/)/, os.homedir()));
      await openProject(dir, env); // must contain a valid unlocal.json
      const data = await loadData(env);
      if (!data.projects.includes(dir)) data.projects.push(dir);
      await saveData(env, data);
      send(res, 200, { ok: true, dir });
    }),

    "POST /api/plan": authed(async (_req, res, _user, body) => {
      const p = await openProject(String(body.dir ?? ""), env);
      send(res, 200, { ok: true, plan: await planProject(p) });
    }),

    "POST /api/deploy": authed(async (_req, res, _user, body) => {
      const p = await openProject(String(body.dir ?? ""), env);
      if (deploying.has(p.key)) throw new UnlocalError("APPLY_FAILED", "a deploy of this project is already running");
      const plan = await planProject(p);
      if (plan.id !== body.planId) {
        throw new UnlocalError("PLAN_STALE", "something changed since you reviewed this plan", { hint: "review the new plan" });
      }
      deploying.add(p.key);
      const log: string[] = [];
      try {
        const result = await runPlan(p, plan, {
          sim: body.sim === true,
          onEvent: (e) => e.phase === "done" && log.push(`✓ ${e.action.kind} ${e.action.name}`),
          log: (m) => log.push(m),
        });
        const url = Object.values(result.state.resources).find((r) => r.outputs.url)?.outputs.url ?? null;
        send(res, 200, { ok: true, applied: result.applied.map((a) => ({ kind: a.kind, name: a.name })), url, log });
      } finally {
        deploying.delete(p.key);
      }
    }),
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", baseUrl);
    const host = req.headers.host ?? "";
    // Only answer to our own address, so a web page can't reach us by pointing its domain at 127.0.0.1.
    if (host !== baseUrl.slice(7) && host !== baseUrl.slice(7).replace("127.0.0.1", "localhost")) {
      return send(res, 403, { ok: false, error: { code: "UNAUTHENTICATED", message: "unknown host" } });
    }
    if (req.method === "GET" && STATIC[url.pathname]) {
      const file = path.join(PUBLIC, STATIC[url.pathname]!);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)]!,
        "cache-control": "no-cache",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      return void res.end(await readFile(file));
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { ok: false, error: { code: "USAGE", message: "not found" } });
    if (req.method === "POST") {
      const origin = req.headers.origin;
      const allowed = [baseUrl, baseUrl.replace("127.0.0.1", "localhost")];
      if (!origin || !allowed.includes(origin)) {
        return send(res, 403, { ok: false, error: { code: "UNAUTHENTICATED", message: "cross-origin request refused" } });
      }
    }
    try {
      const data = await loadData(env);
      const user = login ? userForToken(data, cookieToken(req)) : LOCAL_USER;
      const body = req.method === "POST" ? await readJson(req) : {};
      await route(req, res, user, body);
    } catch (err) {
      const e = err instanceof UnlocalError ? err : new UnlocalError("INTERNAL", err instanceof Error ? err.message : String(err));
      send(res, STATUS[e.code] ?? 500, { ok: false, error: e.toJSON() });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(err) } }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 4400, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // While the console is open, the guard keeps watching spend, even with no one looking at it.
  const every = options.guardEveryMs ?? GUARD_EVERY_MS;
  const guardTimer = every > 0 ? setInterval(() => void runGuard(env).catch(() => {}), every) : undefined;
  guardTimer?.unref();
  return {
    url: baseUrl,
    close: () => {
      clearInterval(guardTimer);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
