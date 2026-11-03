import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  CLOUDS,
  CLOUDS_INFO,
  CONFIG_FILE,
  EXIT_CODES,
  MAX_CAP_USD,
  NAME_PATTERN,
  UnlocalError,
  VERSION,
  checkBudget,
  createPlan,
  estimateResource,
  liveSpendUsd,
  openProject,
  planProject,
  runPlan,
  loadConfig,
  loadAccount,
  parseConfig,
  round2,
  saveAccount,
  type ApplyEvent,
  type Cloud,
  type CostEstimate,
  type Plan,
  type ProjectConfig,
} from "@unlocal/core";
import { startConsole } from "@unlocal/console";
import { renderCost, renderPlan, renderStatus, usd } from "./render.ts";

/**
 * The unlocal CLI. Contract for agents:
 *  - never prompts; anything that needs consent fails with a code and a hint
 *  - `--json` (or UNLOCAL_OUTPUT=json) prints exactly one JSON document to stdout:
 *      { ok: true, command, data }  or  { ok: false, command, error: { code, message, hint, details } }
 *  - exit codes are stable (see EXIT_CODES)
 */

const OPTIONS = {
  json: { type: "boolean", default: false },
  dir: { type: "string", default: "." },
  sim: { type: "boolean", default: false },
  cloud: { type: "string" },
  yes: { type: "boolean", short: "y", default: false },
  "allow-data-loss": { type: "boolean", default: false },
  out: { type: "string" },
  plan: { type: "string" },
  project: { type: "string" },
  budget: { type: "string" },
  port: { type: "string" },
  login: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

interface Flags {
  json: boolean;
  dir: string;
  sim: boolean;
  cloud?: string;
  yes: boolean;
  "allow-data-loss": boolean;
  out?: string;
  plan?: string;
  project?: string;
  budget?: string;
  port?: string;
  login: boolean;
}

interface Ctx {
  flags: Flags;
  dir: string;
  /** Positional arguments after the command name. */
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Progress lines for humans. Silent in JSON mode so stdout stays parseable. */
  progress: (line: string) => void;
}

interface Result {
  data: unknown;
  human: string;
  exitCode?: number;
}

interface Command {
  summary: string;
  /** Positional usage, e.g. "[usd]"; commands without it take no arguments. */
  args?: string;
  flags: string[];
  run: (ctx: Ctx) => Promise<Result>;
}

const PLAN_FORMAT = "unlocal-plan/v1";

function progress(ctx: Ctx) {
  return (e: ApplyEvent) => {
    const what = `${e.action.kind} ${e.action.name} (${e.action.type})`;
    if (e.phase === "done") ctx.progress(`  ✓ ${what}`);
    if (e.phase === "failed") ctx.progress(`  ✗ ${what}: ${e.error}`);
  };
}

function defaultProjectName(dir: string): string {
  const base = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 32);
  return NAME_PATTERN.test(base) ? base : "my-app";
}

function costEstimates(config: ProjectConfig) {
  const estimates: Record<string, CostEstimate> = {};
  for (const [name, spec] of Object.entries(config.resources)) estimates[name] = estimateResource(spec, config.cloud, config.region);
  const total = round2(Object.values(estimates).reduce((s, e) => s + e.monthlyUsd, 0));
  return { estimates, total, budget: checkBudget(total, config.budget) };
}

