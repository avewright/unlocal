#!/usr/bin/env node
import { parseArgs } from "node:util";
import { deployFolder, startControlServer } from "../src/index.ts";

// One binary, two jobs:
//   unlocal-control                  run the hosted API (needs UNLOCAL_CONTROL_ADMIN)
//   unlocal-control remote <dir>     deploy a built folder through it
const [command = "serve", ...rest] = process.argv.slice(2);

const fail = (err) => {
  console.error(`error [${err.code ?? "INTERNAL"}]: ${err.message}`);
  if (err.hint) console.error(`hint: ${err.hint}`);
  process.exitCode = err.exitCode ?? 1;
};

if (command === "remote") {
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        dir: { type: "string" },
        url: { type: "string" },
        token: { type: "string" },
        project: { type: "string" },
        "skip-build": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log("Usage: unlocal-control remote <dir> [--url <controlUrl>] [--token <ul_...>] [--project <name>] [--skip-build] [--json]");
      console.log("Env: UNLOCAL_CONTROL_URL, UNLOCAL_CONTROL_TOKEN");
      process.exit(0);
    }
    const dir = values.dir ?? positionals[0] ?? ".";
    const result = await deployFolder({
      controlUrl: values.url ?? process.env.UNLOCAL_CONTROL_URL ?? "",
      token: values.token ?? process.env.UNLOCAL_CONTROL_TOKEN ?? "",
      dir,
      project: values.project,
      build: !values["skip-build"],
      log: (line) => console.error(line),
    });
    if (values.json) console.log(JSON.stringify({ ok: true, data: result }));
    else console.log(result.url ?? "deployed");
  } catch (err) {
    fail(err);
  }
} else if (command === "serve") {
  const adminToken = process.env.UNLOCAL_CONTROL_ADMIN;
  if (!adminToken) {
    console.error("set UNLOCAL_CONTROL_ADMIN to a long random token");
    process.exit(1);
  }
  try {
    const server = await startControlServer({
      dataDir: process.env.UNLOCAL_CONTROL_DATA ?? ".unlocal-control",
      adminToken,
      secret: process.env.UNLOCAL_CONTROL_SECRET,
      sim: process.env.UNLOCAL_CONTROL_SIM === "1",
      port: Number(process.env.PORT ?? 4401),
    });
    console.log(`unlocal control plane at ${server.url}`);
  } catch (err) {
    fail(err);
  }
} else {
  console.error(`unknown command "${command}"; try \`unlocal-control remote --help\``);
  process.exitCode = 64;
}
