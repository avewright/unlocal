import { UnlocalError } from "../errors.ts";
import type { Outputs } from "../state.ts";
import type { ResourceSpec } from "../types.ts";
import type { Provider, ProviderContext } from "./provider.ts";

export interface SimProviderOptions {
  /** Resource names whose operations should fail — for exercising partial-failure paths. */
  failOn?: string[];
}

/**
 * Simulated cloud: no network calls, no cost, deterministic outputs.
 * Lets the full plan → apply → status loop run before (and alongside) real providers.
 */
export function createSimProvider(options: SimProviderOptions = {}): Provider {
  const failOn = new Set(options.failOn ?? []);
  const maybeFail = (op: string, name: string) => {
    if (failOn.has(name)) {
      throw new UnlocalError("PROVIDER_UNAVAILABLE", `simulated failure during ${op} of "${name}"`);
    }
  };

  const outputsFor = (ctx: ProviderContext, name: string, spec: ResourceSpec): Outputs => {
    const host = `${name}--${ctx.project}.${ctx.region}.${ctx.cloud}.sim.unlocal.dev`;
    switch (spec.type) {
      case "site":
      case "service":
        return { url: `https://${spec.domain ?? host}`, ...(spec.domain ? { defaultUrl: `https://${host}` } : {}) };
      case "postgres":
        return {
          host: `${name}.${ctx.project}.db.${ctx.region}.${ctx.cloud}.sim.unlocal.dev`,
          port: "5432",
          database: name.replace(/-/g, "_"),
          user: "app",
          passwordRef: `secret://${ctx.project}/${name}/password`,
        };
    }
  };

  return {
    name: "sim",
    async create(ctx, name, spec) {
      maybeFail("create", name);
      return outputsFor(ctx, name, spec);
    },
    async update(ctx, name, _before, after) {
      maybeFail("update", name);
      return outputsFor(ctx, name, after);
    },
    async delete(_ctx, name) {
      maybeFail("delete", name);
    },
  };
}
