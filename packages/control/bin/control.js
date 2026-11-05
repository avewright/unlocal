#!/usr/bin/env node
import { startControlServer } from "../src/index.ts";

// The hosted control plane, for the private beta. HTTPS and a real database come with
// the first server; this binds to localhost and keeps tenants in one JSON file.
const adminToken = process.env.UNLOCAL_CONTROL_ADMIN;
if (!adminToken) {
  console.error("set UNLOCAL_CONTROL_ADMIN to a long random token");
  process.exit(1);
}

const server = await startControlServer({
  dataDir: process.env.UNLOCAL_CONTROL_DATA ?? ".unlocal-control",
  adminToken,
  secret: process.env.UNLOCAL_CONTROL_SECRET,
  sim: process.env.UNLOCAL_CONTROL_SIM === "1",
  port: Number(process.env.PORT ?? 4401),
});
console.log(`unlocal control plane at ${server.url}`);
