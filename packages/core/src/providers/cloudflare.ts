import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { UnlocalError } from "../errors.ts";
import { contentTypeFor, listSiteFiles } from "../files.ts";
import type { Outputs } from "../state.ts";
import type { ResourceSpec, SiteSpec } from "../types.ts";
import type { Provider, ProviderContext } from "./provider.ts";

/**
 * Cloudflare provider. Sites: a Worker with static assets on workers.dev, HTTPS included.
 * Static asset requests are free on the Workers Free plan, so a site costs nothing.
 * Uses the REST API directly (no SDK): upload session → asset buckets → script upload.
 */

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** Cloudflare's per-file limit for Worker static assets. */
export const MAX_ASSET_BYTES = 25 * 1024 ** 2;
/**
 * Every Worker unlocal deploys binds its assets under this name. It marks the Worker
 * as unlocal's, so a same-named Worker someone made by hand is never overwritten.
 */
export const MARKER_BINDING = "UNLOCAL_ASSETS";
const MODULE = "index.js";
const COMPATIBILITY_DATE = "2026-10-01";
// Requests that match a file never reach this code; it only runs for paths assets didn't answer.
const WORKER_SOURCE = `export default { fetch: (request, env) => env.${MARKER_BINDING}.fetch(request) };\n`;

/** Worker names: ≤ 63 lowercase letters, digits and dashes. Deterministic per project + resource. */
export function scriptName(project: string, name: string): string {
  const full = `${project}-${name}`;
  if (full.length <= 63) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 54).replace(/-+$/, "")}-${hash}`;
}

/** The asset id Cloudflare's upload flow expects: 32 hex chars over base64 content + extension. */
export function assetHash(base64: string, key: string): string {
  return createHash("sha256").update(base64 + path.extname(key).slice(1)).digest("hex").slice(0, 32);
}

/** Requests that reached the Worker's code in a window (static files never do). */
export const USAGE_QUERY = `query Usage($accountTag: string!, $script: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $script, datetime_geq: $from, datetime_lt: $to }) { sum { requests } }
  } }
}`;

export function workerMetadata(jwt: string, spa: boolean) {
  return {
    main_module: MODULE,
    compatibility_date: COMPATIBILITY_DATE,
    assets: {
      jwt,
      config: { html_handling: "auto-trailing-slash", not_found_handling: spa ? "single-page-application" : "404-page" },
    },
    bindings: [{ name: MARKER_BINDING, type: "assets" }],
  };
}


interface CfMessage { code: number; message: string }
interface CfResponse<T> { success?: boolean; errors?: CfMessage[]; result?: T }

/** A failed Cloudflare API call, keeping the HTTP status and Cloudflare's error codes. */
export class CloudflareApiError extends Error {
  readonly status: number;
  readonly codes: number[];
  constructor(status: number, errors: CfMessage[]) {
    const detail = errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${status}`;
    super(`Cloudflare: ${detail}`);
    this.name = "CloudflareApiError";
    this.status = status;
    this.codes = errors.map((e) => e.code);
  }
}

// 10000: authentication error; 9106/9109: missing or invalid token.
const AUTH_CODES = new Set([10000, 9106, 9109]);
const isAuthError = (err: unknown) =>
  err instanceof CloudflareApiError && (err.status === 401 || err.status === 403 || err.codes.some((c) => AUTH_CODES.has(c)));
const isMissing = (err: unknown) => err instanceof CloudflareApiError && err.status === 404;

const PERMISSIONS = "Account → Workers Scripts → Edit, and Account → Account Analytics → Read";

const authError = (cause?: unknown) =>
  // A 403 with a working token means the token lacks a permission, not that it's wrong.
  cause instanceof CloudflareApiError && cause.status === 403
    ? new UnlocalError("CLOUD_AUTH", "the Cloudflare token works but isn't allowed to do this", {
      cause,
      hint: `a human edits the token in the Cloudflare dashboard (My Profile → API Tokens) to include ${PERMISSIONS}`,
    })
    : new UnlocalError("CLOUD_AUTH", "Cloudflare credentials are missing or don't work", {
      cause,
      hint: `a human connects Cloudflare in the console (\`unlocal console\`), or sets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (token permissions: ${PERMISSIONS})`,
    });

export interface CloudflareOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  api?: string;
}

/**
 * Retry requests that never got an answer (a dropped connection, a DNS blip). Every call
 * unlocal makes is safe to repeat: uploads are keyed by content hash and deploys replace
 * the whole Worker. HTTP errors are answers, so they're never retried.
 */
export function withRetries(doFetch: typeof fetch, delaysMs: number[] = [500, 2000, 5000]): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await doFetch(input, init);
      } catch (err) {
        if (attempt >= delaysMs.length) throw err;
        await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      }
    }
  };
}

