import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnlocalError, withLock } from "@unlocal/core";

/**
 * The control plane's store: tenants, their hashed tokens, and the cloud credentials
 * they connected (encrypted at rest). One JSON file for the beta; the interface is the
 * part that matters, so moving to Postgres later is a reimplementation, not a rewrite.
 */

export interface TenantProject {
  monthlyUsd: number;
  url: string | null;
  updatedAt: string;
  /** The cloud resource name (tenant slug + project); differ from the customer's name. */
  cloudProject?: string;
}

export interface Tenant {
  id: string;
  /** Used in cloud names, so two tenants' "site" never collide. */
  slug: string;
  name: string;
  monthlyCapUsd: number;
  balanceUsd: number;
  /** SHA-256 of the bearer token; the token itself is shown once and never stored. */
  tokenHash: string;
  createdAt: string;
  projects: Record<string, TenantProject>;
  /** AES-GCM blob (see encryptSecret); never plaintext. */
  cloudflare?: string;
}

export interface ControlStore {
  version: 1;
  tenants: Record<string, Tenant>;
}

export const emptyStore = (): ControlStore => ({ version: 1, tenants: {} });

export const storePath = (dataDir: string) => path.join(dataDir, "control.json");
export const tenantHome = (dataDir: string, tenantId: string) => path.join(dataDir, "tenants", tenantId, "home");
export const tenantProjectDir = (dataDir: string, tenantId: string, project: string) =>
  path.join(dataDir, "tenants", tenantId, "projects", project);

export async function readStore(dataDir: string): Promise<ControlStore> {
  let text: string;
  try {
    text = await readFile(storePath(dataDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw err;
  }
  try {
    const store = JSON.parse(text) as ControlStore;
    if (store.version !== 1 || typeof store.tenants !== "object" || store.tenants === null) {
      throw new Error("unrecognized format");
    }
    return store;
  } catch (cause) {
    throw new UnlocalError("STATE_CORRUPT", `${storePath(dataDir)} is unreadable`, { cause });
  }
}

export async function writeStore(dataDir: string, store: ControlStore): Promise<void> {
  const file = storePath(dataDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** Read, change and write the store under a lock, so concurrent tenants never lose each other. */
export async function withStore<T>(dataDir: string, fn: (store: ControlStore) => T | Promise<T>): Promise<T> {
  return withLock(storePath(dataDir), async () => {
    const store = await readStore(dataDir);
    const result = await fn(store);
    await writeStore(dataDir, store);
    return result;
  }, { what: "the control store" });
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new tenant bearer token. The prefix makes leaked tokens recognisable in logs. */
export function newToken(): { token: string; hash: string } {
  const token = `ul_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Lowercase, dash-safe slug used in cloud resource names. */
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

const keyFor = (secret: string) => createHash("sha256").update(secret).digest();

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. AES-256-GCM, a fresh IV per secret. */
export function encryptSecret(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, secret: string): string {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new UnlocalError("STATE_CORRUPT", "a stored cloud credential is not in a format this unlocal understands");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new UnlocalError("STATE_CORRUPT", "a stored cloud credential could not be decrypted", {
      cause,
      hint: "UNLOCAL_CONTROL_SECRET must be the same value it was encrypted with",
    });
  }
}
