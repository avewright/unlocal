import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { UnlocalError } from "./errors.ts";
import type { ProjectConfig } from "./types.ts";
import type { ConfigIssue } from "./validate.ts";

export interface SiteFile {
  /** Object key, e.g. `assets/app.js`. */
  key: string;
  absPath: string;
  size: number;
}

/** Caution limits for a static site: anything bigger is almost certainly a mistake (e.g. node_modules). */
const MAX_FILES = 10_000;
const MAX_BYTES = 1024 ** 3;

/** Every deployable file under `root`, sorted. Follows symlinks; skips dotfiles except `.well-known`. */
export async function listSiteFiles(root: string): Promise<SiteFile[]> {
  const out: SiteFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(dir)).sort()) {
      if (entry.startsWith(".") && entry !== ".well-known") continue;
      const abs = path.join(dir, entry);
      const st = await stat(abs);
      if (st.isDirectory()) await walk(abs, `${prefix}${entry}/`);
      else if (st.isFile()) out.push({ key: `${prefix}${entry}`, absPath: abs, size: st.size });
    }
  }
  await walk(root, "");
  return out;
}

/**
 * A content hash per site resource, so editing a file shows up in `plan`
 * as an update even though unlocal.json didn't change.
 */
export async function fingerprintSites(config: ProjectConfig, dir: string): Promise<Record<string, string>> {
  const issues: ConfigIssue[] = [];
  const fingerprints: Record<string, string> = {};

  for (const [name, spec] of Object.entries(config.resources)) {
    if (spec.type !== "site") continue;
    const at = `resources.${name}.path`;
    const root = path.resolve(dir, spec.path);
    const isDir = await stat(root).then((s) => s.isDirectory(), () => false);
    if (!isDir) {
      issues.push({ path: at, message: `directory ${spec.path} not found` });
      continue;
    }
    const files = await listSiteFiles(root);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    if (!files.some((f) => f.key === "index.html")) issues.push({ path: at, message: `${spec.path} has no index.html` });
    if (files.length > MAX_FILES) issues.push({ path: at, message: `${files.length} files is over the ${MAX_FILES} limit` });
    if (bytes > MAX_BYTES) issues.push({ path: at, message: `${(bytes / 1024 ** 2).toFixed(0)} MB is over the 1 GB limit` });

    const h = createHash("sha256");
    for (const f of files) h.update(`${f.key}\0`).update(await readFile(f.absPath)).update("\0");
    fingerprints[name] = h.digest("hex").slice(0, 16);
  }

  if (issues.length > 0) {
    throw new UnlocalError("CONFIG_INVALID", `${issues[0]!.path}: ${issues[0]!.message}`, {
      details: issues,
      hint: "point each site's path at a built directory containing index.html",
    });
  }
  return fingerprints;
}