const COMMANDS: Record<string, Command> = {
  init: {
    summary: "Create unlocal.json with a starter static site",
    flags: ["--project <name>", "--budget <usd>", `--cloud <${CLOUDS.join("|")}>`],
    async run(ctx) {
      const file = path.join(ctx.dir, CONFIG_FILE);
      if (existsSync(file)) {
        throw new UnlocalError("CONFIG_EXISTS", `${file} already exists`, { hint: "edit it directly instead" });
      }
      const budget = ctx.flags.budget === undefined ? 25 : Number(ctx.flags.budget);
      const cloud = (ctx.flags.cloud ?? "aws") as Cloud;
      const raw = {
        project: ctx.flags.project ?? defaultProjectName(ctx.dir),
        cloud,
        region: CLOUDS_INFO[cloud]?.defaultRegion,
        budget: { monthlyUsd: budget },
        resources: { web: { type: "site", path: "./public" } },
      };
      const config = parseConfig(raw); // refuse to write a config we would later reject
      await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
      const site = path.join(ctx.dir, "public");
      if (!existsSync(site)) {
        await mkdir(site);
        await writeFile(path.join(site, "index.html"), `<!doctype html>\n<title>${config.project}</title>\n<h1>${config.project}</h1>\n`);
      }
      return {
        data: { file, config },
        human: `Created ${file} for "${config.project}" on ${CLOUDS_INFO[config.cloud].name} with a $${budget}/mo budget.\nNext: unlocal plan`,
      };
    },
  },

  validate: {
    summary: "Check unlocal.json and print the normalized config",
    flags: [],
    async run(ctx) {
      const config = await loadConfig(ctx.dir);
      const n = Object.keys(config.resources).length;
      return { data: { config }, human: `unlocal.json is valid: project "${config.project}", ${n} resource${n === 1 ? "" : "s"}.` };
    },
  },

  cost: {
    summary: "Estimate monthly cost of everything in unlocal.json",
    flags: [],
    async run(ctx) {
      const config = await loadConfig(ctx.dir);
      const { estimates, total, budget } = costEstimates(config);
      return { data: { estimates, totalMonthlyUsd: total, budget }, human: renderCost(estimates, total, budget) };
    },
  },

  plan: {
    summary: "Show what apply would change and what it would cost",
    flags: ["--out <file>  save the plan so `apply --plan` applies exactly it"],
    async run(ctx) {
      const plan = await planProject(await openProject(ctx.dir, ctx.env));
      let human = renderPlan(plan);
      if (ctx.flags.out) {
        await writeFile(ctx.flags.out, `${JSON.stringify({ format: PLAN_FORMAT, plan }, null, 2)}\n`);
        human += `\n\nSaved to ${ctx.flags.out}. Apply it with: unlocal apply --plan ${ctx.flags.out}`;
      } else if (plan.hasChanges && !plan.budget.withinBudget) {
        human += "\n\nReduce resources or raise budget.monthlyUsd before applying.";
      } else if (plan.hasChanges && plan.cap && !plan.cap.withinCap) {
        human += "\n\nReduce resources or raise the account cap before applying.";
      } else if (plan.hasChanges) {
        human += `\n\nApply with: unlocal apply --yes${plan.destructive ? " --allow-data-loss" : ""}`;
      }
      return { data: { plan, savedTo: ctx.flags.out ?? null }, human };
    },
  },

  apply: {
    summary: "Make infrastructure match unlocal.json",
    flags: ["--yes  approve the current plan", "--plan <file>  apply a saved plan (refused if anything changed)", "--allow-data-loss"],
    async run(ctx) {
      const project = await openProject(ctx.dir, ctx.env);
      const { config, state } = project;
      const plan = await planProject(project);

      if (ctx.flags.plan) {
        let saved: { format?: string; plan?: Plan };
        try {
          saved = JSON.parse(await readFile(ctx.flags.plan, "utf8"));
        } catch (cause) {
          throw new UnlocalError("PLAN_INVALID", `could not read plan file ${ctx.flags.plan}`, { cause });
        }
        if (saved.format !== PLAN_FORMAT || typeof saved.plan?.id !== "string") {
          throw new UnlocalError("PLAN_INVALID", `${ctx.flags.plan} is not an unlocal plan file`);
        }
        if (saved.plan.id !== plan.id) {
          throw new UnlocalError("PLAN_STALE", "unlocal.json or infrastructure changed since this plan was saved", {
            details: { savedPlanId: saved.plan.id, currentPlanId: plan.id },
            hint: "run `unlocal plan --out <file>` again and review it",
          });
        }
      } else if (plan.hasChanges && !ctx.flags.yes) {
        throw new UnlocalError("APPROVAL_REQUIRED", "apply changes infrastructure and needs explicit approval", {
          details: { plan },
          hint: "review `unlocal plan`, then re-run with --yes (or save it with --out and use --plan <file>)",
        });
      }

      if (!plan.hasChanges) {
        return { data: { applied: [], plan, state }, human: "No changes. Infrastructure matches unlocal.json." };
      }

      const result = await runPlan(project, plan, {
        sim: ctx.flags.sim,
        allowDataLoss: ctx.flags["allow-data-loss"],
        onEvent: progress(ctx),
        log: (m) => ctx.progress(`    ${m}`),
      });

      const urls = Object.entries(result.state.resources)
        .filter(([, r]) => r.outputs.url)
        .map(([name, r]) => `  ${name}: ${r.outputs.url}`);
      return {
        data: { applied: result.applied.map((a) => ({ kind: a.kind, name: a.name })), plan, state: result.state },
        human: [
          ...(urls.length ? ["", ...urls] : []),
          "",
          `  ${usd(plan.cost.projectedMonthlyUsd)}/mo of ${usd(plan.budget.limitUsd)}/mo budget`,
          ...(plan.cap && !ctx.flags.sim ? [`  ${usd(plan.cap.projectedUsd)}/mo of ${usd(plan.cap.limitUsd)}/mo account cap`] : []),
        ].join("\n"),
      };
    },
  },

  status: {
    summary: "Show deployed resources, their URLs and cost",
    flags: [],
    async run(ctx) {
      const project = await openProject(ctx.dir, ctx.env);
      const { config, state } = project;
      const plan = await planProject(project);
      const pending = plan.actions.filter((a) => a.kind !== "noop").length;
      const current = round2(Object.values(state.resources).reduce((s, r) => s + r.monthlyUsd, 0));
      const budget = checkBudget(current, config.budget);
      return {
        data: { project: state.project, serial: state.serial, resources: state.resources, monthlyUsd: current, budget, pendingChanges: pending },
        human: renderStatus(state, pending, budget),
      };
    },
  },

  destroy: {
    summary: "Delete every resource in the project",
    flags: ["--yes", "--allow-data-loss  required if a database exists"],
    async run(ctx) {
      const project = await openProject(ctx.dir, ctx.env);
      const { config, state } = project;
      const plan = await planProject(project, { ...config, resources: {} });
      if (!plan.hasChanges) return { data: { applied: [] }, human: "Nothing to destroy." };
      if (!ctx.flags.yes) {
        throw new UnlocalError("APPROVAL_REQUIRED", `destroy would delete ${plan.summary.delete} resource(s)`, {
          details: { plan },
          hint: "re-run with --yes to confirm",
        });
      }
      // Destroying only lowers spend, so the cap never blocks it.
      const result = await runPlan(project, plan, {
        sim: ctx.flags.sim,
        allowDataLoss: ctx.flags["allow-data-loss"],
        enforceCap: false,
        onEvent: progress(ctx),
        log: (m) => ctx.progress(`    ${m}`),
      });
      return {
        data: { applied: result.applied.map((a) => ({ kind: a.kind, name: a.name })), state: result.state },
        human: `Destroyed ${result.applied.length} resource(s). unlocal.json is unchanged; \`unlocal apply --yes\` recreates them.`,
      };
    },
  },

  console: {
    summary: "Open the console: add funds, set the cap, deploy",
    flags: ["--port <n>  default 4400", "--login  require an account and password"],
    async run(ctx) {
      const port = ctx.flags.port ? Number(ctx.flags.port) : undefined;
      const server = await startConsole({ env: ctx.env, port, login: ctx.flags.login });
      // The server keeps the process alive; Ctrl-C stops it.
      return { data: { url: server.url }, human: `Console running at ${server.url}  (Ctrl-C to stop)` };
    },
  },

  cap: {
    summary: "Show or set the account-wide monthly spending cap (humans only)",
    args: "[usd]",
    flags: [],
    async run(ctx) {
      const account = await loadAccount(ctx.env);
      if (ctx.args[0] !== undefined) {
        const value = Number(ctx.args[0]);
        if (!Number.isFinite(value) || value <= 0 || value > MAX_CAP_USD) {
          throw new UnlocalError("USAGE", `cap must be a number between 0 and ${MAX_CAP_USD}`, { hint: "e.g. `unlocal cap 10`" });
        }
        account.monthlyCapUsd = value;
        await saveAccount(account, ctx.env);
      }
      const committed = liveSpendUsd(account);
      const projects = Object.entries(account.projects)
        .map(([dir, e]) => ({ dir, ...e }))
        .sort((a, b) => b.monthlyUsd - a.monthlyUsd);
      const data = {
        monthlyCapUsd: account.monthlyCapUsd,
        liveMonthlyUsd: committed,
        headroomUsd: account.monthlyCapUsd === null ? null : round2(account.monthlyCapUsd - committed),
        projects,
      };
      const lines = [account.monthlyCapUsd === null ? "No cap set. Real deploys are refused until one is: unlocal cap <usd>" : `Cap ${usd(account.monthlyCapUsd)}/mo`];
      if (projects.length) {
        lines.push("");
        const w = Math.max(...projects.map((p) => p.project.length));
        for (const p of projects) lines.push(`  ${p.project.padEnd(w)}  ${(p.live ? p.cloud : "sim").padEnd(5)}  ${usd(p.monthlyUsd).padStart(7)}/mo`);
      }
      if (account.monthlyCapUsd !== null) lines.push("", `  ${usd(committed)}/mo live · ${usd(data.headroomUsd!)} left`);
      return { data, human: lines.join("\n") };
    },
  },
};

