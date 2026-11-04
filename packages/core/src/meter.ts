import { loadAccount, withAccount } from "./account.ts";
import { CLOUDS_INFO, type Cloud } from "./clouds.ts";
import type { ResourceType } from "./types.ts";
import { charge } from "./guard.ts";
import { round2 } from "./pricing.ts";
import { openProject } from "./project.ts";
import { getProvider } from "./providers/index.ts";

/**
 * Metering: read the usage each cloud measured, price it with clouds.ts, and charge it
 * to the balance. Feeds the guard's burn rate, so spending is watched as it happens
 * rather than estimated from list prices alone.
 *
 * Cloud analytics arrive a few minutes late, so each read stops METER_LAG_MS before now
 * and the next read starts where it stopped: nothing is counted twice or skipped.
 */

export const METER_LAG_MS = 5 * 60_000;
/** Keep 48 hours of metering windows: enough for the guard's one-day pace. */
const LOG_MS = 48 * 3_600_000;
/** Read at most a day per call; a project unmetered for longer catches up over several runs. */
const MAX_WINDOW_MS = 24 * 3_600_000;

export interface MeterLine {
  project: string;
  resource: string;
  metric: string;
  label: string;
  quantity: number;
  usd: number;
}

export interface MeterRun {
  /** Measured spend this run, before rounding to cents. */
  usd: number;
  /** Taken from the balance this run, in whole cents. */
  chargedUsd: number;
  lines: MeterLine[];
  /** Projects whose usage couldn't be read; they're retried next run from the same point. */
  errors: { project: string; error: string }[];
}

/**
 * Price one resource's usage. Metrics the cloud doesn't list in `meters`, or lists for
 * other resource types, are reported at $0.
 */
export function priceUsage(cloud: Cloud, project: string, resource: string, type: ResourceType, usage: Record<string, number>): MeterLine[] {
  const meters = CLOUDS_INFO[cloud].meters ?? {};
  return Object.entries(usage)
    .filter(([metric, quantity]) => meters[metric] && quantity > 0)
    .map(([metric, quantity]) => {
      const m = meters[metric]!;
      return { project, resource, metric, label: m.label, quantity, usd: m.types.includes(type) ? quantity * m.usdPerUnit : 0 };
    });
}

export async function meterUsage(env: NodeJS.ProcessEnv, now: Date = new Date()): Promise<MeterRun> {
  const to = new Date(now.getTime() - METER_LAG_MS);
  const account = await loadAccount(env);
  const lines: MeterLine[] = [];
  const errors: MeterRun["errors"] = [];
  /** project dir → [read from, read to, usd] */
  const read = new Map<string, { from: string; to: string; usd: number }>();

  for (const [dir, entry] of Object.entries(account.projects)) {
    if (!entry.live) continue;
    // A project starts being metered from when it was last deployed.
    const fromMs = Date.parse(entry.meteredAt ?? entry.updatedAt) || to.getTime();
    if (fromMs >= to.getTime()) continue;
    const window = { from: new Date(fromMs), to: new Date(Math.min(to.getTime(), fromMs + MAX_WINDOW_MS)) };
    try {
      const p = await openProject(dir, env);
      const provider = getProvider(p.config.cloud, { sim: false, env });
      let usd = 0;
      if (provider.usage) {
        for (const [name, r] of Object.entries(p.state.resources)) {
          const ctx = { project: p.state.project, cloud: r.cloud, region: r.region, dir, log: () => {} };
          const priced = priceUsage(r.cloud, entry.project, name, r.type, await provider.usage(ctx, name, r.spec, r.outputs, window));
          lines.push(...priced);
          usd += priced.reduce((s, l) => s + l.usd, 0);
        }
      }
      read.set(dir, { from: window.from.toISOString(), to: window.to.toISOString(), usd });
    } catch (err) {
      errors.push({ project: entry.project, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Network reads happen outside the lock; the charge happens inside it, and only for
  // windows another run hasn't already charged.
  const { usd, chargedUsd } = await withAccount(env, (a) => {
    let usd = 0;
    for (const [dir, w] of read) {
      const entry = a.projects[dir];
      if (!entry || (entry.meteredAt ?? entry.updatedAt) !== (account.projects[dir]!.meteredAt ?? account.projects[dir]!.updatedAt)) continue;
      entry.meteredAt = w.to;
      usd += w.usd;
      if (w.usd > 0) (a.meterLog ??= []).push({ project: entry.project, from: w.from, to: w.to, usd: w.usd });
    }
    a.meterLog = (a.meterLog ?? []).filter((e) => Date.parse(e.to) > now.getTime() - LOG_MS);
    const owed = (a.meterCarryUsd ?? 0) + usd;
    const cents = Math.floor(owed * 100) / 100;
    a.meterCarryUsd = owed - cents;
    if (cents >= 0.01) charge(a, round2(cents), now);
    return { usd, chargedUsd: cents >= 0.01 ? round2(cents) : 0 };
  });
  return { usd, chargedUsd, lines, errors };
}
