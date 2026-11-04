import { createInterface } from "node:readline";
import { VERSION } from "@unlocal/core";
import { run } from "./main.ts";

/**
 * MCP server over stdio (newline-delimited JSON-RPC 2.0), no SDK.
 * Every tool runs the matching CLI command with --json, so agents get exactly the
 * CLI's guardrails, error codes and output. There is deliberately no tool to set or
 * raise the cap, or to delete data: those stay with a human.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "unlocal puts sites online under a hard monthly spending cap that only a human can change.",
  "To publish: build the site, then call `up` with the project folder; it returns the public URL.",
  "Every result is the CLI's JSON. On ok:false, branch on error.code and follow error.hint.",
  "CAP_NOT_SET, CAP_EXCEEDED, FUNDS_INSUFFICIENT and CLOUD_AUTH need a human: tell them what the hint says; don't work around it.",
].join("\n");

const dir = { type: "string", description: "Absolute path of the project folder" };

interface Tool {
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  argv: (args: Record<string, unknown>) => string[];
}

const TOOLS: Record<string, Tool> = {
  up: {
    description:
      "Put a built site online and return its public URL. Writes unlocal.json (Cloudflare, $5/mo budget) if the folder has none. " +
      "Deploys only when nothing would be deleted and it fits the project budget and the account cap.",
    properties: { dir },
    required: ["dir"],
    argv: (a) => ["up", "--dir", String(a.dir)],
  },
  plan: {
    description: "Show what would change and its monthly cost, without changing anything. Pass the returned plan.id to `apply`.",
    properties: { dir },
    required: ["dir"],
    argv: (a) => ["plan", "--dir", String(a.dir)],
  },
  apply: {
    description: "Apply exactly the plan you reviewed. Refused with PLAN_STALE if anything changed since `plan`.",
    properties: { dir, plan_id: { type: "string", description: "plan.id from `plan`" } },
    required: ["dir", "plan_id"],
    argv: (a) => ["apply", "--dir", String(a.dir), "--plan-id", String(a.plan_id)],
  },
  status: {
    description: "List the project's live resources, their URLs and monthly cost.",
    properties: { dir },
    required: ["dir"],
    argv: (a) => ["status", "--dir", String(a.dir)],
  },
  cost: {
    description: "Estimate the monthly cost of everything in unlocal.json.",
    properties: { dir },
    required: ["dir"],
    argv: (a) => ["cost", "--dir", String(a.dir)],
  },
  account: {
    description: "Read the account's monthly cap, what each project commits against it, and the headroom left. Read-only.",
    properties: {},
    required: [],
    argv: () => ["cap"],
  },
  destroy: {
    description: "Take the project offline by deleting its resources. Refuses if that would delete a database.",
    properties: { dir, confirm: { type: "boolean", description: "Must be true" } },
    required: ["dir", "confirm"],
    argv: (a) => (a.confirm === true ? ["destroy", "--dir", String(a.dir), "--yes"] : ["destroy", "--dir", String(a.dir)]),
  },
};

export function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: { type: "object", properties: t.properties, required: t.required, additionalProperties: false },
  }));
}

/** Run one tool; the result text is the CLI's single JSON document. */
export async function callTool(name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv, sim: boolean) {
  const tool = TOOLS[name];
  if (!tool) return { content: [{ type: "text", text: `unknown tool "${name}"` }], isError: true };
  const missing = tool.required.filter((k) => args[k] === undefined);
  if (missing.length) return { content: [{ type: "text", text: `missing argument: ${missing.join(", ")}` }], isError: true };
  let out = "";
  const code = await run([...tool.argv(args), "--json", ...(sim ? ["--sim"] : [])], { stdout: (s) => (out += s), stderr: () => {} }, env);
  return { content: [{ type: "text", text: out }], isError: code !== 0 };
}

interface Message {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMessage(msg: Message, env: NodeJS.ProcessEnv, sim: boolean): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(-32600, "invalid request");
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "unlocal", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList() });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      return reply(await callTool(name, args, env, sim));
    }
    default:
      return isNotification ? null : error(-32601, `method not found: ${msg.method}`);
  }
}

export async function serveMcp(options: {
  env: NodeJS.ProcessEnv;
  sim: boolean;
  input?: NodeJS.ReadableStream;
  output?: (line: string) => void;
}): Promise<void> {
  const write = options.output ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  // One request at a time: tools change shared state (the account ledger), so order matters.
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      continue;
    }
    const response = await handleMessage(msg, options.env, options.sim);
    if (response) write(JSON.stringify(response));
  }
}
