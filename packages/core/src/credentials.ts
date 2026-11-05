import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { accountHome } from "./account.ts";
import type { AwsConnection } from "./aws-connect.ts";
import { UnlocalError } from "./errors.ts";

/**
 * Cloud credentials a human connected (in the console), so agents never handle keys.
 * Local mode keeps them in ~/.unlocal/credentials.json, readable only by this user.
 * Environment variables still win, for CI and people who prefer them.
 */
export interface Credentials {
  cloudflare?: { apiToken: string; accountId: string };
  /** A permanent AWS connection through the unlocal-deploy role (see aws-connect.ts). */
  aws?: AwsConnection;
}

const credentialsFile = (env: NodeJS.ProcessEnv) => path.join(accountHome(env), "credentials.json");

export function loadCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  try {
    return JSON.parse(readFileSync(credentialsFile(env), "utf8")) as Credentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new UnlocalError("STATE_CORRUPT", `${credentialsFile(env)} is unreadable`, { cause: err });
  }
}

export async function saveCredentials(credentials: Credentials, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = credentialsFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** `env` with connected credentials filled in wherever the environment doesn't set them. */
export function withCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cf = loadCredentials(env).cloudflare;
  return {
    ...env,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? cf?.apiToken,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? cf?.accountId,
  };
}
