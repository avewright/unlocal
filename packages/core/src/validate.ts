import { UnlocalError } from "./errors.ts";
import { CLOUDS, CLOUDS_INFO, type Cloud } from "./clouds.ts";
import {
  POSTGRES_SIZES,
  RESOURCE_TYPES,
  SERVICE_CPU_MEMORY,
  type BudgetConfig,
  type PostgresSize,
  type PostgresSpec,
  type ProjectConfig,
  type Region,
  type ResourceSpec,
  type ServiceSpec,
  type SiteSpec,
} from "./types.ts";

export interface ConfigIssue {
  /** Dotted path to the offending field, e.g. `resources.api.cpu`. */
  path: string;
  message: string;
}

export const NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RESOURCES = 50;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const join = (base: string, key: string) => (base ? `${base}.${key}` : key);

class Checker {
  readonly issues: ConfigIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  /** Unknown keys are errors: they are almost always typos, and silently ignoring them surprises agents. */
  noUnknownKeys(obj: Obj, allowed: readonly string[], base: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) this.add(join(base, key), `unknown field (allowed: ${allowed.join(", ")})`);
    }
  }

  str(obj: Obj, key: string, base: string, required: boolean): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (required) this.add(join(base, key), "is required");
      return undefined;
    }
    if (typeof v !== "string" || v.length === 0) {
      this.add(join(base, key), "must be a non-empty string");
      return undefined;
    }
    return v;
  }

  oneOf<T extends string>(obj: Obj, key: string, base: string, allowed: readonly T[], def?: T): T | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (def === undefined) this.add(join(base, key), `is required (one of: ${allowed.join(", ")})`);
      return def;
    }
    if (!allowed.includes(v as T)) {
      this.add(join(base, key), `must be one of: ${allowed.join(", ")}`);
      return def;
    }
    return v as T;
  }

  num(
    obj: Obj,
    key: string,
    base: string,
    opts: { def?: number; min: number; max: number; integer?: boolean },
  ): number | undefined {
    const v = obj[key];
    const path = join(base, key);
    if (v === undefined) {
      if (opts.def === undefined) this.add(path, "is required");
      return opts.def;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.add(path, "must be a number");
      return opts.def;
    }
    if (opts.integer && !Number.isInteger(v)) {
      this.add(path, "must be a whole number");
      return opts.def;
    }
    if (v < opts.min || v > opts.max) {
      this.add(path, `must be between ${opts.min} and ${opts.max}`);
      return opts.def;
    }
    return v;
  }

  bool(obj: Obj, key: string, base: string, def: boolean): boolean {
    const v = obj[key];
    if (v === undefined) return def;
    if (typeof v !== "boolean") {
      this.add(join(base, key), "must be true or false");
      return def;
    }
    return v;
  }

  domain(obj: Obj, base: string): string | undefined {
    const d = this.str(obj, "domain", base, false);
    if (d !== undefined && !HOSTNAME_PATTERN.test(d)) {
      this.add(join(base, "domain"), "must be a lowercase hostname like app.example.com");
      return undefined;
    }
    return d;
  }
}

function parseSite(c: Checker, raw: Obj, base: string): SiteSpec {
  c.noUnknownKeys(raw, ["type", "path", "domain", "spa"], base);
  const spec: SiteSpec = {
    type: "site",
    path: c.str(raw, "path", base, true) ?? ".",
    spa: c.bool(raw, "spa", base, false),
  };
  const domain = c.domain(raw, base);
  if (domain) spec.domain = domain;
  return spec;
}

function parseService(c: Checker, raw: Obj, base: string): ServiceSpec {
  c.noUnknownKeys(raw, ["type", "source", "port", "cpu", "memoryGb", "instances", "domain", "env"], base);
  const cpu = c.num(raw, "cpu", base, { def: 0.25, min: 0.25, max: 4 }) ?? 0.25;
  const range = SERVICE_CPU_MEMORY[String(cpu)];
  if (!range) c.add(join(base, "cpu"), `must be one of: ${Object.keys(SERVICE_CPU_MEMORY).join(", ")}`);
  const memoryGb = c.num(raw, "memoryGb", base, { def: range ? range[0] : 0.5, min: 0.5, max: 30 }) ?? 0.5;
  if (range && (memoryGb < range[0] || memoryGb > range[1])) {
    c.add(join(base, "memoryGb"), `with cpu ${cpu} must be between ${range[0]} and ${range[1]}`);
  }

  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!isObj(raw.env)) c.add(join(base, "env"), "must be an object of string values");
    else {
      for (const [k, v] of Object.entries(raw.env)) {
        if (!ENV_KEY_PATTERN.test(k)) c.add(join(base, `env.${k}`), "is not a valid environment variable name");
        else if (typeof v !== "string") c.add(join(base, `env.${k}`), "must be a string");
        else env[k] = v;
      }
    }
  }

  const spec: ServiceSpec = {
    type: "service",
    source: c.str(raw, "source", base, true) ?? ".",
    port: c.num(raw, "port", base, { def: 8080, min: 1, max: 65535, integer: true }) ?? 8080,
    cpu,
    memoryGb,
    instances: c.num(raw, "instances", base, { def: 1, min: 1, max: 20, integer: true }) ?? 1,
    env,
  };
  const domain = c.domain(raw, base);
  if (domain) spec.domain = domain;
  return spec;
}

