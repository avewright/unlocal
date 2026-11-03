import path from "node:path";
import { capStatus, loadAccount, saveAccount, type Account } from "./account.ts";
import { applyPlan, assertApplicable, type ApplyEvent, type ApplyResult } from "./apply.ts";
import { loadConfig } from "./config.ts";
import { fingerprintSites } from "./files.ts";
import { createPlan, type Plan } from "./planner.ts";
import { round2 } from "./pricing.ts";
import { getProvider } from "./providers/index.ts";
import { loadState, saveState, type ProjectState } from "./state.ts";
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
  const account = await loadAccount(p.env);
  const monthlyUsd = round2(Object.values(state.resources).reduce((s, r) => s + r.monthlyUsd, 0));
  if (Object.keys(state.resources).length === 0) delete account.projects[p.key];
  else {
    account.projects[p.key] = { project: state.project, cloud: p.config.cloud, monthlyUsd, live, updatedAt: new Date().toISOString() };
  }
  await saveAccount(account, p.env);
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
  assertApplicable(plan, p.state, guards);
  return applyPlan(plan, p.state, {
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
}
