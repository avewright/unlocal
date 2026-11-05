import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  MAX_CAP_USD,
  VERSION,
  UnlocalError,
  assess,
  creditAccount,
  loadAccount,
  settledAccount,
  withAccount,
  type ErrorCode,
} from "@unlocal/core";
import type { BundleFile } from "./bundle.ts";
import { deploySite } from "./deploy.ts";
import {
  decryptSecret,
  encryptSecret,
  hashToken,
  newToken,
  readStore,
  sameSecret,
  slugify,
  tenantHome,
  tenantProjectDir,
  withStore,
  type Tenant,
} from "./store.ts";

/**
 * The hosted control plane's HTTP API.
 *
 *   POST /v1/admin/tenants                     admin: create a tenant, return its token once
 *   POST /v1/admin/tenants/:id/tokens          admin: rotate a tenant's token
 *   POST /v1/admin/tenants/:id/funds           admin: add prepaid credit
 *   POST /v1/admin/tenants/:id/cloudflare      admin: store an encrypted Cloudflare credential
 *   POST /v1/deploy                            tenant: upload a built site and deploy it
 *   GET  /v1/usage                             tenant: balance, cap, projects, guard status
 *   GET  /v1/health                            public
 *
 * The tenant token can only do the last two. There is deliberately no endpoint that
 * changes a cap, unfreezes, or deletes data: those stay with a human.
 */

export interface ControlServerOptions {
  dataDir: string;
  /** Bearer token for the admin routes. Required. */
  adminToken: string;
  /** Encrypts stored cloud credentials at rest. Required to store one. */
  secret?: string;
  /** Use the simulated cloud: tests and local demos. */
  sim?: boolean;
  port?: number;
  host?: string;
}

export interface RunningControlServer {
  url: string;
  close(): Promise<void>;
}

export const MAX_BODY_BYTES = 80 * 1024 * 1024;
const MAX_FILES = 2_000;

const STATUS: Partial<Record<ErrorCode, number>> = {
  USAGE: 400,
  CONFIG_INVALID: 400,
  CONFIG_NOT_FOUND: 400,
  SITE_NOT_FOUND: 400,
  PLAN_INVALID: 400,
  UNAUTHENTICATED: 401,
  HUMAN_REQUIRED: 403,
  APPROVAL_REQUIRED: 409,
  BUDGET_EXCEEDED: 409,
  DESTRUCTIVE_CHANGE: 409,
  CAP_NOT_SET: 409,
  CAP_EXCEEDED: 409,
  FUNDS_INSUFFICIENT: 409,
  ACCOUNT_FROZEN: 409,
  PLAN_STALE: 409,
  NAME_TAKEN: 409,
  CLOUD_AUTH: 409,
  BUSY: 429,
  BUILD_FAILED: 422,
  PROVIDER_UNAVAILABLE: 502,
  APPLY_FAILED: 502,
  PAYMENT_FAILED: 502,
  STATE_CORRUPT: 500,
  INTERNAL: 500,
};

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new UnlocalError("USAGE", `${what} is required`);
  return value.trim();
};

const amount = (value: unknown, what: string, allowZero = false): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new UnlocalError("USAGE", `${what} must be a positive number`);
  return n;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new UnlocalError("USAGE", `request body is over the ${Math.floor(limit / 1024 / 1024)} MB limit`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UnlocalError("USAGE", "request body must be JSON");
  }
  if (!isObj(value)) throw new UnlocalError("USAGE", "request body must be a JSON object");
  return value;
}

/** Files arrive as base64; decode here so the bundle validator sees real bytes. */
function parseFiles(value: unknown): BundleFile[] {
  if (!Array.isArray(value) || value.length === 0) throw new UnlocalError("USAGE", "files must be a non-empty array");
  if (value.length > MAX_FILES) throw new UnlocalError("USAGE", `too many files (limit ${MAX_FILES})`);
  return value.map((item) => {
    if (!isObj(item) || typeof item.path !== "string" || typeof item.content !== "string") {
      throw new UnlocalError("USAGE", "every file needs a path and base64 content");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.content) || item.content.length % 4 !== 0) {
      throw new UnlocalError("USAGE", `${item.path} is not valid base64`);
    }
    return { path: item.path, content: Buffer.from(item.content, "base64") };
  });
}

const publicTenant = (tenant: Tenant) => ({
  id: tenant.id,
  slug: tenant.slug,
  name: tenant.name,
  monthlyCapUsd: tenant.monthlyCapUsd,
  balanceUsd: tenant.balanceUsd,
  projects: tenant.projects,
  createdAt: tenant.createdAt,
});

