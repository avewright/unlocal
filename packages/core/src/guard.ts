import { liveSpendUsd, withAccount, type Account } from "./account.ts";
import { UnlocalError } from "./errors.ts";
import { round2 } from "./pricing.ts";

/**
 * The guard: charges running resources to the prepaid balance, and steps in before
 * money runs out. Pure functions over the account; project.ts does the pausing.
 *
 *   warn   this month is projected past 80% of the cap, or the balance lasts < 7 days
 *   pause  this month has reached the cap, or the balance lasts < 1 day:
 *          live sites and services go offline (databases never), and deploys freeze
 *   freeze more than 50 live deploys in an hour (a runaway agent)
 *
 * Burn is each project's priced plan plus usage the cloud measured (meter.ts), at the
 * faster of the last hour's and the last day's pace, so a sudden runaway pauses quickly.
 */

export const GUARD = {
  warnCapRatio: 0.8,
  warnRunwayDays: 7,
  pauseRunwayDays: 1,
  maxDeploysPerHour: 50,
  /** The last hour running this many times the last day's pace is a spike... */
  spikeRatio: 5,
  /** ...once it's at least this much a day. */
  spikeMinPerDayUsd: 1,
} as const;

const DAY_MS = 86_400_000;
/** Monthly prices are charged over 30 days. */
const MONTH_MS = 30 * DAY_MS;
const iso = (d: Date) => d.toISOString();
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Cost of live resources since the last settlement, not yet taken from the balance. */
export function unsettledUsd(account: Account, now: Date): number {
  if (!account.settledAt) return 0;
  const elapsed = Math.max(0, now.getTime() - Date.parse(account.settledAt));
  return (liveSpendUsd(account) * elapsed) / MONTH_MS;
}

/**
 * Take whole cents of usage from the balance. Call it before the ledger changes so
 * every period is charged at the price that applied then. Returns the amount charged.
 */
export function settle(account: Account, now: Date = new Date()): number {
  if (!account.settledAt) {
    account.settledAt = iso(now);
    return 0;
  }
  const owed = unsettledUsd(account, now);
  const cents = Math.floor(owed * 100) / 100;
  if (cents < 0.01) {
    // Nothing running: restart the clock so idle time is never charged later.
    if (liveSpendUsd(account) === 0) account.settledAt = iso(now);
    return 0;
  }
  // Advance only by what was charged, so fractions of a cent carry over.
  account.settledAt = iso(new Date(Date.parse(account.settledAt) + (cents / liveSpendUsd(account)) * MONTH_MS));
  charge(account, cents, now);
  return cents;
}

/** Take `cents` (already whole cents) from the balance, as one "charge" line per day. */
export function charge(account: Account, cents: number, now: Date): void {
  account.balanceUsd = round2(account.balanceUsd - cents);
  const today = iso(now).slice(0, 10);
  const last = account.transactions[0];
  if (last?.kind === "charge" && last.at.slice(0, 10) === today) {
    last.amountUsd = round2(last.amountUsd + cents);
    last.at = iso(now);
  } else {
    account.transactions.unshift({ id: `tx_${now.getTime().toString(36)}`, kind: "charge", amountUsd: cents, at: iso(now) });
  }
}

/** Measured spend per day: at the pace of the last hour and of the last day. */
export function meteredPerDay(account: Account, now: Date): { lastHour: number; lastDay: number } {
  const rate = (windowMs: number) => {
    const start = now.getTime() - windowMs;
    const recent = (account.meterLog ?? []).filter((e) => Date.parse(e.to) > start);
    if (!recent.length) return 0;
    const covered = Math.max(15 * 60_000, now.getTime() - Math.max(start, Math.min(...recent.map((e) => Date.parse(e.from)))));
    return (recent.reduce((s, e) => s + e.usd, 0) * DAY_MS) / covered;
  };
  return { lastHour: rate(3_600_000), lastDay: rate(DAY_MS) };
}