export function createCloudflareProvider(options: CloudflareOptions = {}): Provider {
  const env = options.env ?? process.env;
  const doFetch = withRetries(options.fetch ?? fetch);
  const api = options.api ?? env.CLOUDFLARE_API_BASE ?? CLOUDFLARE_API;
  let subdomain: string | undefined;

  function credentials() {
    const token = env.CLOUDFLARE_API_TOKEN;
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !accountId) throw authError();
    return { token, accountId };
  }

  async function call<T>(method: string, route: string, opts: { json?: unknown; form?: FormData; bearer?: string } = {}): Promise<T> {
    const { token, accountId } = credentials();
    const res = await doFetch(`${api}/accounts/${accountId}${route}`, {
      method,
      headers: { authorization: `Bearer ${opts.bearer ?? token}`, ...(opts.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    });
    let body: CfResponse<T> = {};
    try {
      body = (await res.json()) as CfResponse<T>;
    } catch {
      // Non-JSON bodies are reported by status below.
    }
    if (!res.ok || body.success === false) {
      const err = new CloudflareApiError(res.status, body.errors ?? []);
      throw isAuthError(err) ? authError(err) : err;
    }
    return body.result as T;
  }

  async function accountSubdomain(): Promise<string> {
    if (subdomain) return subdomain;
    try {
      subdomain = (await call<{ subdomain: string }>("GET", "/workers/subdomain")).subdomain;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (!subdomain) {
      throw new UnlocalError("CLOUD_AUTH", "this Cloudflare account has no workers.dev subdomain yet", {
        hint: "a human opens Workers & Pages in the Cloudflare dashboard once to choose one",
      });
    }
    return subdomain;
  }

  /** Throws if a Worker with this name exists and isn't one unlocal deployed. */
  async function assertOurs(script: string): Promise<void> {
    let settings: { bindings?: { name: string }[] };
    try {
      settings = await call("GET", `/workers/scripts/${script}/settings`);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    if (!settings.bindings?.some((b) => b.name === MARKER_BINDING)) {
      throw new UnlocalError("NAME_TAKEN", `a Worker named "${script}" already exists in this Cloudflare account and wasn't made by unlocal`, {
        details: { script },
        hint: "rename the project or resource in unlocal.json; unlocal never overwrites what it didn't make",
      });
    }
  }

  /** Upload the site's files (only ones Cloudflare doesn't already have), then deploy the Worker. */
  async function deploy(ctx: ProviderContext, script: string, spec: SiteSpec): Promise<Outputs> {
    const files = await listSiteFiles(path.resolve(ctx.dir, spec.path));
    const tooBig = files.find((f) => f.size > MAX_ASSET_BYTES);
    if (tooBig) {
      throw new UnlocalError("CONFIG_INVALID", `${tooBig.key} is over Cloudflare's 25 MB per-file limit`, {
        hint: "shrink or remove that file, or host it elsewhere",
      });
    }

    const manifest: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, { base64: string; key: string }>();
    for (const f of files) {
      const base64 = (await readFile(f.absPath)).toString("base64");
      const hash = assetHash(base64, f.key);
      manifest[`/${f.key}`] = { hash, size: f.size };
      byHash.set(hash, { base64, key: f.key });
    }

    const session = await call<{ jwt: string; buckets?: string[][] }>(
      "POST", `/workers/scripts/${script}/assets-upload-session`, { json: { manifest } },
    );
    let jwt = session.jwt;
    let uploaded = 0;
    for (const bucket of session.buckets ?? []) {
      const form = new FormData();
      for (const hash of bucket) {
        const file = byHash.get(hash);
        if (!file) throw new Error(`Cloudflare asked for an unknown file (${hash})`);
        form.append(hash, new Blob([file.base64], { type: contentTypeFor(file.key) }), hash);
      }
      const done = await call<{ jwt?: string } | null>("POST", "/workers/assets/upload?base64=true", { form, bearer: session.jwt });
      if (done?.jwt) jwt = done.jwt;
      uploaded += bucket.length;
    }
    ctx.log(`${files.length} files, ${uploaded} uploaded`);

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(workerMetadata(jwt, spec.spa))], { type: "application/json" }));
    form.append(MODULE, new Blob([WORKER_SOURCE], { type: "application/javascript+module" }), MODULE);
    await call("PUT", `/workers/scripts/${script}`, { form });
    await call("POST", `/workers/scripts/${script}/subdomain`, { json: { enabled: true, previews_enabled: false } });

    return { url: `https://${script}.${await accountSubdomain()}.workers.dev`, script };
  }

  return {
    name: "cloudflare",

    unsupported(spec: ResourceSpec) {
      if (spec.type !== "site") return `${spec.type} resources aren't supported on Cloudflare (sites are)`;
      if (spec.domain) return "custom domains aren't supported on Cloudflare yet; remove domain to get a workers.dev URL";
      return undefined;
    },

    async preflight() {
      credentials();
      await accountSubdomain();
    },

    async create(ctx, name, spec) {
      const script = scriptName(ctx.project, name);
      await assertOurs(script);
      return deploy(ctx, script, spec as SiteSpec);
    },

    async update(ctx, name, _before, after, outputs) {
      return deploy(ctx, outputs.script ?? scriptName(ctx.project, name), after as SiteSpec);
    },

    // Turning off the workers.dev route takes the site offline at no cost (no request reaches
    // the Worker) and keeps the Worker and its files. A deploy turns the route back on.
    async pause(ctx, name, _spec, outputs) {
      const script = outputs.script ?? scriptName(ctx.project, name);
      await assertOurs(script);
      await call("POST", `/workers/scripts/${script}/subdomain`, { json: { enabled: false, previews_enabled: false } });
      return outputs;
    },

    async usage(ctx, name, _spec, outputs, window) {
      const { token, accountId } = credentials();
      const res = await doFetch(`${api}/graphql`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: USAGE_QUERY,
          variables: { accountTag: accountId, script: outputs.script ?? scriptName(ctx.project, name), from: window.from.toISOString(), to: window.to.toISOString() },
        }),
      });
      type Rows = { sum?: { requests?: number } }[];
      let body: { data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: Rows }[] } }; errors?: { message: string }[] | null } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // Reported by status below.
      }
      if (res.status === 401 || res.status === 403) throw authError();
      if (!res.ok || body.errors?.length) {
        throw new Error(`Cloudflare analytics: ${body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
      }
      const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
      return { workerRequests: rows.reduce((s, r) => s + (r.sum?.requests ?? 0), 0) };
    },

    async delete(ctx, name, _spec, outputs) {
      const script = outputs.script ?? scriptName(ctx.project, name);
      try {
        await assertOurs(script);
        await call("DELETE", `/workers/scripts/${script}?force=true`);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    },
  };
}
