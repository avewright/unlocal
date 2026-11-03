import type { Cloud } from "../clouds.ts";
import type { Outputs } from "../state.ts";
import type { Region, ResourceSpec } from "../types.ts";

export interface ProviderContext {
  project: string;
  cloud: Cloud;
  region: Region;
  /** Project directory (where unlocal.json lives); site paths resolve against it. */
  dir: string;
  /** Progress for slow operations, shown to humans. */
  log: (message: string) => void;
}

/**
 * A provider turns unlocal resources into real cloud infrastructure.
 * Every method must be idempotent: apply may retry after a partial failure.
 */
export interface Provider {
  readonly name: string;
  /** Why this provider can't handle `spec` yet, or undefined if it can. Checked before any change. */
  unsupported?(spec: ResourceSpec): string | undefined;
  /** Verify credentials before any change; throw CLOUD_AUTH if they don't work. */
  preflight?(ctx: ProviderContext): Promise<void>;
  create(ctx: ProviderContext, name: string, spec: ResourceSpec): Promise<Outputs>;
  update(ctx: ProviderContext, name: string, before: ResourceSpec, after: ResourceSpec, outputs: Outputs): Promise<Outputs>;
  delete(ctx: ProviderContext, name: string, spec: ResourceSpec, outputs: Outputs): Promise<void>;
}
