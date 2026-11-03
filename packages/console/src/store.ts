import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { UnlocalError, accountHome } from "@unlocal/core";

/**
 * Console users, sessions and the projects shown in the console.
 * Lives next to account.json (~/.unlocal/console.json, mode 0600).
 * Passwords are scrypt-hashed; session tokens are stored only as SHA-256 hashes.
 */

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface User {
  id: string;
  email: string;
  /** `scrypt$<salt b64>$<hash b64>` */
  password: string;
  createdAt: string;
}

interface Session {
  tokenHash: string;
  userId: string;
  expiresAt: string;
}

export interface ConsoleData {
  version: 1;
  users: User[];
  sessions: Session[];
  /** Absolute project directories added in the console. */
  projects: string[];
}

export const SESSION_DAYS = 7;
export const MIN_PASSWORD = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const file = (env: NodeJS.ProcessEnv) => path.join(accountHome(env), "console.json");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function loadData(env: NodeJS.ProcessEnv): Promise<ConsoleData> {
  try {
    return JSON.parse(await readFile(file(env), "utf8")) as ConsoleData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, users: [], sessions: [], projects: [] };
    throw new UnlocalError("STATE_CORRUPT", `${file(env)} is unreadable`, { cause: err });
  }
}

export async function saveData(env: NodeJS.ProcessEnv, data: ConsoleData): Promise<void> {
  const f = file(env);
  await mkdir(path.dirname(f), { recursive: true });
  const now = Date.now();
  data.sessions = data.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  const tmp = `${f}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, f);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function checkCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== "string" || !EMAIL.test(email.trim())) throw new UnlocalError("USAGE", "enter a valid email");
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new UnlocalError("USAGE", `password must be at least ${MIN_PASSWORD} characters`);
  }
  return { email: email.trim().toLowerCase(), password };
}

export async function createUser(data: ConsoleData, email: string, password: string): Promise<User> {
  const user: User = { id: `usr_${randomBytes(8).toString("hex")}`, email, password: await hashPassword(password), createdAt: new Date().toISOString() };
  data.users.push(user);
  return user;
}

const failures = new Map<string, { count: number; until: number }>();

export async function authenticate(data: ConsoleData, email: string, password: string): Promise<User> {
  const lock = failures.get(email);
  if (lock && lock.until > Date.now()) {
    throw new UnlocalError("UNAUTHENTICATED", "too many attempts; try again in a minute");
  }
  const user = data.users.find((u) => u.email === email);
  // Hash even for unknown emails so response time doesn't reveal which accounts exist.
  const ok = await verifyPassword(password, user?.password ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
  if (!user || !ok) {
    const count = (lock?.count ?? 0) + 1;
    failures.set(email, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    throw new UnlocalError("UNAUTHENTICATED", "wrong email or password");
  }
  failures.delete(email);
  return user;
}

export function startSession(data: ConsoleData, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  data.sessions.push({
    tokenHash: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
  });
  return token;
}

export function userForToken(data: ConsoleData, token: string | undefined): User | undefined {
  if (!token) return undefined;
  const hash = sha256(token);
  const session = data.sessions.find((s) => s.tokenHash === hash && Date.parse(s.expiresAt) > Date.now());
  return session && data.users.find((u) => u.id === session.userId);
}

export function endSession(data: ConsoleData, token: string | undefined): void {
  if (!token) return;
  const hash = sha256(token);
  data.sessions = data.sessions.filter((s) => s.tokenHash !== hash);
}
