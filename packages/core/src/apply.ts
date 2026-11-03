import { UnlocalError } from "./errors.ts";
import type { PlanAction, Plan } from "./planner.ts";
import type { Provider, ProviderContext } from "./providers/provider.ts";
import type { ProjectState, ResourceState } from "./state.ts";

export interface ApplyEvent {
  phase: "start" | "done" | "failed";
  action: PlanAction;
  error?: string;
}

export interface GuardOptions {
  /** Required when the plan deletes or replaces a database. */
  allowDataLoss?: boolean;
  /** Real-money applies: an account-wide cap must be set and respected. */
  enforceCap?: boolean;
}

export interface ApplyOptions extends GuardOptions {
  provider: Provider;
  /** Project directory; providers resolve site paths against it. */
  dir: string;
  /** Called after every completed action so progress survives a crash. */
  persist: (state: ProjectState) => Promise<void>;
  onEvent?: (event: ApplyEvent) => void;
  /** Progress from slow provider operations. */
  log?: (message: string) => void;
  now?: () => Date;
}

export interface ApplyResult {
  state: ProjectState;
  applied: PlanAction[];
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Guardrails every apply passes through, whoever is calling.
 * Kept separate so callers can check them before doing anything else.
 */
export function assertApplicable(plan: Plan, state: ProjectState, options: GuardOptions = {}): void {
  if (plan.stateSerial !== state.serial) {
    throw new UnlocalError("PLAN_STALE", "infrastructure changed since this plan was made", {
      hint: "run `unlocal plan` again and review the new plan",
    });
  }
  if (!plan.budget.withinBudget) {
    throw new UnlocalError(
      "BUDGET_EXCEEDED",
      `projected ${usd(plan.budget.projectedUsd)}/mo exceeds the ${usd(plan.budget.limitUsd)}/mo budget`,
      { details: plan.budget, hint: "shrink the resources, or have a human raise budget.monthlyUsd in unlocal.json" },
    );
  }
  if (options.enforceCap) {
    if (!plan.cap) {
      throw new UnlocalError("CAP_NOT_SET", "real deploys need an account-wide spending cap first", {
        hint: "a human sets it once with `unlocal cap <usd>`, the most all projects together may cost per month",
      });
    }
    if (!plan.cap.withinCap) {
      throw new UnlocalError(
        "CAP_EXCEEDED",
        `all projects would cost ${usd(plan.cap.projectedUsd)}/mo, over the ${usd(plan.cap.limitUsd)}/mo cap`,
        { details: plan.cap, hint: "shrink resources, or a human raises it with `unlocal cap <usd>`" },
      );
    }
    if (!plan.cap.funded) {
      throw new UnlocalError(
        "FUNDS_INSUFFICIENT",
        `balance ${usd(plan.cap.balanceUsd)} doesn't cover a month of ${usd(plan.cap.projectedUsd)}`,
        { details: plan.cap, hint: "a human adds funds in the console (`unlocal console`)" },
      );
    }
  }
  if (plan.destructive && !options.allowDataLoss) {
    const names = plan.actions.filter((a) => a.destructive).map((a) => a.name);
    throw new UnlocalError("DESTRUCTIVE_CHANGE", `this plan would permanently delete data in: ${names.join(", ")}`, {
      details: { resources: names },
      hint: "confirm with a human, then re-run with --allow-data-loss",
    });
  }
}

export async function applyPlan(plan: Plan, state: ProjectState, options: ApplyOptions): Promise<ApplyResult> {
  assertApplicable(plan, state, options);
  const { provider, persist, onEvent } = options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const ctxFor = (where: PlanAction["to"]): ProviderContext => ({
    project: plan.project,
    cloud: where?.cloud ?? plan.cloud,
    region: where?.region ?? plan.region,
    dir: options.dir,
    log: options.log ?? (() => {}),
  });

  // Refuse up front, before touching anything, if the provider can't do every step.
  const pending = plan.actions.filter((a) => a.kind !== "noop");
  for (const action of pending) {
    const spec = action.after ?? action.before!;
    const reason = provider.unsupported?.(spec);
    if (reason) {
      throw new UnlocalError("PROVIDER_UNAVAILABLE", `${action.name}: ${reason}`, {
        details: { resource: action.name },
        hint: "change or remove that resource, or add --sim to simulate",
      });
    }
  }
  if (pending.length > 0) await provider.preflight?.(ctxFor(null));

  const next: ProjectState = structuredClone(state);
  next.serial = state.serial + 1;
  const applied: PlanAction[] = [];

  const create = async (action: PlanAction, createdAt: string): Promise<ResourceState> => {
    const outputs = await provider.create(ctxFor(action.to), action.name, action.after!);
    return {
      type: action.type, cloud: action.to!.cloud, region: action.to!.region, spec: action.after!, outputs,
      monthlyUsd: action.monthlyUsdAfter, fingerprint: action.fingerprint, createdAt, updatedAt: now(),
    };
  };

  for (const action of pending) {
    onEvent?.({ phase: "start", action });
    try {
      const existing = next.resources[action.name];
      switch (action.kind) {
        case "create":
          next.resources[action.name] = await create(action, now());
          break;
        case "update": {
          const outputs = await provider.update(
            ctxFor(action.to), action.name, existing!.spec, action.after!, existing!.outputs,
          );
          next.resources[action.name] = {
            ...existing!, spec: action.after!, outputs, monthlyUsd: action.monthlyUsdAfter,
            fingerprint: action.fingerprint, updatedAt: now(),
          };
          break;
        }
        case "replace":
          await provider.delete(ctxFor(action.from), action.name, existing!.spec, existing!.outputs);
          delete next.resources[action.name];
          next.resources[action.name] = await create(action, now());
          break;
        case "delete":
          await provider.delete(ctxFor(action.from), action.name, existing!.spec, existing!.outputs);
          delete next.resources[action.name];
          break;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      onEvent?.({ phase: "failed", action, error: message });
      await persist(next);
      if (cause instanceof UnlocalError && cause.code === "CLOUD_AUTH") throw cause;
      throw new UnlocalError("APPLY_FAILED", `${action.kind} of "${action.name}" failed: ${message}`, {
        cause,
        details: { failed: action.name, applied: applied.map((a) => a.name) },
        hint: "completed changes were saved; run `unlocal plan` to see what remains",
      });
    }
    applied.push(action);
    await persist(next);
    onEvent?.({ phase: "done", action });
  }

  if (applied.length === 0) await persist(next);
  return { state: next, applied };
}
