import { existsSync, readdirSync, mkdirSync, rmSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { userDirectory } from "./storage.js";
import { withCacheLock, withCacheLockSync, releaseAfterFailure } from "./cache-lock.js";
import { inspectProcessLock } from "./process-lock.js";
import { ownedPath } from "./paths.js";
import { isToolRequirement, type ToolRequirement } from "./tool-requirements.js";

/** Serialize work admission and result-reference updates against shared-tool deletion. */
export function withToolCacheAdmission<T>(action: () => T): T {
  return withCacheLockSync(join(userDirectory("cache"), "tool-maintenance"), action);
}
export async function withToolCacheAdmissionAsync<T>(action: () => T, signal: AbortSignal): Promise<T> {
  return withCacheLock(
    join(userDirectory("cache"), "tool-maintenance"),
    () => Promise.resolve(action()),
    undefined,
    signal,
  );
}
interface ToolUse {
  directory: string;
  pid: number;
  executable: string;
  tools?: ToolRequirement[];
}
export interface ToolCacheActivity {
  uses: ToolUse[];
  blockedBy?: string;
}

/** Unknown owners block cleanup; declared users pin only their actual selected tools. */
export function inspectToolCacheActivity(cleanup = false): ToolCacheActivity {
  const uses: ToolUse[] = [];
  const users = join(userDirectory("cache"), "tool-users");
  if (existsSync(users))
    for (const name of readdirSync(users)) {
      const path = ownedPath(users, name);
      try {
        const file = ownedPath(path, "owner.json");
        if (!lstatSync(file).isFile() || lstatSync(file).size > 256 * 1024) return { uses, blockedBy: path };
        const owner = JSON.parse(readFileSync(file, "utf8")) as {
          pid?: unknown;
          host?: unknown;
          token?: unknown;
          executable?: unknown;
          tools?: unknown;
        };
        if (
          owner.host !== hostname() ||
          !Number.isSafeInteger(owner.pid) ||
          Number(owner.pid) <= 0 ||
          owner.token !== name
        )
          return { uses, blockedBy: path };
        try {
          process.kill(Number(owner.pid), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { uses, blockedBy: path };
          if (cleanup) rmSync(path, { recursive: true });
          continue;
        }
        if (
          typeof owner.executable !== "string" ||
          !isAbsolute(owner.executable) ||
          !Array.isArray(owner.tools) ||
          !owner.tools.every((tool: unknown) => isToolRequirement(tool))
        )
          return { uses, blockedBy: path };
        uses.push({
          directory: path,
          pid: Number(owner.pid),
          executable: owner.executable,
          tools: owner.tools,
        });
      } catch {
        return { uses, blockedBy: path };
      }
    }
  const locks = join(userDirectory("cache"), "locks");
  if (existsSync(locks))
    for (const owner of readdirSync(locks)) {
      const parent = ownedPath(locks, owner);
      for (const name of readdirSync(parent)) {
        const path = ownedPath(parent, name);
        const lease = inspectProcessLock(path);
        if (lease.abandoned) {
          if (cleanup) rmSync(path, { recursive: true });
          continue;
        }
        if (uses.some((use) => use.pid === lease.pid)) continue;
        return { uses, blockedBy: path };
      }
    }
  return { uses };
}

export function toolCacheBlocker(): string | undefined {
  return inspectToolCacheActivity().blockedBy;
}

function enterToolCache(tools?: ToolRequirement[]): () => void {
  const token = randomUUID(),
    parent = join(userDirectory("cache"), "tool-users"),
    path = ownedPath(parent, token);
  const owner = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    token,
    executable: process.execPath,
    ...(tools ? { tools } : {}),
  });
  withToolCacheAdmission(() => {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    mkdirSync(path, { mode: 0o700 });
    try {
      writeFileSync(join(path, "owner.json"), owner, { flag: "wx", mode: 0o600 });
    } catch (error) {
      rmSync(path, { recursive: true });
      throw error;
    }
  });
  const identity = lstatSync(path);
  return () => {
    if (
      lstatSync(ownedPath(parent, token)).ino !== identity.ino ||
      readFileSync(ownedPath(path, "owner.json"), "utf8") !== owner
    )
      throw new Error(`${path}: tool lease ownership changed; preserving it`);
    rmSync(path, { recursive: true });
  };
}

/** Leases cover probes, execution and shutdown, including interactive sessions. */
export function withToolCacheUse<T>(action: () => T, tools?: ToolRequirement[]): T {
  const release = enterToolCache(tools);
  let result: T;
  try {
    result = action();
  } catch (failure) {
    releaseAfterFailure(release, failure, "Workbench command and tool lease release both failed");
  }
  release();
  return result;
}
export async function withToolCacheUseAsync<T>(action: () => Promise<T>, tools?: ToolRequirement[]): Promise<T> {
  const release = enterToolCache(tools);
  let result: T;
  try {
    result = await action();
  } catch (failure) {
    releaseAfterFailure(release, failure, "Workbench command and tool lease release both failed");
  }
  release();
  return result;
}
export function withToolCacheMaintenance<T>(action: () => T): T {
  return withToolCacheAdmission(() => {
    const { blockedBy } = inspectToolCacheActivity(true);
    if (blockedBy) throw new Error(`${blockedBy}: a Workbench command or unresolved lock may be active`);
    return action();
  });
}
