import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NAME_PATTERN, UnlocalError, parseConfig, up } from "@unlocal/core";
import { validateBundle, writeBundle, type BundleFile, type BundleLimits } from "./bundle.ts";

/**
 * One hosted deploy. The control plane owns the project directory and the tenant's
 * isolated `UNLOCAL_HOME`; this module only turns an upload into a project and runs
 * the same `up()` the CLI does, so budgets, caps and state stay in one place.
 */

/** Where a deployed site lives inside the customer's project directory. */
export const PUBLIC_DIR = "public";

/**
 * A cloud-safe project name that is unique per tenant: tenants may both call a site
 * "web", and Worker/bucket names are global within the cloud account.
 */
export function hostedProjectName(tenantSlug: string, project: string): string {
  const clean = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const raw = `${clean(tenantSlug)}-${clean(project)}`.replace(/^-+|-+$/g, "") || "site";
  const named = /^[a-z]/.test(raw) ? raw : `p-${raw}`;
  if (named.length <= 32) return named;
  const hash = createHash("sha256").update(named).digest("hex").slice(0, 6);
  return `${named.slice(0, 25).replace(/-+$/, "")}-${hash}`;
}

export interface DeployInput {
  /** Persistent directory for this tenant + project (state survives deploys). */
  projectDir: string;
  /** Tenant's slug, e.g. `acme`; only used to make the cloud name unique. */
  tenant: string;
  /** The customer's name for this site, e.g. `docs`. */
  project: string;
  files: readonly BundleFile[];
  /** The project ceiling. The account cap is the tenant's, set outside this module. */
  budgetUsd: number;
  /** Must carry the tenant's `UNLOCAL_HOME` and cloud credentials when not simulating. */
  env: NodeJS.ProcessEnv;
  sim?: boolean;
  limits?: BundleLimits;
}

export interface DeployResult {
  /** Cloud name actually deployed (unique across tenants). */
  project: string;
  url: string | null;
  monthlyUsd: number;
  applied: { kind: string; name: string }[];
}

export async function deploySite(input: DeployInput): Promise<DeployResult> {
  const files = validateBundle(input.files, input.limits);
  const project = hostedProjectName(input.tenant, input.project);
  if (!NAME_PATTERN.test(project)) {
    throw new UnlocalError("INTERNAL", `unusable project name: ${project}`, { hint: "this is a bug in unlocal" });
  }

  const config = parseConfig({
    project,
    cloud: "cloudflare",
    region: "global",
    budget: { monthlyUsd: Math.max(1, Math.min(input.budgetUsd, 100_000)) },
    resources: { web: { type: "site", path: `./${PUBLIC_DIR}` } },
  });

  await writeBundle(path.join(input.projectDir, PUBLIC_DIR), files);
  await writeFile(path.join(input.projectDir, "unlocal.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const result = await up(input.projectDir, input.env, { sim: input.sim ?? false });
  return {
    project,
    url: result.url,
    monthlyUsd: result.plan.cost.projectedMonthlyUsd,
    applied: result.applied,
  };
}
