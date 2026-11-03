import { CLOUDS_INFO, type Cloud } from "../clouds.ts";
import { UnlocalError } from "../errors.ts";
import type { Provider } from "./provider.ts";
import { createAwsProvider } from "./aws.ts";
import { createSimProvider } from "./sim.ts";

/**
 * Real providers, one per cloud, register here as they're built.
 * `--sim` runs the same plan against a simulated cloud instead.
 */
const LIVE: Partial<Record<Cloud, () => Provider>> = { aws: createAwsProvider };

export function getProvider(cloud: Cloud, options: { sim: boolean; env?: NodeJS.ProcessEnv }): Provider {
  const env = options.env ?? process.env;
  if (options.sim) return createSimProvider({ failOn: env.UNLOCAL_SIM_FAIL?.split(",").filter(Boolean) });
  const live = LIVE[cloud];
  if (!live) {
    throw new UnlocalError("PROVIDER_UNAVAILABLE", `deploying to ${CLOUDS_INFO[cloud].name} isn't available yet`, {
      hint: "add --sim to run this plan against a simulated cloud",
    });
  }
  return live();
}
