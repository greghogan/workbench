import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userDirectory } from "./storage.js";
import { BoundedState } from "./bounded-state.js";
import { withCacheLockSync } from "./cache-lock.js";
import { invalidateCacheSize } from "./cache-size.js";
type Provider = "rustup" | "uv";
interface Owned {
  provider: Provider;
  directory: string;
  stamp: string;
}
const ledger = () => join(userDirectory("state"), "managed-installations.json");
function stamp(directory: string): string {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed installation ownership is uncertain");
  return createHash("sha256")
    .update(JSON.stringify([realpathSync(directory), stat.dev, stat.ino, stat.birthtimeMs]))
    .digest("hex");
}
export function decodeManagedInstallations(value: unknown): Owned[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        "provider" in entry &&
        (entry.provider === "rustup" || entry.provider === "uv") &&
        "directory" in entry &&
        typeof entry.directory === "string" &&
        isAbsolute(entry.directory) &&
        "stamp" in entry &&
        typeof entry.stamp === "string" &&
        /^[a-f0-9]{64}$/.test(entry.stamp),
    )
  )
    throw new Error("Invalid managed installation ledger");
  return value as Owned[];
}
const store = new BoundedState(ledger, 1024 * 1024, decodeManagedInstallations, () => []);
const read = () => store.read();
/** Snapshot before installation; pre-existing manager installations never become auto-prune owned. */
export function managerInstallations(provider: Provider, env: NodeJS.ProcessEnv): Set<string> {
  let root = join(env.RUSTUP_HOME ?? join(homedir(), ".rustup"), "toolchains");
  if (provider === "uv") {
    const result = spawnSync("uv", ["python", "dir"], { env, encoding: "utf8", timeout: 15000 });
    if (result.error || result.status !== 0) throw new Error("Cannot establish managed Python installation ownership");
    root = result.stdout.trim();
  }
  return new Set(
    existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => realpathSync(join(root, entry.name)))
      : [],
  );
}
export function recordManagerInstallations(
  provider: Provider,
  previous: Set<string>,
  env: NodeJS.ProcessEnv,
  versions: string[],
): void {
  const current = managerInstallations(provider, env);
  for (const directory of current) invalidateCacheSize(directory);
  const added = [...current].filter(
    (directory) =>
      !previous.has(directory) &&
      versions.some((version) =>
        provider === "rustup"
          ? basename(directory).startsWith(`${version}-`)
          : basename(directory).includes(`-${version}-`),
      ),
  );
  if (!added.length) return;
  withCacheLockSync(ledger(), () => {
    const entries = read().filter((entry) => existsSync(entry.directory));
    store.write([...entries, ...added.map((directory) => ({ provider, directory, stamp: stamp(directory) }))]);
  });
}
export function managerOwnershipSnapshot(): (entry: { provider: string; directory: string }) => boolean {
  const snapshot = read();
  return (entry) => ownsManagerInstallation(entry, snapshot);
}
export function ownsManagerInstallation(entry: { provider: string; directory: string }, snapshot = read()): boolean {
  if (entry.provider !== "rustup" && entry.provider !== "uv") return false;
  return snapshot.some(
    (owned) =>
      owned.provider === entry.provider &&
      owned.directory === entry.directory &&
      owned.stamp === stamp(entry.directory),
  );
}
