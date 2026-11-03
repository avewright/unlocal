import { CLOUDS_INFO, type Cloud } from "./clouds.ts";
import type { Region, ResourceSpec } from "./types.ts";

/**
 * Monthly cost estimates. These are deliberately simple, conservative
 * list-price models so `plan` can show a number *before* anything is created.
 * Real spend is reconciled later from each cloud's billing exports.
 */

export interface LineItem {
  description: string;
  monthlyUsd: number;
}

export interface CostEstimate {
  monthlyUsd: number;
  lineItems: LineItem[];
}

export const HOURS_PER_MONTH = 730;

/** unlocal's margin on top of cloud cost. Placeholder: pricing is a business decision. */
export const PLATFORM_FEE_RATE = 0.1;

export const round2 = (n: number) => Math.round(n * 100) / 100;

function cloudLineItems(spec: ResourceSpec, cloud: Cloud): LineItem[] {
  const { native, rates } = CLOUDS_INFO[cloud];
  const dns = (domain: string | undefined): LineItem[] =>
    domain ? [{ description: `DNS zone for ${domain}`, monthlyUsd: rates.site.dnsZoneMonth }] : [];

  switch (spec.type) {
    case "site":
      return [
        { description: `${native.site} (typical small site)`, monthlyUsd: rates.site.hostingMonth },
        ...dns(spec.domain),
      ];
    case "service": {
      const r = rates.service;
      const { cpu, memoryGb } = r.shape ? r.shape(spec.cpu, spec.memoryGb) : spec;
      const perInstance = (cpu * r.vcpuHour + memoryGb * r.gbHour + r.instanceHour) * HOURS_PER_MONTH;
      const items: LineItem[] = [
        {
          description: `${native.service}: ${spec.instances} × ${cpu} vCPU, ${memoryGb} GB`,
          monthlyUsd: perInstance * spec.instances,
        },
      ];
      if (r.ingressHour > 0) items.push({ description: "Load balancer + HTTPS", monthlyUsd: r.ingressHour * HOURS_PER_MONTH });
      return [...items, ...dns(spec.domain)];
    }
    case "postgres": {
      const copies = spec.highAvailability ? 2 : 1;
      const ha = spec.highAvailability ? ", high availability" : "";
      return [
        {
          description: `${native.postgres}: ${spec.size}${ha}`,
          monthlyUsd: rates.postgres.instanceHour[spec.size] * HOURS_PER_MONTH * copies,
        },
        { description: `${spec.storageGb} GB storage${ha}`, monthlyUsd: spec.storageGb * rates.postgres.storageGbMonth * copies },
      ];
    }
  }
}

export function estimateResource(spec: ResourceSpec, cloud: Cloud, region: Region): CostEstimate {
  const multiplier = CLOUDS_INFO[cloud].regions[region] ?? 1;
  const items = cloudLineItems(spec, cloud).map((i) => ({ ...i, monthlyUsd: i.monthlyUsd * multiplier }));
  const cloudTotal = items.reduce((sum, i) => sum + i.monthlyUsd, 0);
  items.push({ description: `unlocal platform fee (${PLATFORM_FEE_RATE * 100}%)`, monthlyUsd: cloudTotal * PLATFORM_FEE_RATE });
  const lineItems = items.map((i) => ({ ...i, monthlyUsd: round2(i.monthlyUsd) }));
  return { monthlyUsd: round2(lineItems.reduce((sum, i) => sum + i.monthlyUsd, 0)), lineItems };
}
