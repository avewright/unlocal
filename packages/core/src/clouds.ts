import type { PostgresSize, ResourceType } from "./types.ts";

/**
 * Everything cloud-specific lives here. The rest of unlocal is cloud-neutral:
 * adding a cloud means adding one entry to CLOUDS_INFO (plus, later, its provider).
 */

export const CLOUDS = ["aws", "gcp", "azure", "oci", "cloudflare"] as const;
export type Cloud = (typeof CLOUDS)[number];

export interface CloudRates {
  site: { hostingMonth: number; dnsZoneMonth: number };
  service?: {
    vcpuHour: number;
    gbHour: number;
    /** Per-instance fixed cost (e.g. a public IPv4 address). */
    instanceHour: number;
    /** HTTPS entry point (load balancer); 0 where the platform includes it. */
    ingressHour: number;
    /** Round a requested shape up to one the platform actually bills. */
    shape?: (cpu: number, memoryGb: number) => { cpu: number; memoryGb: number };
  };
  postgres?: { instanceHour: Record<PostgresSize, number>; storageGbMonth: number };
}

export interface CloudInfo {
  name: string;
  defaultRegion: string;
  /** Supported regions → price multiplier relative to defaultRegion. */
  regions: Record<string, number>;
  /** The managed service each unlocal resource type becomes on this cloud. Missing: not offered here. */
  native: Partial<Record<ResourceType, string>>;
  /** On-demand list prices in USD for defaultRegion. */
  rates: CloudRates;
}

// Prices checked 2026-11. Values marked "unverified" are estimates: confirm them before launch.
export const CLOUDS_INFO: Record<Cloud, CloudInfo> = {
  aws: {
    name: "AWS",
    defaultRegion: "us-east-1",
    regions: { "us-east-1": 1, "us-east-2": 1, "us-west-2": 1, "eu-west-1": 1.08, "eu-central-1": 1.12, "ap-southeast-1": 1.15 },
    native: { site: "S3 + CloudFront", service: "ECS Fargate + ALB", postgres: "RDS for PostgreSQL" },
    rates: {
      site: { hostingMonth: 0.25, dnsZoneMonth: 0.5 },
      service: { vcpuHour: 0.04048, gbHour: 0.004445, instanceHour: 0.005, ingressHour: 0.0225 + 0.008 },
      postgres: { instanceHour: { small: 0.016, medium: 0.032, large: 0.065 }, storageGbMonth: 0.115 },
    },
  },
  gcp: {
    name: "Google Cloud",
    defaultRegion: "us-central1",
    regions: { "us-central1": 1, "us-east1": 1, "us-west1": 1, "europe-west1": 1.1, "europe-west3": 1.2, "asia-southeast1": 1.2 },
    native: { site: "Firebase Hosting", service: "Cloud Run", postgres: "Cloud SQL for PostgreSQL" },
    rates: {
      site: { hostingMonth: 0.25, dnsZoneMonth: 0.2 },
      // Cloud Run instance-based billing: $0.000018/vCPU-s, $0.000002/GiB-s. HTTPS included.
      service: { vcpuHour: 0.0648, gbHour: 0.0072, instanceHour: 0, ingressHour: 0 },
      // db-f1-micro, db-g1-small, 1 vCPU / 3.75 GB (unverified).
      postgres: { instanceHour: { small: 0.0105, medium: 0.035, large: 0.0676 }, storageGbMonth: 0.17 },
    },
  },
  azure: {
    name: "Azure",
    defaultRegion: "eastus",
    regions: { eastus: 1, eastus2: 1, westus2: 1, westeurope: 1.1, germanywestcentral: 1.15, southeastasia: 1.15 },
    native: { site: "Static Web Apps", service: "Container Apps", postgres: "Database for PostgreSQL" },
    rates: {
      site: { hostingMonth: 0, dnsZoneMonth: 0.5 },
      // Container Apps: $0.000024/vCPU-s, $0.000003/GiB-s. HTTPS ingress included.
      service: {
        vcpuHour: 0.0864, gbHour: 0.0108, instanceHour: 0, ingressHour: 0,
        // Container Apps allocates 2 GiB per vCPU.
        shape: (cpu, memoryGb) => {
          const c = Math.max(cpu, memoryGb / 2);
          return { cpu: c, memoryGb: c * 2 };
        },
      },
      // Flexible Server B1ms (~$12/mo); B2s and D2ds_v5 unverified.
      postgres: { instanceHour: { small: 0.0164, medium: 0.068, large: 0.178 }, storageGbMonth: 0.115 },
    },
  },
  oci: {
    name: "Oracle Cloud",
    defaultRegion: "us-ashburn-1",
    // OCI charges the same price in every commercial region.
    regions: { "us-ashburn-1": 1, "us-phoenix-1": 1, "eu-frankfurt-1": 1, "uk-london-1": 1, "ap-singapore-1": 1 },
    native: { site: "Object Storage + Load Balancer", service: "Container Instances + Load Balancer", postgres: "Database with PostgreSQL" },
    rates: {
      site: { hostingMonth: 0.1, dnsZoneMonth: 0 },
      // Container Instances bill at compute rates: ~$0.025/OCPU-h (1 OCPU = 2 vCPU), $0.0015/GB-h.
      // Flexible load balancer: base + 10 Mbps.
      service: { vcpuHour: 0.0125, gbHour: 0.0015, instanceHour: 0, ingressHour: 0.0123 },
      // OCI Database with PostgreSQL: unverified. Oracle publishes rates only via its estimator.
      postgres: { instanceHour: { small: 0.098, medium: 0.196, large: 0.392 }, storageGbMonth: 0.075 },
    },
  },
  cloudflare: {
    name: "Cloudflare",
    // Served from Cloudflare's whole network; there's no region to pick.
    defaultRegion: "global",
    regions: { global: 1 },
    native: { site: "Workers static assets" },
    rates: {
      // Workers Free: static asset requests are free and unlimited; DNS is free.
      site: { hostingMonth: 0, dnsZoneMonth: 0 },
    },
  },
};
