import { lstat, lchown, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package managers may remove cache entries while another job restores ownership. Never follow links. */
export async function restoreCacheOwnership(path: string, uid: number, gid: number, required = true) {
  try {
    const entry = await lstat(path);
    await lchown(path, uid, gid);
    if (entry.isDirectory())
      for (const name of await readdir(path)) await restoreCacheOwnership(join(path, name), uid, gid, false);
  } catch (error) {
    if (!required && error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

if (
  process.argv[1] === "workbench-cache-ownership" ||
  (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
  const [owner, ...paths] = process.argv.slice(2);
  if (!owner || !/^[0-9]+:[0-9]+$/.test(owner) || !paths.length)
    throw new Error("cache ownership requires uid:gid and paths");
  const [uid, gid] = owner.split(":").map(Number);
  if (uid === undefined || gid === undefined || ![uid, gid].every(Number.isSafeInteger))
    throw new Error("cache ownership requires safe integer IDs");
  for (const path of paths) await restoreCacheOwnership(path, uid, gid);
}
