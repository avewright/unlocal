import type { Account } from "./account.ts";
import type { Cloud } from "./clouds.ts";
import { assess, meteredPerDay, type GuardStatus } from "./guard.ts";
import { round2 } from "./pricing.ts";

/**
 * Where the money is going, in one answer: spent this month, how fast it's going now,
 * the limits, and when they'd be hit. Pure over the account, so the CLI's `spend`
 * screen, the console and agents all show the same numbers.
 */

const DAY_MS = 86_400_000;

export interface SpendProject {
  project: string;
  cloud: Cloud | "sim";
  /** Its priced plan, per day. */
  plannedPerDayUsd: number;
  /** What the cloud measured for it over the last day. */
  measuredLastDayUsd: number;
}

export interface SpendReport {
  month: string;
  spentUsd: number;
  monthlyCapUsd: number | null;
  /** Spending pace right now: priced plans plus the faster of the last hour's and day's measured pace. */
  perDayUsd: number;
  /** The measured pace over the last hour alone, to show a spike as it starts. */
  lastHourPerDayUsd: number;
  dailyLimitUsd: number | null;
  /** When this month's spend reaches the cap at the current pace; null if it won't this month. */
  capReachedAt: string | null;
  balanceUsd: number;
  projects: SpendProject[];
  guard: GuardStatus;
}

export function spendReport(account: Account, now: Date = new Date()): SpendReport {
  const guard = assess(account, now);
  const metered = meteredPerDay(account, now);
  const since = now.getTime() - DAY_MS;
  const measured = new Map<string, number>();
  for (const e of account.meterLog ?? []) {
    if (Date.parse(e.to) > since) measured.set(e.project, (measured.get(e.project) ?? 0) + e.usd);
  }
  const projects = Object.values(account.projects)
    .map((e) => ({
      project: e.project,
      cloud: e.live ? e.cloud : ("sim" as const),
      plannedPerDayUsd: e.live ? round2(e.monthlyUsd / 30) : 0,
      measuredLastDayUsd: round2(measured.get(e.project) ?? 0),
    }))
    .sort((a, b) => b.plannedPerDayUsd + b.measuredLastDayUsd - (a.plannedPerDayUsd + a.measuredLastDayUsd));

  const cap = account.monthlyCapUsd;
  let capReachedAt: string | null = null;
  if (cap !== null && guard.burnPerDayUsd > 0) {
    const at = now.getTime() + (Math.max(0, cap - guard.monthToDateUsd) / guard.burnPerDayUsd) * DAY_MS;
    if (at < Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) capReachedAt = new Date(at).toISOString();
  }
  return {
    month: now.toISOString().slice(0, 7),
    spentUsd: guard.monthToDateUsd,
    monthlyCapUsd: cap,
    perDayUsd: guard.burnPerDayUsd,
    lastHourPerDayUsd: round2(metered.lastHour),
    dailyLimitUsd: guard.dailyLimitUsd,
    capReachedAt,
    balanceUsd: round2(account.balanceUsd),
    projects,
    guard,
  };
}
