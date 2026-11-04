import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Cloud } from "./clouds.ts";
import { UnlocalError } from "./errors.ts";
import { withLock } from "./lock.ts";
import { round2 } from "./pricing.ts";

/**
 * The account: a prepaid balance, an account-wide monthly cap, a ledger of every
 * project's committed spend, and a transaction history. The cap spans all projects
 * and clouds, so spend can't creep up unnoticed. Local mode keeps this in
 * ~/.unlocal/account.json.
 */

export interface LedgerEntry {
  project: string;
  cloud: Cloud;
  monthlyUsd: number;
  /** Deployed to a real cloud (counts against the cap and balance) vs simulated. */
  live: boolean;
  updatedAt: string;
  /** Measured usage has been read from the cloud and charged up to this moment (see meter.ts). */
  meteredAt?: string;
}

export interface Transaction {
  id: string;
  /** `topup` = paid through Stripe; `credit` = development credit, no money moved; `charge` = usage taken from the balance. */
  kind: "topup" | "credit" | "charge";
  amountUsd: number;
  at: string;
  /** External reference (e.g. Stripe Checkout session); makes crediting idempotent. */
  ref?: string;
}

export interface Account {
  version: 1;
  monthlyCapUsd: number | null;
  balanceUsd: number;
  /** Keyed by absolute project directory. */
  projects: Record<string, LedgerEntry>;
  transactions: Transaction[];
  /** Usage has been charged to the balance up to this moment (see guard.ts). */
  settledAt?: string;
  /** While set, nothing new deploys. Only a human clears it. */
  frozen?: { at: string; reason: string; by: "guard" | "human" } | null;
  /** Recent live deploy times, for loop detection. */
  deploys?: string[];
  /** Measured spend per metering window, last 48 hours: the guard's live burn rate. */
  meterLog?: { project: string; from: string; to: string; usd: number }[];
  /** Fractions of a cent measured but not yet taken from the balance. */
  meterCarryUsd?: number;
}

export interface CapStatus {
  limitUsd: number;
  /** Live spend committed by every other project. */
  otherProjectsUsd: number;
  /** Account total per month if this plan is applied live. */
  projectedUsd: number;
  headroomUsd: number;
  withinCap: boolean;
  balanceUsd: number;
  /** The balance covers a full month of projectedUsd. */
  funded: boolean;
}

export const MAX_CAP_USD = 100_000;
export const TOPUP_MIN_USD = 5;
export const TOPUP_MAX_USD = 1_000;

export const accountHome = (env: NodeJS.ProcessEnv = process.env) => env.UNLOCAL_HOME ?? path.join(os.homedir(), ".unlocal");
const accountFile = (env: NodeJS.ProcessEnv) => path.join(accountHome(env), "account.json");

export async function loadAccount(env: NodeJS.ProcessEnv = process.env): Promise<Account> {
  let text: string;
  try {
    text = await readFile(accountFile(env), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, monthlyCapUsd: null, balanceUsd: 0, projects: {}, transactions: [] };
    }
    throw err;
  }
  try {
    const account = JSON.parse(text) as Account;
    if (account.version !== 1 || typeof account.projects !== "object") throw new Error("unrecognized format");
    account.balanceUsd ??= 0;
    account.transactions ??= [];
    return account;
  } catch (cause) {
    throw new UnlocalError("STATE_CORRUPT", `${accountFile(env)} is unreadable`, { cause });
  }
}

export async function saveAccount(account: Account, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = accountFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Load, change and save the account under a lock, so the CLI, console, MCP server and
 * guard running at once never lose each other's writes. Not re-entrant: don't nest calls.
 * A change that throws is not saved.
 */
export async function withAccount<T>(env: NodeJS.ProcessEnv, fn: (account: Account) => T | Promise<T>): Promise<T> {
  return withLock(accountFile(env), async () => {
    const account = await loadAccount(env);
    const result = await fn(account);
    await saveAccount(account, env);
    return result;
  }, { what: "the account" });
}

/** Add money to the balance. Returns false (and changes nothing) if `ref` was already credited. */
export function creditAccount(account: Account, amountUsd: number, kind: "topup" | "credit", ref?: string): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd < TOPUP_MIN_USD || amountUsd > TOPUP_MAX_USD) {
    throw new UnlocalError("USAGE", `amount must be between $${TOPUP_MIN_USD} and $${TOPUP_MAX_USD}`);
  }
  if (ref && account.transactions.some((t) => t.ref === ref)) return false;
  const amount = round2(amountUsd);
  account.balanceUsd = round2(account.balanceUsd + amount);
  account.transactions.unshift({
    id: `tx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind, amountUsd: amount, at: new Date().toISOString(), ...(ref ? { ref } : {}),
  });
  return true;
}

export function liveSpendUsd(account: Account, excludeDir?: string): number {
  return round2(
    Object.entries(account.projects)
      .filter(([dir, e]) => e.live && dir !== excludeDir)
      .reduce((s, [, e]) => s + e.monthlyUsd, 0),
  );
}

export function capStatus(account: Account, projectDir: string, projectMonthlyUsd: number): CapStatus | null {
  if (account.monthlyCapUsd === null) return null;
  const other = liveSpendUsd(account, projectDir);
  const projected = round2(other + projectMonthlyUsd);
  return {
    limitUsd: account.monthlyCapUsd,
    otherProjectsUsd: other,
    projectedUsd: projected,
    headroomUsd: round2(account.monthlyCapUsd - projected),
    withinCap: projected <= account.monthlyCapUsd,
    balanceUsd: account.balanceUsd,
    funded: projected <= account.balanceUsd,
  };
}
