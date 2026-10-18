import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

interface ProcessOwner {
  version: 1;
  pid: number;
  host: string;
  token: string;
  launching: boolean;
  children: { pid: number; group: boolean }[];
}

export interface ProcessLock {
  /** Persist uncertainty before spawning: a crash in the registration gap must not release active work. */
  beforeSpawn(): void;
  spawned(pid: number | undefined, group: boolean): void;
  release(): void;
}

const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0;
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Read-only inspection. Unknown hosts, incomplete launches and surviving descendants retain ownership. */
export function inspectProcessLock(directory: string): { pid?: number; abandoned: boolean } {
  try {
    if (!lstatSync(directory).isDirectory()) return { abandoned: false };
    const entries = readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== "owner.json") return { abandoned: false };
    const file = join(directory, "owner.json"),
      stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return { abandoned: false };
    const owner = JSON.parse(readFileSync(file, "utf8")) as Partial<ProcessOwner>;
    if (
      owner.version !== 1 ||
      owner.host !== hostname() ||
      !validPid(owner.pid) ||
      typeof owner.token !== "string" ||
      !owner.token ||
      typeof owner.launching !== "boolean" ||
      !Array.isArray(owner.children) ||
      owner.children.length > 4096 ||
      !owner.children.every(
        (child: unknown) =>
          child &&
          typeof child === "object" &&
          "pid" in child &&
          validPid(child.pid) &&
          "group" in child &&
          typeof child.group === "boolean",
      )
    )
      return { abandoned: false };
    return {
      pid: owner.pid,
      abandoned:
        !owner.launching &&
        gone(owner.pid) &&
        owner.children.every((child) =>
          child.group ? process.platform !== "win32" && gone(-child.pid) : gone(child.pid),
        ),
    };
  } catch {
    return { abandoned: false };
  }
}

/** Caller serializes acquisition/recovery with tool-cache admission; active or uncertain owners are never stolen. */
export function acquireProcessLock(directory: string, tracking = false): ProcessLock | undefined {
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!inspectProcessLock(directory).abandoned) return undefined;
    rmSync(directory, { recursive: true });
    mkdirSync(directory, { mode: 0o700 });
  }
  const identity = lstatSync(directory);
  const path = join(directory, "owner.json");
  const owner: ProcessOwner = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    launching: !tracking,
    children: [],
  };
  let body = JSON.stringify(owner);
  try {
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true });
    throw error;
  }
  const verify = () => {
    const current = lstatSync(directory);
    const entries = readdirSync(directory);
    if (
      !current.isDirectory() ||
      current.ino !== identity.ino ||
      current.dev !== identity.dev ||
      entries.length !== 1 ||
      entries[0] !== "owner.json" ||
      !lstatSync(path).isFile() ||
      readFileSync(path, "utf8") !== body
    )
      throw new Error(`Process lock ownership changed; preserving ${directory}`);
  };
  const save = () => {
    verify();
    const next = join(directory, "owner-next.json");
    const value = JSON.stringify(owner);
    writeFileSync(next, value, { flag: "wx", mode: 0o600 });
    renameSync(next, path);
    body = value;
  };
  return {
    beforeSpawn() {
      if (owner.children.length >= 4096) throw new Error(`Too many owned processes: ${directory}`);
      owner.launching = true;
      save();
    },
    spawned(pid, group) {
      if (pid !== undefined) {
        if (!validPid(pid)) throw new Error("Invalid child process identity");
        owner.children.push({ pid, group });
      }
      owner.launching = false;
      save();
    },
    release() {
      verify();
      if (owner.children.some((child) => !gone(child.group && process.platform !== "win32" ? -child.pid : child.pid)))
        throw new Error(`Owned processes may still be active; preserving ${directory}`);
      rmSync(directory, { recursive: true });
    },
  };
}
