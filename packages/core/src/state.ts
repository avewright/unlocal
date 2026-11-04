import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnlocalError } from "./errors.ts";
import type { Cloud } from "./clouds.ts";
import type { Region, ResourceSpec, ResourceType } from "./types.ts";

/**
 * What unlocal believes exists. In local/dev mode this lives in
 * `.unlocal/state.json`; the hosted control plane will own it later.
 */

export type Outputs = Record<string, string>;

export interface ResourceState {
  type: ResourceType;
  cloud: Cloud;
  region: Region;
  spec: ResourceSpec;
  /** Provider-reported facts: URLs, hostnames, secret references. Never plaintext secrets. */
  outputs: Outputs;
  monthlyUsd: number;
  /** Content hash of a site's files when last deployed. */
  fingerprint?: string;
  /** When the guard or kill switch took it offline without deleting it. The next apply resumes it. */
  paused?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectState {
  version: 1;
  project: string;
  /** Incremented on every apply; plans are pinned to a serial so stale plans are rejected. */
  serial: number;
  resources: Record<string, ResourceState>;
}

export const STATE_DIR = ".unlocal";
export const STATE_FILE = "state.json";

export const statePath = (dir: string) => path.join(dir, STATE_DIR, STATE_FILE);

export function emptyState(project: string): ProjectState {
  return { version: 1, project, serial: 0, resources: {} };
}

export async function loadState(dir: string, project: string): Promise<ProjectState> {
  const file = statePath(dir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState(project);
    throw err;
  }
  let state: ProjectState;
  try {
    state = JSON.parse(text) as ProjectState;
  } catch (cause) {
    throw new UnlocalError("STATE_CORRUPT", `${file} is not valid JSON`, { cause });
  }
  if (state.version !== 1 || typeof state.serial !== "number" || typeof state.resources !== "object") {
    throw new UnlocalError("STATE_CORRUPT", `${file} has an unrecognized format`);
  }
  if (state.project !== project) {
    throw new UnlocalError(
      "STATE_CORRUPT",
      `state belongs to project "${state.project}" but unlocal.json says "${project}"`,
      { hint: `restore "project": "${state.project}" in unlocal.json; renaming projects is not supported yet` },
    );
  }
  // v0.1 state predates multi-cloud: everything it recorded was on AWS.
  for (const r of Object.values(state.resources)) r.cloud ??= "aws";
  return state;
}

/** Atomic write: a crash mid-save never leaves a half-written state file. */
export async function saveState(dir: string, state: ProjectState): Promise<void> {
  const file = statePath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, file);
}
