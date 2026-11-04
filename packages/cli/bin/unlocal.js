#!/usr/bin/env node
import { run } from "../src/main.ts";

// A reader that stops early (`unlocal plan | head`) closes the pipe; that's not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw err;
  });
}

process.exitCode = await run(process.argv.slice(2));