export interface GuardStatus {
  level: "ok" | "warn" | "pause";
  reasons: string[];
  burnPerDayUsd: number;
  /** Days the balance lasts at the current burn; null when nothing is running. */
  runwayDays: number | null;
  monthToDateUsd: number;
  /** This month's spend if everything keeps running to the end of the month. */
  projectedMonthUsd: number;
  frozen: NonNullable<Account["frozen"]> | null;
  /** The part of burnPerDayUsd the cloud measured, rather than estimated from prices. */
  meteredPerDayUsd: number;
}

export function assess(account: Account, now: Date = new Date()): GuardStatus {
  const metered = meteredPerDay(account, now);
  const meteredBurn = Math.max(metered.lastHour, metered.lastDay);
  const burn = liveSpendUsd(account) / 30 + meteredBurn;
  const unsettled = unsettledUsd(account, now);
  const balance = account.balanceUsd - unsettled;
  const month = iso(now).slice(0, 7);
  const charged = account.transactions
    .filter((t) => t.kind === "charge" && t.at.slice(0, 7) === month)
    .reduce((s, t) => s + t.amountUsd, 0);
  const mtd = charged + unsettled;
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const projected = mtd + (burn * (monthEnd - now.getTime())) / DAY_MS;
  const runway = burn > 0 ? Math.max(0, balance) / burn : null;
  const cap = account.monthlyCapUsd;

  const pause: string[] = [];
  const warn: string[] = [];
  if (cap !== null && mtd >= cap) pause.push(`this month's spend ${usd(mtd)} reached the ${usd(cap)} cap`);
  else if (cap !== null && burn > 0 && projected >= cap * GUARD.warnCapRatio) {
    warn.push(`this month is on track for ${usd(projected)} of the ${usd(cap)} cap`);
  }
  if (runway !== null && runway < GUARD.pauseRunwayDays) {
    pause.push(`the balance runs out within a day (${usd(Math.max(0, balance))} left at ${usd(burn)}/day)`);
  } else if (runway !== null && runway < GUARD.warnRunwayDays) {
    warn.push(`the balance lasts about ${Math.floor(runway)} days at ${usd(burn)}/day`);
  }

  // The last day includes the last hour, so with no history before it the two are equal: no spike.
  if (metered.lastHour >= GUARD.spikeMinPerDayUsd && metered.lastHour >= GUARD.spikeRatio * metered.lastDay) {
    warn.push(`usage spiked: the last hour is running at ${usd(metered.lastHour)}/day`);
  }

  return {
    level: pause.length ? "pause" : warn.length ? "warn" : "ok",
    reasons: [...pause, ...warn],
    burnPerDayUsd: round2(burn),
    runwayDays: runway === null ? null : Math.round(runway * 10) / 10,
    monthToDateUsd: round2(mtd),
    projectedMonthUsd: round2(projected),
    frozen: account.frozen ?? null,
    meteredPerDayUsd: round2(meteredBurn),
  };
}

export function freeze(account: Account, reason: string, by: "guard" | "human", now: Date = new Date()): void {
  if (!account.frozen) account.frozen = { at: iso(now), reason, by };
}

export function assertNotFrozen(account: Account): void {
  if (account.frozen) {
    throw new UnlocalError("ACCOUNT_FROZEN", `deploys are frozen: ${account.frozen.reason}`, {
      details: account.frozen,
      hint: "a human reviews spending, then unfreezes in the console or with `unlocal unfreeze`",
    });
  }
}

/** Count a live deploy; freezes the account and returns true if this looks like a loop. */
export function recordDeploy(account: Account, now: Date = new Date()): boolean {
  const hourAgo = now.getTime() - 3_600_000;
  account.deploys = [...(account.deploys ?? []).filter((t) => Date.parse(t) > hourAgo), iso(now)];
  if (account.deploys.length > GUARD.maxDeploysPerHour) {
    freeze(account, `${account.deploys.length} deploys in the last hour looks like a loop`, "guard", now);
    return true;
  }
  return false;
}

/** Load, settle and save: the balance as of now. */
export async function settledAccount(env: NodeJS.ProcessEnv, now: Date = new Date()): Promise<Account> {
  return withAccount(env, (account) => {
    settle(account, now);
    return account;
  });
}