const GLOBAL_FLAGS = ["--json", "--dir <path>", "--sim  deploy to a simulated cloud"];

function helpData() {
  return {
    version: VERSION,
    usage: "unlocal <command> [flags]",
    commands: Object.entries(COMMANDS).map(([name, c]) => ({ name, args: c.args ?? null, summary: c.summary, flags: c.flags })),
    globalFlags: GLOBAL_FLAGS,
    exitCodes: EXIT_CODES,
  };
}

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  return [
    `unlocal ${VERSION}`,
    "",
    "Usage: unlocal <command> [flags]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(width)}  ${c.summary}`),
    "",
    `Global flags: ${GLOBAL_FLAGS.join("  ")}`,
    "Agents: always pass --json and branch on error.code / exit status.",
  ].join("\n");
}

export async function run(
  argv: string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => process.stdout.write(s + "\n"),
    stderr: (s) => process.stderr.write(s + "\n"),
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let json = argv.includes("--json") || env.UNLOCAL_OUTPUT === "json";
  let command = "help";

  const fail = (err: UnlocalError): number => {
    if (json) io.stdout(JSON.stringify({ ok: false, command, error: err.toJSON() }, null, 2));
    else {
      io.stderr(`error [${err.code}]: ${err.message}`);
      if (Array.isArray(err.details) && err.code === "CONFIG_INVALID") {
        for (const d of err.details as { path: string; message: string }[]) io.stderr(`  - ${d.path}: ${d.message}`);
      }
      if (err.hint) io.stderr(`hint: ${err.hint}`);
    }
    return err.exitCode;
  };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    return fail(new UnlocalError("USAGE", (err as Error).message, { hint: "run `unlocal help`" }));
  }
  const { values, positionals } = parsed;
  json = values.json || json;
  command = positionals[0] ?? "help";

  if (values.version) {
    io.stdout(json ? JSON.stringify({ ok: true, command: "version", data: { version: VERSION } }) : VERSION);
    return 0;
  }
  if (command === "help" || values.help) {
    io.stdout(json ? JSON.stringify({ ok: true, command: "help", data: helpData() }, null, 2) : helpText());
    return 0;
  }
  const cmd = COMMANDS[command];
  if (!cmd) return fail(new UnlocalError("USAGE", `unknown command "${command}"`, { hint: "run `unlocal help`" }));
  const maxArgs = cmd.args ? cmd.args.split(" ").length : 0;
  if (positionals.length - 1 > maxArgs) {
    return fail(new UnlocalError("USAGE", `unexpected argument "${positionals[1 + maxArgs]}"`, { hint: "run `unlocal help`" }));
  }

  const ctx: Ctx = {
    flags: values as Flags,
    dir: values.dir,
    args: positionals.slice(1),
    env,
    progress: json ? () => {} : io.stderr,
  };
  try {
    const result = await cmd.run(ctx);
    io.stdout(json ? JSON.stringify({ ok: true, command, data: result.data }, null, 2) : result.human);
    return result.exitCode ?? 0;
  } catch (err) {
    if (err instanceof UnlocalError) return fail(err);
    return fail(new UnlocalError("INTERNAL", (err as Error)?.message ?? String(err), { hint: "this is a bug in unlocal" }));
  }
}
