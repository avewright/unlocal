import type { CapStatus } from "./account.ts";
import { checkBudget, type BudgetStatus } from "./budget.ts";
import { canonicalJson, hashValue } from "./hash.ts";
import { estimateResource, round2 } from "./pricing.ts";
import type { ProjectState, ResourceState } from "./state.ts";
import type { Cloud } from "./clouds.ts";
import type { ProjectConfig, Region, ResourceSpec, ResourceType } from "./types.ts";

export type ActionKind = "create" | "update" | "replace" | "delete" | "noop";

export interface PlanAction {
  kind: ActionKind;
  name: string;
  type: ResourceType;
  /** Where the resource lives now (null if it doesn't exist yet). */
  from: { cloud: Cloud; region: Region } | null;
  /** Where it will live after apply (null if being deleted). */
  to: { cloud: Cloud; region: Region } | null;
  before: ResourceSpec | null;
  after: ResourceSpec | null;
  /** Top-level spec fields that differ. */
  changes: string[];
  /** Why an update must be a delete-and-recreate. */
  reason?: string;
  /** Would destroy stored data (e.g. deleting or replacing a database). */
  destructive: boolean;
  monthlyUsdBefore: number;
  monthlyUsdAfter: number;
  /** Content hash of a site's files after apply. */
  fingerprint?: string;
}

export interface PlanOptions {
  /** Site content hashes (see fingerprintSites); file edits become updates. */
  fingerprints?: Record<string, string>;
  /** Account-wide cap check for this plan; null when no cap is set. */
  cap?: (projectMonthlyUsd: number) => CapStatus | null;
}

export interface Plan {
  /** Pins the plan to exact config + state. Apply refuses a plan whose id no longer matches. */
  id: string;
  project: string;
  cloud: Cloud;
  region: Region;
  stateSerial: number;
  actions: PlanAction[];
  summary: Record<ActionKind, number>;
  cost: { currentMonthlyUsd: number; projectedMonthlyUsd: number; deltaMonthlyUsd: number };
  budget: BudgetStatus;
  /** Account-wide cap across every live project. null = no cap set (live applies are refused). */
  cap: CapStatus | null;
  hasChanges: boolean;
  destructive: boolean;
}

/** Dependencies first on create (databases before the services that use them); reverse on delete. */
const CREATE_ORDER: Record<ResourceType, number> = { postgres: 0, service: 1, site: 2 };

function changedFields(before: ResourceSpec, after: ResourceSpec): string[] {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k])).sort();
}

function replaceReason(existing: ResourceState, after: ResourceSpec, cloud: Cloud, region: Region): string | undefined {
  if (existing.cloud !== cloud) return `cloud changes ${existing.cloud} → ${cloud}`;
  if (existing.region !== region) return `region changes ${existing.region} → ${region}`;
  if (existing.type !== after.type) return `type changes ${existing.type} → ${after.type}`;
  if (existing.spec.type === "postgres" && after.type === "postgres" && after.storageGb < existing.spec.storageGb) {
    return "database storage cannot shrink in place";
  }
  return undefined;
}

export function createPlan(config: ProjectConfig, state: ProjectState, options: PlanOptions = {}): Plan {
  const actions: PlanAction[] = [];
  const prints = options.fingerprints ?? {};

  for (const [name, spec] of Object.entries(config.resources)) {
    const existing = state.resources[name];
    const to = { cloud: config.cloud, region: config.region };
    const monthlyUsdAfter = estimateResource(spec, config.cloud, config.region).monthlyUsd;
    const fingerprint = prints[name];
    if (!existing) {
      actions.push({
        kind: "create", name, type: spec.type, from: null, to,
        before: null, after: spec, changes: [], destructive: false, monthlyUsdBefore: 0, monthlyUsdAfter, fingerprint,
      });
      continue;
    }
    const base = {
      name, type: spec.type, from: { cloud: existing.cloud, region: existing.region }, to,
      before: existing.spec, after: spec, monthlyUsdBefore: existing.monthlyUsd, monthlyUsdAfter, fingerprint,
    };
    const changes = changedFields(existing.spec, spec);
    if (fingerprint !== undefined && fingerprint !== existing.fingerprint) changes.push("files");
    if (existing.paused) changes.push("paused"); // resuming is an update
    const reason = replaceReason(existing, spec, config.cloud, config.region);
    if (reason) {
      actions.push({ ...base, kind: "replace", reason, changes, destructive: existing.type === "postgres" });
    } else if (changes.length === 0) {
      actions.push({ ...base, kind: "noop", changes, destructive: false });
    } else {
      actions.push({ ...base, kind: "update", changes, destructive: false });
    }
  }

  const deletes: PlanAction[] = [];
  for (const [name, existing] of Object.entries(state.resources)) {
    if (name in config.resources) continue;
    deletes.push({
      kind: "delete", name, type: existing.type, from: { cloud: existing.cloud, region: existing.region }, to: null,
      before: existing.spec, after: null, changes: [], destructive: existing.type === "postgres",
      monthlyUsdBefore: existing.monthlyUsd, monthlyUsdAfter: 0,
    });
  }

  actions.sort((a, b) => CREATE_ORDER[a.type] - CREATE_ORDER[b.type] || a.name.localeCompare(b.name));
  deletes.sort((a, b) => CREATE_ORDER[b.type] - CREATE_ORDER[a.type] || a.name.localeCompare(b.name));
  const all = [...actions, ...deletes];

  const summary: Record<ActionKind, number> = { create: 0, update: 0, replace: 0, delete: 0, noop: 0 };
  for (const a of all) summary[a.kind]++;

  const current = round2(Object.values(state.resources).reduce((s, r) => s + r.monthlyUsd, 0));
  const projected = round2(all.reduce((s, a) => s + a.monthlyUsdAfter, 0));

  return {
    id: hashValue({ config, serial: state.serial, fingerprints: prints }).slice(0, 16),
    project: config.project,
    cloud: config.cloud,
    region: config.region,
    stateSerial: state.serial,
    actions: all,
    summary,
    cost: { currentMonthlyUsd: current, projectedMonthlyUsd: projected, deltaMonthlyUsd: round2(projected - current) },
    budget: checkBudget(projected, config.budget),
    cap: options.cap?.(projected) ?? null,
    hasChanges: all.some((a) => a.kind !== "noop"),
    destructive: all.some((a) => a.destructive),
  };
}
