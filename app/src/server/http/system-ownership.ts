import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readBoundedFile } from "../../core/runtime/file-reads.js";
import { isRecord } from "../../core/runtime/values.mjs";
import { writeAtomic } from "../../core/runtime/file-publication.mjs";

const ownerFile = "listener.json";
const privateDirectoryName = /^wb-(\d+)-[0-9a-f]{32}$/;

function linuxProcessIdentity(pid: number): { uid: number; start: string } | undefined {
  try {
    const directory = `/proc/${String(pid)}`;
    const owner = lstatSync(directory);
    const stats = readFileSync(join(directory, "stat"), "utf8");
    // Field 2 can contain spaces and parentheses. Field 22 is the process start tick.
    const start = stats.slice(stats.lastIndexOf(")") + 2).split(" ")[19];
    if (!start || !/^\d+$/.test(start)) return undefined;
    return { uid: owner.uid, start };
  } catch {
    return undefined;
  }
}

function listenerIdentity(pid: number): { uid: number; start: string } | undefined {
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform !== "darwin") return undefined;
  try {
    const line = execFileSync("/bin/ps", ["-p", String(pid), "-o", "uid=", "-o", "lstart="], {
      encoding: "utf8",
      maxBuffer: 256,
      timeout: 5000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [, uid, start] = /^(\d+)\s+([^\r\n]+)$/.exec(line) ?? [];
    if (uid && start) return { uid: Number(uid), start };
  } catch {
    // A stopped process cannot retain the listener lease.
  }
  return undefined;
}

/** An account publishes its identity before attempting browser bind and keeps it until transport shutdown. */
export function markPrivateListener(directory: string): (() => void) | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  const identity = listenerIdentity(process.pid);
  if (!identity) throw new Error("Could not establish the private Workbench listener identity");
  const marker = join(directory, ownerFile);
  writeAtomic(marker, JSON.stringify({ pid: process.pid, start: identity.start }), 0o600);
  return () => {
    unlinkSync(marker);
  };
}

export function activePrivateListenerProcesses(uid?: number): number[] {
  const processes: number[] = [];
  for (const name of readdirSync("/tmp")) {
    const match = privateDirectoryName.exec(name);
    if (!match || (uid !== undefined && Number(match[1]) !== uid)) continue;
    try {
      const directory = join("/tmp", name);
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== Number(match[1]) || stat.mode & 0o077) continue;
      const marker = join(directory, ownerFile);
      const file = lstatSync(marker);
      if (!file.isFile() || file.uid !== stat.uid || file.mode & 0o077) continue;
      const owner: unknown = JSON.parse(readBoundedFile(marker, 256, "private service owner").toString());
      if (
        !isRecord(owner) ||
        typeof owner.pid !== "number" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.start !== "string"
      )
        continue;
      const active = listenerIdentity(owner.pid);
      if (active?.uid === file.uid && active.start === owner.start) processes.push(owner.pid);
    } catch {
      // A private owner may leave at any point. No unverified marker establishes activity.
    }
  }
  return processes;
}
