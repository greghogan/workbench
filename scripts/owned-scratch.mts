import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { acquireProcessLock, inspectProcessLock, type ProcessLock } from "../src/process-lock.js";

const marker = ".workbench-scratch.json";
interface ScratchRecord {
  version: 1;
  kind: string;
  token: string;
}
function record(directory: string): ScratchRecord | undefined {
  try {
    const info = lstatSync(directory),
      path = join(directory, marker),
      file = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 4096)
      return;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ScratchRecord>;
    return value.version === 1 &&
      typeof value.kind === "string" &&
      typeof value.token === "string" &&
      /^[a-f0-9-]{36}$/.test(value.token)
      ? (value as ScratchRecord)
      : undefined;
  } catch {
    return;
  }
}

/** Reclaim only marked directories whose local owner and all registered child groups are confirmed gone. */
export function recoverScratch(parent: string, kind: string): string[] {
  mkdirSync(parent, { recursive: true });
  const reclaimed: string[] = [];
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(`${kind}-`) && !name.startsWith(".workbench-reclaim-")) continue;
    const directory = join(parent, name),
      saved = record(directory);
    if (saved?.kind !== kind || !inspectProcessLock(join(directory, "owner")).abandoned) continue;
    let original;
    try {
      original = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const quarantine = join(parent, `.workbench-reclaim-${randomUUID()}`);
    // Renaming uniquely named, never-reused scratch claims it atomically against other reclaimers.
    try {
      renameSync(directory, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const claimed = lstatSync(quarantine);
    if (
      claimed.ino !== original.ino ||
      claimed.dev !== original.dev ||
      record(quarantine)?.token !== saved.token ||
      !inspectProcessLock(join(quarantine, "owner")).abandoned
    ) {
      throw new Error(`Scratch ownership changed; preserving ${quarantine}`);
    }
    rmSync(quarantine, { recursive: true });
    reclaimed.push(name);
  }
  return reclaimed;
}
export interface OwnedScratch {
  directory: string;
  owner: ProcessLock;
  release: () => void;
}
export function createOwnedScratch(parent: string, kind: string): OwnedScratch {
  recoverScratch(parent, kind);
  const directory = mkdtempSync(join(parent, `${kind}-`)),
    token = randomUUID();
  writeFileSync(join(directory, marker), JSON.stringify({ version: 1, kind, token }), { flag: "wx", mode: 0o600 });
  const owner = acquireProcessLock(join(directory, "owner"), true);
  if (!owner) throw new Error(`Cannot own new scratch directory ${directory}`);
  return {
    directory,
    owner,
    release: () => {
      if (record(directory)?.token !== token) throw new Error(`Scratch ownership changed; preserving ${directory}`);
      owner.assertIdle();
      for (const name of readdirSync(directory))
        if (name !== "owner" && name !== marker) rmSync(join(directory, name), { recursive: true, force: true });
      owner.release();
      rmSync(directory, { recursive: true });
    },
  };
}
