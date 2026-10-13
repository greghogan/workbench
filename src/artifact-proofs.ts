import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { artifactResponse } from "./artifact-streams.js";
import { userDirectory } from "./storage.js";
import { ownedPath } from "./paths.js";

/** Retain authenticated proof bytes for offline reuse; callers reverify them against their current trust policy. */
export async function artifactProof(url: string, limit: number, label: string, signal?: AbortSignal) {
  if (new URL(url).protocol !== "https:") throw new Error("artifact proofs require HTTPS");
  const path = ownedPath(userDirectory("cache"), `authentication/${createHash("sha256").update(url).digest("hex")}`);
  const offline = process.env.WORKBENCH_OFFLINE === "1";
  let bytes: Buffer;
  if (offline) {
    if (!existsSync(path)) throw new Error(`${label} is unavailable offline: ${url}`);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} cache must be a regular file`);
    if (info.size > limit) throw new Error(`${label} exceeds its size limit`);
    bytes = readFileSync(path);
  } else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of await artifactResponse(url, signal)) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error(`${label} exceeds its size limit`);
      chunks.push(chunk as Buffer);
    }
    bytes = Buffer.concat(chunks);
  }
  return {
    bytes,
    accept() {
      if (offline) return;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.partial`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
