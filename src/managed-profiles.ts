import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { writeAtomic } from "./core.js";
import { ownedPath } from "./paths.js";
import type { BuildPaths } from "./builds.js";

type ProfileRole = "environment" | "runtime" | "image";
const roles: ProfileRole[] = ["environment", "runtime", "image"];
const receipt = (role: ProfileRole) => `.workbench-guix-${role === "environment" ? "" : `${role}-`}root.json`;
const suffix = (role: ProfileRole) => (role === "environment" ? "" : `-${role}`);
const rootName = (directory: string) => `workbench-${createHash("sha256").update(directory).digest("hex")}`;

export function managedProfilePath(paths: BuildPaths, role: ProfileRole = "environment"): string {
  if (paths.identity.environment !== "guix") return join(paths.dependencies, "profile");
  const state = process.env.GUIX_STATE_DIRECTORY ?? "/var/guix";
  if (!isAbsolute(state)) throw new Error("GUIX_STATE_DIRECTORY must be absolute");
  // An unprivileged daemon cannot traverse private XDG cache directories. Keep only the public store link here.
  return join(state, "profiles/per-user", userInfo().username, rootName(paths.dependencies) + suffix(role));
}

export function prepareManagedProfile(paths: BuildPaths, profile: string, role: ProfileRole = "environment"): void {
  if (paths.identity.environment !== "guix") return;
  const parent = dirname(profile);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o755 });
  } catch (error) {
    if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    // Opening the store lets the daemon create its per-user directory on a user's first invocation.
    const result = spawnSync("guix", ["gc", "--list-roots"], { stdio: "ignore" });
    if (result.error || result.status !== 0)
      throw new Error("Could not initialize the Guix profile directory", { cause: error });
    mkdirSync(parent, { recursive: true, mode: 0o755 });
  }
  ownedPath("/", realpathSync(parent).slice(1));
  if (lstatSync(parent).uid !== process.getuid?.())
    throw new Error(`${parent}: Guix profile directory is not owned by you`);
  const path = ownedPath(paths.dependencies, receipt(role));
  const value = JSON.stringify({ path: join(realpathSync(parent), basename(profile)) }) + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") !== value)
    throw new Error(`${path}: Guix root ownership changed; prune the previous environment first`);
  writeAtomic(path, value, 0o600);
}

/** Validate every registration before deleting any member of a cache selection. */
export function guixProfileRegistrations(directory: string): { role: ProfileRole; path: string }[] {
  return roles.flatMap((role) => {
    const path = ownedPath(directory, receipt(role));
    if (!existsSync(path)) return [];
    const value = JSON.parse(readFileSync(path, "utf8")) as { path?: unknown };
    const profile = value.path;
    const expected = join("profiles/per-user", userInfo().username, rootName(directory) + suffix(role));
    if (typeof profile !== "string" || !isAbsolute(profile) || !profile.endsWith(`/${expected}`))
      throw new Error(`${path}: invalid Guix root ownership`);
    ownedPath("/", dirname(profile).slice(1));
    const metadata = lstatSync(profile, { throwIfNoEntry: false });
    if (metadata && (!metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()))
      throw new Error(`${profile}: expected your registered Guix profile symlink`);
    return [{ role, path: profile }];
  });
}

export function releaseGuixProfiles(directory: string): void {
  for (const profile of guixProfileRegistrations(directory)) rmSync(profile.path, { force: true });
}

/** Guix refuses an existing --root link; refresh only the registered environment under its dependency lock. */
export function releaseGuixEnvironmentRoot(directory: string): void {
  const profile = guixProfileRegistrations(directory).find((entry) => entry.role === "environment");
  if (profile) rmSync(profile.path, { force: true });
}
