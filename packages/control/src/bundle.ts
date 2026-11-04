import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnlocalError } from "@unlocal/core";

/**
 * A site upload: the files a customer's build produced, as paths relative to the
 * site root. The control plane never unpacks an archive, so there is no zip-slip,
 * no symlink and no executable bit to worry about — just validated regular files.
 */

export interface BundleFile {
  /** POSIX-style path relative to the site root, e.g. `assets/app.js`. */
  path: string;
  content: Buffer;
}

export interface BundleLimits {
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}

/** Cloudflare's per-asset limit is 25 MB; the whole bundle is capped well below 1 GB. */
export const DEFAULT_LIMITS: Required<BundleLimits> = {
  maxFiles: 2_000,
  maxBytes: 50 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
};

const fail = (message: string) => new UnlocalError("USAGE", message);

/** Reject anything that could escape the site root or collide with a host path. */
export function safeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) throw fail("every file needs a non-empty path");
  if (input.includes("\0")) throw fail("file paths can't contain NUL bytes");
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) {
    throw fail(`"${input}" must be relative to the site root`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw fail(`"${input}" must not contain empty, "." or ".." segments`);
  }
  return parts.join("/");
}

/**
 * Check a bundle before anything touches disk: paths, sizes, duplicates (including
 * case-insensitive collisions, which would overwrite each other on a laptop) and the
 * presence of index.html.
 */
export function validateBundle(files: readonly BundleFile[], limits: BundleLimits = {}): BundleFile[] {
  const { maxFiles, maxBytes, maxFileBytes } = { ...DEFAULT_LIMITS, ...limits };
  if (!Array.isArray(files) || files.length === 0) throw fail("the bundle has no files");
  if (files.length > maxFiles) throw fail(`too many files: ${files.length} (limit ${maxFiles})`);

  const seen = new Set<string>();
  let total = 0;
  const out: BundleFile[] = [];
  for (const file of files) {
    const key = safeRelativePath(file.path);
    const lower = key.toLowerCase();
    if (seen.has(lower)) throw fail(`duplicate file path: ${key}`);
    seen.add(lower);
    if (!(file.content instanceof Uint8Array)) throw fail(`${key} has no content`);
    if (file.content.byteLength > maxFileBytes) throw fail(`${key} is over the ${maxFileBytes} byte per-file limit`);
    total += file.content.byteLength;
    if (total > maxBytes) throw fail(`the bundle is over the ${maxBytes} byte limit`);
    out.push({ path: key, content: Buffer.from(file.content) });
  }
  if (!seen.has("index.html")) throw fail("the site needs an index.html at its root");
  return out;
}

/** Replace `root` with exactly these files. The caller has already validated them. */
export async function writeBundle(root: string, files: readonly BundleFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const target = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: 0o644 });
  }
}
