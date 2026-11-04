import path from "node:path";
import { capStatus, loadAccount, withAccount, type Account } from "./account.ts";
import { applyPlan, assertApplicable, type ApplyEvent, type ApplyResult } from "./apply.ts";
import { loadConfig } from "./config.ts";
import { fingerprintSites } from "./files.ts";
import { createPlan, type Plan } from "./planner.ts";
import { round2 } from "./pricing.ts";
import { getProvider } from "./providers/index.ts";
import type { Provider } from "./providers/provider.ts";
import { meterUsage, type MeterRun } from "./meter.ts";
import { assertNotFrozen, assess, freeze, recordDeploy, settle, type GuardStatus } from "./guard.ts";
import { withLock } from "./lock.ts";
import { loadState, saveState, statePath, type ProjectState } from "./state.ts";
import type { ProjectConfig } from "./types.ts";

/**
 * One project directory, opened. Shared by the CLI and the console so every
 * entry point plans, guards and records spend the same way.
 */
export interface OpenProject {
  dir: string;
  /** Absolute path; the account ledger is keyed by it. */
  key: string;
  config: ProjectConfig;
  state: ProjectState;
  account: Account;
  env: NodeJS.ProcessEnv;
}

export async function openProject(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<OpenProject> {
  const config = await loadConfig(dir);
  return {
    dir,
    key: path.resolve(dir),
    config,
    state: await loadState(dir, config.project),
    account: await loadAccount(env),
    env,
  };
}

/** Every plan carries site file fingerprints and the account-wide cap check. */
export async function planProject(p: OpenProject, config: ProjectConfig = p.config): Promise<Plan> {
  return createPlan(config, p.state, {
    fingerprints: await fingerprintSites(config, p.dir),
    cap: (monthly) => capStatus(p.account, p.key, monthly),
  });
}

/** Record this project's committed spend so the account cap sees every project. */
export async function recordSpend(p: OpenProject, state: ProjectState, live: boolean): Promise<void> {
  await withAccount(p.env, (account) => {
    settle(account); // charge the old price up to now before it changes
    // Paused resources cost nothing until they're resumed.
    const monthlyUsd = round2(Object.values(state.resources).reduce((s, r) => s + (r.paused ? 0 : r.monthlyUsd), 0));
    if (Object.keys(state.resources).length === 0) delete account.projects[p.key];
    else {
      const meteredAt = account.projects[p.key]?.meteredAt; // metering continues where it left off
      account.projects[p.key] = {
        project: state.project, cloud: p.config.cloud, monthlyUsd, live, updatedAt: new Date().toISOString(),
        ...(meteredAt ? { meteredAt } : {}),
      };
    }
  });
}

export interface RunOptions {
  sim: boolean;
  allowDataLoss?: boolean;
  /** Defaults to true for live runs. Destroy passes false: it only ever lowers spend. */
  enforceCap?: boolean;
  onEvent?: (e: ApplyEvent) => void;
  log?: (message: string) => void;
}

/** Guard, apply, persist state and ledger after every step. */
export async function runPlan(p: OpenProject, plan: Plan, options: RunOptions): Promise<ApplyResult> {
  const guards = { allowDataLoss: options.allowDataLoss ?? false, enforceCap: options.enforceCap ?? !options.sim };
  // One apply per project at a time: a second one waits, then sees a plan that no longer
  // matches the state on disk and fails PLAN_STALE instead of creating everything twice.
  return withLock(statePath(p.dir), async () => {
    const state = await loadState(p.dir, p.config.project);
    assertApplicable(plan, state, guards);
    if (guards.enforceCap && plan.hasChanges) {
      // Live deploys stop while frozen, and a burst of them freezes the account.
      const loop = await withAccount(p.env, (account) => {
        assertNotFrozen(account);
        return recordDeploy(account);
      });
      if (loop) assertNotFrozen(await loadAccount(p.env));
    }
    return applyPlan(plan, state, {
      ...guards,
      provider: getProvider(p.config.cloud, { sim: options.sim, env: p.env }),
      dir: p.dir,
      persist: async (s) => {
        await saveState(p.dir, s);
        await recordSpend(p, s, !options.sim);
      },
      onEvent: options.onEvent,
      log: options.log,
    });
  }, { what: `project "${p.config.project}"`, waitMs: 30_000, staleMs: 60_000 });
}

export interface PausedProject {
  dir: string;
  project: string;
  /** Taken offline; `unlocal apply` brings them back. */
  stopped: string[];
  /** "paused": still deployed, answering 503, quick to resume. "deleted": the cloud can't pause, so they were removed. */
  how: "paused" | "deleted";
  /** Databases are never deleted automatically; they keep running for a human to decide. */
  kept: string[];
  error?: string;
}

/** The project with only its databases: what's left running while paused. */
export function pausedConfig(config: ProjectConfig, state: ProjectState): ProjectConfig {
  const resources: ProjectConfig["resources"] = {};
  // Running databases stay exactly as they are, even ones already removed from unlocal.json.
  for (const [name, r] of Object.entries(state.resources)) if (r.type === "postgres") resources[name] = r.spec;
  return { ...config, resources };
}

/**
 * Take every live project's sites and services offline. Databases stay, so nothing
 * is lost and unlocal.json is untouched: unfreeze, then `unlocal apply` restores them.
 */
export async function pauseLiveProjects(env: NodeJS.ProcessEnv): Promise<PausedProject[]> {
  const account = await loadAccount(env);
  const out: PausedProject[] = [];
  for (const [dir, entry] of Object.entries(account.projects)) {
    if (!entry.live) continue;
    try {
      const p = await openProject(dir, env);
      const provider = getProvider(p.config.cloud, { sim: false, env });
      if (provider.pause) {
        out.push({ dir, project: entry.project, ...(await pauseInPlace(p, provider.pause.bind(provider))) });
        continue;
      }
      const paused = pausedConfig(p.config, p.state);
      const kept = Object.keys(paused.resources);
      const plan = await planProject(p, paused);
      const result = plan.hasChanges
        ? await runPlan(p, plan, { sim: false, enforceCap: false, allowDataLoss: false })
        : { applied: [] };
      out.push({ dir, project: entry.project, stopped: result.applied.map((a) => a.name), kept, how: "deleted" });
    } catch (err) {
      out.push({ dir, project: entry.project, stopped: [], kept: [], how: "paused", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Swap each site and service for its paused form, saving state after every one. */
async function pauseInPlace(p: OpenProject, pause: NonNullable<Provider["pause"]>): Promise<Pick<PausedProject, "stopped" | "kept" | "how">> {
  // Same lock as apply, and the state as it is now, so a pause never overwrites a newer deploy.
  return withLock(statePath(p.dir), async () => {
    const state = await loadState(p.dir, p.config.project);
    return pauseState(p, state, pause);
  }, { what: `project "${p.config.project}"`, waitMs: 30_000, staleMs: 60_000 });
}

async function pauseState(p: OpenProject, state: ProjectState, pause: NonNullable<Provider["pause"]>): Promise<Pick<PausedProject, "stopped" | "kept" | "how">> {
  const stopped: string[] = [];
  const kept: string[] = [];
  for (const [name, r] of Object.entries(state.resources)) {
    if (r.type === "postgres") {
      kept.push(name);
      continue;
    }
    if (r.paused) continue;
    const ctx = { project: state.project, cloud: r.cloud, region: r.region, dir: p.dir, log: () => {} };
    r.outputs = await pause(ctx, name, r.spec, r.outputs);
    r.paused = new Date().toISOString();
    state.serial++; // a plan made before the pause is stale
    await saveState(p.dir, state);
    await recordSpend(p, state, true);
    stopped.push(name);
  }
  return { stopped, kept, how: "paused" };
}

export interface GuardRun {
  status: GuardStatus;
  /** Usage read from the clouds this run; null on a dry run. */
  metered: MeterRun | null;
  /** Set when this run froze the account. */
  froze: boolean;
  paused: PausedProject[];
}

/** Meter, settle, assess, and at `pause` freeze deploys and take live projects offline. */
export async function runGuard(env: NodeJS.ProcessEnv, options: { dryRun?: boolean; now?: Date } = {}): Promise<GuardRun> {
  const now = options.now ?? new Date();
  const metered = options.dryRun ? null : await meterUsage(env, now);
  const { status, froze } = await withAccount(env, (account) => {
    settle(account, now);
    const status = assess(account, now);
    let froze = false;
    if (status.level === "pause" && !options.dryRun) {
      froze = !account.frozen;
      freeze(account, status.reasons[0]!, "guard", now);
    }
    return { status, froze };
  });
  const paused = status.level === "pause" && !options.dryRun ? await pauseLiveProjects(env) : [];
  return { status, metered, froze, paused };
}

/** The kill switch: freeze deploys and take everything live offline, now. */
export async function stopEverything(env: NodeJS.ProcessEnv, reason = "stopped by a human"): Promise<PausedProject[]> {
  await withAccount(env, (account) => {
    settle(account);
    freeze(account, reason, "human");
  });
  return pauseLiveProjects(env);
}

/** Only a human calls this: clears the freeze and the deploy-loop window. */
export async function unfreezeAccount(env: NodeJS.ProcessEnv): Promise<void> {
  await withAccount(env, (account) => {
    account.frozen = null;
    account.deploys = [];
  });
}
