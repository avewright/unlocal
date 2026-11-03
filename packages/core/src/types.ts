import type { Cloud } from "./clouds.ts";

/**
 * The unlocal resource model. Users and agents describe *what* they want
 * (a site, a service, a database); providers decide how that maps onto
 * each hyperscaler's managed services (see clouds.ts). Raw cloud resource types are never exposed.
 */

export const RESOURCE_TYPES = ["site", "service", "postgres"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** A region id of the project's cloud, e.g. `us-east-1` or `europe-west1`. See CLOUDS_INFO. */
export type Region = string;

export const POSTGRES_SIZES = ["small", "medium", "large"] as const;
export type PostgresSize = (typeof POSTGRES_SIZES)[number];

/** Valid vCPU values and the memory range (GB) each allows. */
export const SERVICE_CPU_MEMORY: Record<string, readonly [number, number]> = {
  "0.25": [0.5, 2],
  "0.5": [1, 4],
  "1": [2, 8],
  "2": [4, 16],
  "4": [8, 30],
};

/** Static site: files on object storage behind a CDN with HTTPS. */
export interface SiteSpec {
  type: "site";
  /** Directory of built static files, relative to unlocal.json. */
  path: string;
  domain?: string;
  /** Serve index.html for unknown paths (single-page apps). */
  spa: boolean;
}

/** Long-running container behind a load balancer with HTTPS. */
export interface ServiceSpec {
  type: "service";
  /** Directory containing a Dockerfile, or a container image reference. */
  source: string;
  port: number;
  cpu: number;
  memoryGb: number;
  instances: number;
  domain?: string;
  env: Record<string, string>;
}

/** Managed Postgres database. */
export interface PostgresSpec {
  type: "postgres";
  size: PostgresSize;
  storageGb: number;
  highAvailability: boolean;
}

export type ResourceSpec = SiteSpec | ServiceSpec | PostgresSpec;

export interface BudgetConfig {
  /** Hard monthly ceiling. Applies that would exceed it are refused. */
  monthlyUsd: number;
  /** Flag the plan when projected spend crosses this share of the budget. */
  alertAtPercent: number;
}

/** Contents of unlocal.json after validation and defaulting. */
export interface ProjectConfig {
  project: string;
  cloud: Cloud;
  region: Region;
  budget: BudgetConfig;
  resources: Record<string, ResourceSpec>;
}
