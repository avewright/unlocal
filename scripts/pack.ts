/**
 * Build the publishable `unlocal` npm package in build/npm.
 *
 * Node won't strip TypeScript types inside node_modules, so the published package is
 * compiled JavaScript: core, CLI and console in one package, with the workspace
 * `@unlocal/*` imports pointed at the compiled files.
 *
 *   node scripts/pack.ts            # build/npm, ready for `npm pack` or `npm publish`
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "build/npm");
const lib = path.join(out, "lib");
const read = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.npm.json")], { stdio: "inherit" });

// Workspace package names → the compiled entry points, relative to each file.
const entries: Record<string, string> = {
  "@unlocal/core": path.join(lib, "core/src/index.js"),
  "@unlocal/console": path.join(lib, "console/src/server.js"),
};
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));
for (const file of walk(lib).filter((f) => f.endsWith(".js"))) {
  let text = readFileSync(file, "utf8");
  for (const [name, target] of Object.entries(entries)) {
    let rel = path.relative(path.dirname(file), target).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    text = text.replaceAll(`from "${name}"`, `from "${rel}"`);
  }
  if (/from "@unlocal\//.test(text)) throw new Error(`${file} still imports a workspace package`);
  writeFileSync(file, text);
}

cpSync(path.join(root, "packages/console/public"), path.join(lib, "console/public"), { recursive: true });

mkdirSync(path.join(out, "bin"));
const bin = readFileSync(path.join(root, "packages/cli/bin/unlocal.js"), "utf8").replace('"../src/main.ts"', '"../lib/cli/src/main.js"');
if (!bin.includes("../lib/cli/src/main.js")) throw new Error("bin/unlocal.js no longer imports ../src/main.ts");
writeFileSync(path.join(out, "bin/unlocal.js"), bin, { mode: 0o755 });

cpSync(path.join(root, "README.md"), path.join(out, "README.md"));
const core = read("packages/core/package.json");
const { VERSION } = await import(path.join(root, "packages/core/src/index.ts"));
writeFileSync(path.join(out, "package.json"), `${JSON.stringify({
  name: "unlocal",
  version: VERSION,
  description: "Deploy from your agent with a hard spending cap. Localhost to a live link in one command.",
  type: "module",
  bin: { unlocal: "./bin/unlocal.js" },
  files: ["bin", "lib", "README.md"],
  engines: { node: ">=22" },
  dependencies: core.dependencies,
  repository: { type: "git", url: "git+https://github.com/avewright/unlocal.git" },
  keywords: ["deploy", "agents", "mcp", "cloudflare", "budget"],
}, null, 2)}\n`);
console.log(`built ${path.relative(root, out)} (unlocal ${VERSION})`);
