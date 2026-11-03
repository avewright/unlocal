import { readFile } from "node:fs/promises";
import path from "node:path";
import { UnlocalError } from "./errors.ts";
import type { ProjectConfig } from "./types.ts";
import { parseConfig } from "./validate.ts";

export const CONFIG_FILE = "unlocal.json";

export async function loadConfig(dir: string): Promise<ProjectConfig> {
  const file = path.join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UnlocalError("CONFIG_NOT_FOUND", `no ${CONFIG_FILE} in ${path.resolve(dir)}`, {
        hint: "run `unlocal init` to create one, or pass --dir <path>",
      });
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new UnlocalError("CONFIG_INVALID", `${CONFIG_FILE} is not valid JSON: ${(cause as Error).message}`, {
      cause,
    });
  }
  return parseConfig(raw);
}
