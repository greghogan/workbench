import { createHash } from "node:crypto";
import { fstatSync, mkdirSync, readFileSync, readSync, statfsSync } from "node:fs";
import { ownedPath } from "../../runtime/paths.js";
import { readBoundedFile, withStableFile } from "../../runtime/file-reads.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { userDirectory } from "../../storage/storage.js";

// These Linux filesystems report local inode identity and nanosecond change timestamps.
const localFilesystems = new Set([0xef53, 0x58465342, 0x9123683e]);
const limit = 256;

function fileIdentity(descriptor: number): string {
  const { dev, ino, size, mtimeNs, ctimeNs, mode } = fstatSync(descriptor, { bigint: true });
  return [dev, ino, size, mtimeNs, ctimeNs, mode].join(":");
}

/** Reuse byte hashes only after opening and identifying the same local executable again. */
export function checkToolDigests() {
  let file: string | undefined;
  let saved: Map<string, string> | undefined;
  let boot: string | undefined;
  let changed = false;
  const entries = () => {
    if (saved) return saved;
    saved = new Map();
    try {
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^[a-f0-9-]{36}$/.test(boot)) return saved;
      const directory = userDirectory("cache");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!localFilesystems.has(statfsSync(directory).type)) return saved;
      file = ownedPath(directory, "check-tool-digests.json");
      const data = JSON.parse(readBoundedFile(file, 1024 * 1024).toString()) as {
        boot?: unknown;
        entries?: unknown;
      };
      if (data.boot === boot && Array.isArray(data.entries)) {
        const records: unknown[] = data.entries;
        for (const pair of records.slice(-limit)) {
          if (
            Array.isArray(pair) &&
            typeof pair[0] === "string" &&
            typeof pair[1] === "string" &&
            /^[a-f0-9]{64}$/.test(pair[1])
          )
            saved.set(pair[0], pair[1]);
        }
      }
    } catch {
      // Missing or unusable cache evidence leaves byte hashing available.
    }
    return saved;
  };
  return {
    read: (path: string): [digest: string, executableMode: number] => {
      const [digest, mode, key] = withStableFile(path, (descriptor, metadata) => {
        let key: string | undefined;
        if (process.platform === "linux" && metadata.size >= 1024 ** 2) {
          let local = false;
          try {
            local = localFilesystems.has(statfsSync(`/proc/self/fd/${String(descriptor)}`).type);
          } catch {
            // Continue with byte hashing if the backing filesystem is unknown.
          }
          if (local) {
            key = fileIdentity(descriptor);
            const cached = entries().get(key);
            if (cached) return [cached, metadata.mode & 0o111, undefined] as const;
          }
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(128 * 1024);
        let count: number;
        let length = 0;
        while ((count = readSync(descriptor, buffer)) > 0) {
          length += count;
          hash.update(buffer.subarray(0, count));
        }
        if (length !== metadata.size || (key && fileIdentity(descriptor) !== key))
          throw new Error("Tool changed during verification");
        return [hash.digest("hex"), metadata.mode & 0o111, key] as const;
      });
      if (key && saved) {
        saved.set(key, digest);
        changed = true;
      }
      return [digest, mode];
    },
    save: () => {
      if (!changed || !saved || !file) return;
      try {
        writeAtomic(file, JSON.stringify({ boot, entries: [...saved].slice(-limit) }) + "\n", 0o600);
        changed = false;
      } catch {
        // A later gate can verify the same bytes again.
      }
    },
  };
}