function parsePostgres(c: Checker, raw: Obj, base: string): PostgresSpec {
  c.noUnknownKeys(raw, ["type", "size", "storageGb", "highAvailability"], base);
  return {
    type: "postgres",
    size: c.oneOf<PostgresSize>(raw, "size", base, POSTGRES_SIZES, "small") ?? "small",
    storageGb: c.num(raw, "storageGb", base, { def: 20, min: 20, max: 1000, integer: true }) ?? 20,
    highAvailability: c.bool(raw, "highAvailability", base, false),
  };
}

/**
 * Validate raw unlocal.json contents and fill in defaults.
 * Collects every problem at once so a caller can fix them in one pass.
 */
export function parseConfig(raw: unknown): ProjectConfig {
  const c = new Checker();
  if (!isObj(raw)) {
    throw new UnlocalError("CONFIG_INVALID", "unlocal.json must contain a JSON object", {
      details: [{ path: "", message: "expected an object" }],
    });
  }
  c.noUnknownKeys(raw, ["$schema", "project", "cloud", "region", "budget", "resources"], "");

  const project = c.str(raw, "project", "", true) ?? "invalid";
  if (raw.project !== undefined && !NAME_PATTERN.test(project)) {
    c.add("project", "must be 1-32 lowercase letters, digits or dashes, starting with a letter");
  }
  const cloud = c.oneOf<Cloud>(raw, "cloud", "", CLOUDS, "aws") ?? "aws";
  const regions = Object.keys(CLOUDS_INFO[cloud].regions);
  const region = c.oneOf<Region>(raw, "region", "", regions, CLOUDS_INFO[cloud].defaultRegion) ?? CLOUDS_INFO[cloud].defaultRegion;

  let budget: BudgetConfig = { monthlyUsd: 0, alertAtPercent: 80 };
  if (!isObj(raw.budget)) {
    c.add("budget", "is required, e.g. { \"monthlyUsd\": 25 } — every project needs a spending ceiling");
  } else {
    c.noUnknownKeys(raw.budget, ["monthlyUsd", "alertAtPercent"], "budget");
    budget = {
      monthlyUsd: c.num(raw.budget, "monthlyUsd", "budget", { min: 1, max: 100_000 }) ?? 0,
      alertAtPercent: c.num(raw.budget, "alertAtPercent", "budget", { def: 80, min: 1, max: 100 }) ?? 80,
    };
  }

  const resources: Record<string, ResourceSpec> = {};
  if (raw.resources !== undefined && !isObj(raw.resources)) {
    c.add("resources", "must be an object keyed by resource name");
  } else if (isObj(raw.resources)) {
    const entries = Object.entries(raw.resources);
    if (entries.length > MAX_RESOURCES) c.add("resources", `at most ${MAX_RESOURCES} resources per project`);
    for (const [name, value] of entries) {
      const base = `resources.${name}`;
      if (!NAME_PATTERN.test(name)) {
        c.add(base, "resource names must be 1-32 lowercase letters, digits or dashes, starting with a letter");
        continue;
      }
      if (!isObj(value)) {
        c.add(base, "must be an object");
        continue;
      }
      const type = c.oneOf(value, "type", base, RESOURCE_TYPES);
      const info = CLOUDS_INFO[cloud];
      if (type && !info.native[type]) {
        const offered = RESOURCE_TYPES.filter((t) => info.native[t]).map((t) => `${t}s`).join(", ");
        c.add(`${base}.type`, `${info.name} hosts only ${offered}; put this ${type} in a project on another cloud`);
        continue;
      }
      if (type === "site") resources[name] = parseSite(c, value, base);
      else if (type === "service") resources[name] = parseService(c, value, base);
      else if (type === "postgres") resources[name] = parsePostgres(c, value, base);
    }
  }

  if (c.issues.length > 0) {
    const first = c.issues[0]!;
    throw new UnlocalError(
      "CONFIG_INVALID",
      `unlocal.json has ${c.issues.length} problem${c.issues.length === 1 ? "" : "s"}; first: ${first.path} ${first.message}`,
      { details: c.issues, hint: "fix every issue listed in details, then re-run" },
    );
  }
  return { project, cloud, region, budget, resources };
}
