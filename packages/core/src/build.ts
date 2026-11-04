import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { UnlocalError } from "./errors.ts";

/**
 * Building an app before `up` deploys it: the project's own `build` script, run with the
 * package manager its lockfile names. unlocal never guesses a build command; no script,
 * no build.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface Framework {
  name: string;
  /** Where its static build lands, relative to the project. */
  outDir: string;
  /** Said when the build finished but left no index.html there. */
  hint?: string;
}

export interface BuildInfo {
  command: string;
  framework: string | null;
  installed: boolean;
  seconds: number;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Most specific first: a Next.js app often depends on React tooling too. */
const FRAMEWORKS: [dependency: string, framework: Framework][] = [
  ["next", { name: "Next.js", outDir: "out", hint: "set `output: \"export\"` in next.config to build a static site (server features aren't supported yet)" }],
  ["nuxt", { name: "Nuxt", outDir: ".output/public", hint: "use `nuxt generate` as the build script to build a static site" }],
  ["@sveltejs/kit", { name: "SvelteKit", outDir: "build", hint: "use @sveltejs/adapter-static to build a static site" }],
  ["astro", { name: "Astro", outDir: "dist", hint: "keep Astro's default static output (no server adapter)" }],
  ["gatsby", { name: "Gatsby", outDir: "public" }],
  ["@11ty/eleventy", { name: "Eleventy", outDir: "_site" }],
  ["react-scripts", { name: "Create React App", outDir: "build" }],
  ["vite", { name: "Vite", outDir: "dist" }],
];

export function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

export function detectFramework(pkg: PackageJson | null): Framework | null {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return FRAMEWORKS.find(([dep]) => dep in deps)?.[1] ?? null;
}

export function packageManager(dir: string): PackageManager {
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}

const BUILD_TIMEOUT_MS = 10 * 60_000;
const KEEP_LINES = 40;

/** Run a command in `dir`, streaming its lines to `log`; keeps the tail for error reports. */
function run(cmd: string, args: string[], dir: string, log: (line: string) => void): Promise<{ code: number; tail: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const tail: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        log(line);
        tail.push(line);
        if (tail.length > KEEP_LINES) tail.shift();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGTERM"), BUILD_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), tail });
    });
  });
}

/** Install (only when dependencies are declared but not installed) and build. Null if there's no build script. */
export async function buildApp(dir: string, log: (line: string) => void = () => {}): Promise<BuildInfo | null> {
  const pkg = readPackageJson(dir);
  if (!pkg?.scripts?.build) return null;
  const pm = packageManager(dir);
  const started = Date.now();
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  const installed = hasDeps && !existsSync(path.join(dir, "node_modules"));

  const step = async (args: string[]) => {
    const command = `${pm} ${args.join(" ")}`;
    log(`$ ${command}`);
    let result;
    try {
      result = await run(pm, args, dir, log);
    } catch (cause) {
      throw new UnlocalError("BUILD_FAILED", `couldn't run \`${command}\`: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause,
        hint: `install ${pm}, or build the site yourself and run \`unlocal up --skip-build\``,
      });
    }
    if (result.code !== 0) {
      throw new UnlocalError("BUILD_FAILED", `\`${command}\` failed (exit ${result.code})`, {
        details: { command, exitCode: result.code, output: result.tail },
        hint: "fix the error in details.output, then run `unlocal up` again",
      });
    }
    return command;
  };

  if (installed) await step(["install"]);
  const command = await step(["run", "build"]);
  return { command, framework: detectFramework(pkg)?.name ?? null, installed, seconds: Math.round((Date.now() - started) / 100) / 10 };
}
