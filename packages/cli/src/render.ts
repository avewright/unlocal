import { CLOUDS_INFO, type ActionKind, type BudgetStatus, type CostEstimate, type Plan, type ProjectState } from "@unlocal/core";

export const usd = (n: number) => `$${n.toFixed(2)}`;

const SYMBOL: Record<ActionKind, string> = { create: "+", update: "~", replace: "±", delete: "-", noop: " " };

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) => "  " + r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd()).join("\n");
}

export function renderBudget(b: BudgetStatus): string {
  const flag = !b.withinBudget ? "  ✗ OVER BUDGET — apply will be refused" : b.alert ? "  ! nearing budget" : "";
  return `budget ${usd(b.limitUsd)}/mo (${b.percentUsed}% used)${flag}`;
}

export function renderPlan(plan: Plan): string {
  const lines = [`Plan ${plan.id} for ${plan.project} (${CLOUDS_INFO[plan.cloud].name} ${plan.region})`, ""];
  if (!plan.hasChanges) {
    lines.push("  No changes. Infrastructure matches unlocal.json.");
  } else {
    const rows = plan.actions
      .filter((a) => a.kind !== "noop")
      .map((a) => {
        const cost =
          a.kind === "create" ? `+${usd(a.monthlyUsdAfter)}/mo`
          : a.kind === "delete" ? `-${usd(a.monthlyUsdBefore)}/mo`
          : `${usd(a.monthlyUsdBefore)} → ${usd(a.monthlyUsdAfter)}/mo`;
        const note = [a.reason, a.changes.length ? `changes: ${a.changes.join(", ")}` : "", a.destructive ? "DELETES DATA" : ""]
          .filter(Boolean)
          .join("; ");
        return [SYMBOL[a.kind], a.kind, a.name, a.type, cost, note];
      });
    lines.push(table(rows));
  }
  const { currentMonthlyUsd: cur, projectedMonthlyUsd: next, deltaMonthlyUsd: delta } = plan.cost;
  lines.push(
    "",
    `  Estimated monthly: ${usd(cur)} → ${usd(next)} (${delta >= 0 ? "+" : "-"}${usd(Math.abs(delta))})`,
    `  ${renderBudget(plan.budget)}`,
  );
  if (plan.cap) {
    const over = plan.cap.withinCap ? "" : "  ✗ OVER ACCOUNT CAP — live apply will be refused";
    lines.push(`  account cap ${usd(plan.cap.limitUsd)}/mo (${usd(plan.cap.projectedUsd)} with this plan)${over}`);
  }
  return lines.join("\n");
}

export function renderStatus(state: ProjectState, pending: number, budget: BudgetStatus | null): string {
  const names = Object.keys(state.resources).sort();
  const lines = [`${state.project} — ${names.length} resource${names.length === 1 ? "" : "s"} (state serial ${state.serial})`, ""];
  if (names.length === 0) lines.push("  Nothing deployed yet. Run `unlocal plan` then `unlocal apply --yes`.");
  for (const name of names) {
    const r = state.resources[name]!;
    lines.push(`  ${name}  ${r.type}  ${r.cloud} ${r.region}  ${usd(r.monthlyUsd)}/mo`);
    for (const [k, v] of Object.entries(r.outputs)) lines.push(`      ${k}: ${v}`);
  }
  const total = Object.values(state.resources).reduce((s, r) => s + r.monthlyUsd, 0);
  lines.push("", `  Estimated monthly: ${usd(total)}`);
  if (budget) lines.push(`  ${renderBudget(budget)}`);
  if (pending > 0) lines.push(`  ${pending} pending change${pending === 1 ? "" : "s"} — run \`unlocal plan\``);
  return lines.join("\n");
}

export function renderCost(estimates: Record<string, CostEstimate>, total: number, budget: BudgetStatus): string {
  const lines: string[] = [];
  for (const [name, est] of Object.entries(estimates)) {
    lines.push(`${name}  ${usd(est.monthlyUsd)}/mo`);
    lines.push(table(est.lineItems.map((i) => [`  ${i.description}`, usd(i.monthlyUsd)])));
  }
  if (lines.length === 0) lines.push("No resources defined.");
  lines.push("", `Total: ${usd(total)}/mo — ${renderBudget(budget)}`, "(estimates from list prices; actual usage-based charges may differ)");
  return lines.join("\n");
}
