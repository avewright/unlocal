import { existsSync } from "node:fs";
import { buildApp, detectFramework, readPackageJson, type BuildInfo } from "./build.ts";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApplyEvent } from "./apply.ts";
import { CLOUDS_INFO, type Cloud } from "./clouds.ts";
import { CONFIG_FILE } from "./config.ts";
import { UnlocalError } from "./errors.ts";
import type { Plan } from "./planner.ts";
import { openProject, planProject, runPlan } from "./project.ts";
import type { ProjectState } from "./state.ts";
import { NAME_PATTERN, parseConfig } from "./validate.ts";

/**
 * `up`: from a folder on disk to a live URL in one step.
 * Writes a starter unlocal.json if there isn't one, then deploys, but only when the
 * plan is safe to run unattended (nothing deleted or replaced) and within budget and cap.
 */

/** Where common tools put a built static site, most specific first. */
export const SITE_DIRS = ["dist", "build", "out", "_site", "public", "site"];
export const STARTER_BUDGET_USD = 5;

export function defaultProjectName(dir: string): string {
  const base = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 32);
  return NAME_PATTERN.test(base) ? base : "my-app";
}

/** The folder to publish, relative to `dir` (e.g. "./dist"), or SITE_NOT_FOUND saying what to do. */
export function detectSite(dir: string, options: { built?: boolean } = {}): string {
  const pkg = readPackageJson(dir);
  const framework = detectFramework(pkg);
  // The framework's own output folder first: a Vite app's public/ is source, not the site.
  const dirs = framework ? [framework.outDir, ...SITE_DIRS.filter((d) => d !== framework.outDir)] : SITE_DIRS;
  for (const d of dirs) if (existsSync(path.join(dir, d, "index.html"))) return `./${d}`;
  // A plain folder of HTML can be published as is; an app's root holds source code, not the site.
  if (!existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "index.html"))) return ".";
  const where = path.resolve(dir);
  if (options.built && framework) {
    throw new UnlocalError("SITE_NOT_FOUND", `the ${framework.name} build finished but left no index.html in ${framework.outDir}`, {
      hint: framework.hint ?? `point resources.web.path in ${CONFIG_FILE} at the built folder`,
    });
  }
  throw new UnlocalError("SITE_NOT_FOUND", `no built site with an index.html in ${where}`, {
    hint: pkg?.scripts?.build && !options.built
      ? "run `unlocal up` without --skip-build, or build it first (e.g. `npm run build`)"
      : `put the site in one of: ${SITE_DIRS.join(", ")}, or write ${CONFIG_FILE} with its path`,
  });
}

export function starterConfig(dir: string, sitePath: string, cloud: Cloud = "cloudflare") {
  return {
    project: defaultProjectName(dir),
    cloud,
    region: CLOUDS_INFO[cloud].defaultRegion,
    budget: { monthlyUsd: STARTER_BUDGET_USD },
    resources: { web: { type: "site", path: sitePath } },
  };
}

export interface UpOptions {
  sim: boolean;
  cloud?: Cloud;
  /** Run the project's build script first (default true). */
  build?: boolean;
  onEvent?: (e: ApplyEvent) => void;
  log?: (message: string) => void;
}

export interface UpResult {
  /** Set when `up` wrote unlocal.json. */
  createdConfig: string | null;
  /** Set when `up` ran the project's build script. */
  build: BuildInfo | null;
  url: string | null;
  plan: Plan;
  applied: { kind: string; name: string }[];
  state: ProjectState;
}

/** The site's URL: `up` publishes a site, even when the config also has services and databases. */
const firstUrl = (state: ProjectState) => {
  const resources = Object.values(state.resources);
  return (resources.find((r) => r.type === "site" && r.outputs.url) ?? resources.find((r) => r.outputs.url))?.outputs.url ?? null;
};

export async function up(dir: string, env: NodeJS.ProcessEnv, options: UpOptions): Promise<UpResult> {
  let createdConfig: string | null = null;
  // Build every time, so what goes live is the current code, never a stale dist/.
  const build = options.build === false ? null : await buildApp(dir, (line) => options.log?.(line));
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) {
    const raw = starterConfig(dir, detectSite(dir, { built: build !== null }), options.cloud);
    parseConfig(raw); // never write a config we'd reject
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
    createdConfig = file;
  }

  const project = await openProject(dir, env);
  const plan = await planProject(project);
  if (!plan.hasChanges) return { createdConfig, build, url: firstUrl(project.state), plan, applied: [], state: project.state };

  const removes = plan.actions.filter((a) => a.kind === "delete" || a.kind === "replace").map((a) => a.name);
  if (removes.length > 0) {
    throw new UnlocalError("APPROVAL_REQUIRED", `this deploy would delete or replace: ${removes.join(", ")}`, {
      details: { plan },
      hint: "review `unlocal plan`, then run `unlocal apply --yes`",
    });
  }

  let result;
  try {
    result = await runPlan(project, plan, { sim: options.sim, onEvent: options.onEvent, log: options.log });
  } catch (err) {
    // Refused before anything deployed (e.g. it costs money and no cap is set): leave the folder as it was.
    if (createdConfig && err instanceof UnlocalError && err.code === "CAP_NOT_SET") await rm(createdConfig, { force: true });
    throw err;
  }
  return {
    createdConfig,
    build,
    url: firstUrl(result.state),
    plan,
    applied: result.applied.map((a) => ({ kind: a.kind, name: a.name })),
    state: result.state,
  };
}
