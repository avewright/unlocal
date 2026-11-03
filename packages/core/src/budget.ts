import { round2 } from "./pricing.ts";
import type { BudgetConfig } from "./types.ts";

export interface BudgetStatus {
  limitUsd: number;
  projectedUsd: number;
  headroomUsd: number;
  percentUsed: number;
  /** False means apply will be refused. */
  withinBudget: boolean;
  /** Projected spend has crossed `alertAtPercent`. */
  alert: boolean;
}

export function checkBudget(projectedUsd: number, budget: BudgetConfig): BudgetStatus {
  const percentUsed = budget.monthlyUsd > 0 ? Math.round((projectedUsd / budget.monthlyUsd) * 1000) / 10 : Infinity;
  return {
    limitUsd: budget.monthlyUsd,
    projectedUsd: round2(projectedUsd),
    headroomUsd: round2(budget.monthlyUsd - projectedUsd),
    percentUsed,
    withinBudget: projectedUsd <= budget.monthlyUsd,
    alert: percentUsed >= budget.alertAtPercent,
  };
}