export async function startControlServer(options: ControlServerOptions): Promise<RunningControlServer> {
  const dataDir = path.resolve(options.dataDir);
  const sim = options.sim ?? false;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  /** One deploy per tenant project at a time; uploads never interleave on disk. */
  const tails = new Map<string, Promise<unknown>>();
  function withQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  }

  function assertAdmin(req: IncomingMessage): void {
    const token = bearer(req);
    if (!token || !sameSecret(token, options.adminToken)) {
      throw new UnlocalError("UNAUTHENTICATED", "admin token required", {
        hint: "send the value of UNLOCAL_CONTROL_ADMIN as `Authorization: Bearer <token>`",
      });
    }
  }

  async function tenantFor(req: IncomingMessage): Promise<Tenant> {
    const token = bearer(req);
    if (!token) throw new UnlocalError("UNAUTHENTICATED", "tenant token required", { hint: "send `Authorization: Bearer <token>`" });
    const hash = hashToken(token);
    const store = await readStore(dataDir);
    const tenant = Object.values(store.tenants).find((t) => sameSecret(t.tokenHash, hash));
    if (!tenant) throw new UnlocalError("UNAUTHENTICATED", "unknown or rotated tenant token", { hint: "ask the human for a current token" });
    return tenant;
  }

  /** A tenant's isolated ledger; the cap comes from the control plane, never the agent. */
  async function ensureTenantHome(tenant: Tenant): Promise<void> {
    const home = tenantHome(dataDir, tenant.id);
    const exists = existsSync(path.join(home, "account.json"));
    await withAccount({ UNLOCAL_HOME: home }, (account) => {
      account.monthlyCapUsd = tenant.monthlyCapUsd;
      if (!exists) account.balanceUsd = tenant.balanceUsd;
    });
  }

  /** The tenant's cloud credential, decrypted only for the deploy that needs it. */
  async function tenantEnv(tenant: Tenant): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { UNLOCAL_HOME: tenantHome(dataDir, tenant.id) };
    if (!tenant.cloudflare) return env;
    if (!options.secret) {
      throw new UnlocalError("STATE_CORRUPT", "a stored cloud credential can't be decrypted: UNLOCAL_CONTROL_SECRET is not set");
    }
    let parsed: { apiToken: string; accountId: string };
    try {
      parsed = JSON.parse(decryptSecret(tenant.cloudflare, options.secret)) as { apiToken: string; accountId: string };
    } catch (cause) {
      if (cause instanceof UnlocalError) throw cause;
      throw new UnlocalError("STATE_CORRUPT", "a stored cloud credential is unreadable", { cause });
    }
    env.CLOUDFLARE_API_TOKEN = parsed.apiToken;
    env.CLOUDFLARE_ACCOUNT_ID = parsed.accountId;
    return env;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://control.local");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/v1/health") {
      return send(res, 200, { ok: true, data: { version: VERSION } });
    }

    if (req.method === "POST" && pathname === "/v1/admin/tenants") {
      assertAdmin(req);
      const body = await readJson(req, MAX_BODY_BYTES);
      const name = requiredString(body.name, "name");
      const cap = amount(body.monthlyCapUsd, "monthlyCapUsd");
      if (cap > MAX_CAP_USD) throw new UnlocalError("USAGE", `monthlyCapUsd can't exceed ${MAX_CAP_USD}`);
      const balance = body.balanceUsd === undefined ? 0 : amount(body.balanceUsd, "balanceUsd", true);
      const wanted = slugify(String(body.slug ?? name)) || "tenant";
      const token = newToken();
      const id = randomBytes(6).toString("hex");

      const tenant = await withStore(dataDir, (store) => {
        const taken = new Set(Object.values(store.tenants).map((t) => t.slug));
        let slug = wanted;
        for (let n = 2; taken.has(slug); n++) slug = `${wanted.slice(0, 20)}-${n}`;
        const created: Tenant = {
          id, slug, name, monthlyCapUsd: cap, balanceUsd: balance,
          tokenHash: token.hash, createdAt: new Date().toISOString(), projects: {},
        };
        store.tenants[id] = created;
        return created;
      });
      await withAccount({ UNLOCAL_HOME: tenantHome(dataDir, id) }, (account) => {
        account.monthlyCapUsd = cap;
        account.balanceUsd = balance;
      });
      return send(res, 201, { ok: true, data: { tenant: publicTenant(tenant), token: token.token } });
    }

    const adminOp = pathname.match(/^\/v1\/admin\/tenants\/([^/]+)\/(cloudflare|funds|tokens)$/);
    if (req.method === "POST" && adminOp) {
      assertAdmin(req);
      const [, id, op] = adminOp;
      const body = await readJson(req, MAX_BODY_BYTES);
      const store = await readStore(dataDir);
      const tenant = store.tenants[id!];
      if (!tenant) throw new UnlocalError("CONFIG_NOT_FOUND", `no tenant ${id}`);

      if (op === "funds") {
        const usd = amount(body.usd, "usd");
        const balanceUsd = await withStore(dataDir, async (s) => {
          const t = s.tenants[id!]!;
          return withAccount({ UNLOCAL_HOME: tenantHome(dataDir, id!) }, (account) => {
            creditAccount(account, usd, "credit");
            t.balanceUsd = account.balanceUsd;
            return account.balanceUsd;
          });
        });
        return send(res, 200, { ok: true, data: { balanceUsd } });
      }

      if (op === "tokens") {
        const rotated = newToken();
        await withStore(dataDir, (s) => {
          s.tenants[id!]!.tokenHash = rotated.hash;
        });
        return send(res, 200, { ok: true, data: { token: rotated.token } });
      }

      // cloudflare
      const apiToken = requiredString(body.apiToken, "apiToken");
      const accountId = requiredString(body.accountId, "accountId");
      if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new UnlocalError("USAGE", "accountId must be Cloudflare's 32-character account id");
      if (!options.secret) {
        throw new UnlocalError("CONFIG_INVALID", "the control plane can't store cloud credentials without UNLOCAL_CONTROL_SECRET", {
          hint: "set UNLOCAL_CONTROL_SECRET to a long random value, then retry",
        });
      }
      const encrypted = encryptSecret(JSON.stringify({ apiToken, accountId }), options.secret);
      await withStore(dataDir, (s) => {
        s.tenants[id!]!.cloudflare = encrypted;
      });
      return send(res, 200, { ok: true, data: { accountId } });
    }

    if (req.method === "POST" && pathname === "/v1/deploy") {
      const tenant = await tenantFor(req);
      const body = await readJson(req, MAX_BODY_BYTES);
      const project = slugify(requiredString(body.project, "project"));
      if (!project) throw new UnlocalError("USAGE", "project must contain a letter or digit");
      const files = parseFiles(body.files);
      if (!sim && !tenant.cloudflare) {
        throw new UnlocalError("CLOUD_AUTH", "this tenant hasn't connected Cloudflare", {
          hint: "a human connects it once with the admin API, then deploys work",
        });
      }

      const result = await withQueue(`${tenant.id}/${project}`, async () => {
        await ensureTenantHome(tenant);
        const env = await tenantEnv(tenant);
        const deployed = await deploySite({
          projectDir: tenantProjectDir(dataDir, tenant.id, project),
          tenant: tenant.slug,
          project,
          files,
          budgetUsd: Math.max(1, tenant.monthlyCapUsd),
          env,
          sim,
        });
        const account = await loadAccount(env);
        await withStore(dataDir, (store) => {
          const current = store.tenants[tenant.id];
          if (!current) return;
          current.balanceUsd = account.balanceUsd;
          current.projects[project] = {
            monthlyUsd: deployed.monthlyUsd,
            url: deployed.url,
            updatedAt: new Date().toISOString(),
            cloudProject: deployed.project,
          };
        });
        return { ...deployed, balanceUsd: account.balanceUsd };
      });
      return send(res, 200, { ok: true, data: result });
    }

    if (req.method === "GET" && pathname === "/v1/usage") {
      const tenant = await tenantFor(req);
      const account = await settledAccount({ UNLOCAL_HOME: tenantHome(dataDir, tenant.id) });
      const projects = Object.entries(account.projects).map(([dir, entry]) => ({
        dir,
        project: entry.project,
        monthlyUsd: entry.monthlyUsd,
        live: entry.live,
        url: Object.values(tenant.projects).find((p) => p.cloudProject === entry.project)?.url ?? null,
      }));
      const data = {
        tenant: publicTenant(tenant),
        balanceUsd: account.balanceUsd,
        monthlyCapUsd: account.monthlyCapUsd,
        projects,
        guard: assess(account),
      };
      await withStore(dataDir, (store) => {
        const current = store.tenants[tenant.id];
        if (current) current.balanceUsd = account.balanceUsd;
      });
      return send(res, 200, { ok: true, data });
    }

    send(res, 404, { ok: false, error: { code: "USAGE", message: "not found", hint: null, details: null } });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      const error = err instanceof UnlocalError ? err : new UnlocalError("INTERNAL", err instanceof Error ? err.message : String(err));
      send(res, STATUS[error.code] ?? 500, { ok: false, error: error.toJSON() });
    });
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}
