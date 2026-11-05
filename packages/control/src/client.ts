import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  UnlocalError,
  buildApp,
  defaultProjectName,
  detectSite,
  listSiteFiles,
  type ErrorCode,
} from "@unlocal/core";

/**
 * The client half of the hosted API: build a folder, pack its built files, and deploy
 * it with a tenant token. `unlocal up --remote` will call this; until then the
 * `unlocal-control remote` command does, so the API can be exercised end to end.
 */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 2_000;

export interface RemoteDeployOptions {
  /** Base URL of the control plane, e.g. http://127.0.0.1:4401. */
  controlUrl: string;
  /** Tenant token (`ul_...`); the only credential the caller needs. */
  token: string;
  /** Project folder (the one with package.json / the built output). */
  dir: string;
  /** Name of the project in the control plane; defaults to the folder name. */
  project?: string;
  /** Run the project's build script first. Default true, like `unlocal up`. */
  build?: boolean;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface RemoteDeployResult {
  project: string;
  url: string | null;
  monthlyUsd: number;
  applied: { kind: string; name: string }[];
  balanceUsd: number;
}

interface ErrorBody {
  ok?: boolean;
  data?: RemoteDeployResult;
  error?: { code?: string; message?: string; hint?: string; details?: unknown };
}

export async function deployFolder(options: RemoteDeployOptions): Promise<RemoteDeployResult> {
  const controlUrl = options.controlUrl.replace(/\/+$/, "");
  if (!controlUrl) throw new UnlocalError("USAGE", "a control plane URL is required", { hint: "pass --url or set UNLOCAL_CONTROL_URL" });
  if (!options.token) throw new UnlocalError("UNAUTHENTICATED", "a tenant token is required", { hint: "ask the human for one, or pass --token" });

  const build = options.build === false ? null : await buildApp(options.dir, (line) => options.log?.(line));
  const sitePath = detectSite(options.dir, { built: build !== null });
  const root = path.resolve(options.dir, sitePath);
  const files = await listSiteFiles(root);
  if (files.length > MAX_UPLOAD_FILES) {
    throw new UnlocalError("USAGE", `${files.length} files is over the ${MAX_UPLOAD_FILES} file limit`);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_UPLOAD_BYTES) {
    throw new UnlocalError("USAGE", `${(total / 1024 ** 2).toFixed(1)} MB is over the ${MAX_UPLOAD_BYTES / 1024 ** 2} MB upload limit`);
  }

  const body = {
    project: options.project ?? defaultProjectName(options.dir),
    files: await Promise.all(files.map(async (file) => ({
      path: file.key,
      content: (await readFile(file.absPath)).toString("base64"),
    }))),
  };

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${controlUrl}/v1/deploy`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new UnlocalError("INTERNAL", `couldn't reach the control plane at ${controlUrl}`, {
      cause,
      hint: "check the URL and that `unlocal-control` is running",
    });
  }

  let payload: ErrorBody = {};
  try {
    payload = (await response.json()) as ErrorBody;
  } catch {
    // Reported by status below.
  }
  if (!response.ok || payload.ok !== true || !payload.data) {
    const error = payload.error;
    throw new UnlocalError((error?.code as ErrorCode) ?? "INTERNAL", error?.message ?? `control plane returned HTTP ${response.status}`, {
      hint: error?.hint,
      details: error?.details,
    });
  }
  return payload.data;
}
