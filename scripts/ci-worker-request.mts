import type { CITarget } from "../src/ci-targets.js";
export interface CIWorkerRequest {
  version: 1;
  workspace: string;
  distribution: string;
  target: CITarget;
  reports: string;
  image?: string;
  profile?: string;
  cache: string;
  shared: Record<string, string>;
  adapter: string;
  uid: number;
  gid: number;
}
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isRecord } from "./values.mjs";
import { targetPhases, type TargetSelection } from "./ci-contract.mjs";
import { positiveInteger } from "./cpu-budget.mjs";

/** A private process boundary still requires a complete, checked request before any effects. */
function assertCIWorkerRequest(value: unknown): asserts value is CIWorkerRequest {
  function fail(location: string, expected: string): never {
    throw new Error(`Invalid local CI worker request: ${location}: expected ${expected}`);
  }
  function object(entry: unknown, location: string, allowed?: string[]): asserts entry is Record<string, unknown> {
    if (!isRecord(entry)) fail(location, "an object");
    if (allowed && Object.keys(entry).some((key) => !allowed.includes(key))) fail(location, "only declared fields");
  }
  function text(entry: unknown, location: string): asserts entry is string {
    if (typeof entry !== "string" || !entry.length || entry.includes("\0"))
      fail(location, "a nonempty string without NUL");
  }
  function strings(entry: unknown, location: string): asserts entry is string[] {
    if (!Array.isArray(entry)) fail(location, "an array of strings");
    entry.forEach((item, index) => {
      text(item, `${location}[${String(index)}]`);
    });
  }
  function absolute(entry: unknown, location: string): asserts entry is string {
    text(entry, location);
    if (!isAbsolute(entry)) fail(location, "an absolute path");
  }
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  object(value, "request", [
    "version",
    "workspace",
    "distribution",
    "target",
    "reports",
    "image",
    "profile",
    "cache",
    "shared",
    "adapter",
    "uid",
    "gid",
  ]);
  if (value.version !== 1) fail("version", "1");
  absolute(value.workspace, "workspace");
  absolute(value.distribution, "distribution");
  for (const name of ["reports", "cache", "adapter"]) absolute(value[name], name);
  if (!contains(value.workspace, value.distribution)) fail("distribution", "a path within the job workspace");
  for (const name of ["uid", "gid"])
    if (typeof value[name] !== "number" || !Number.isSafeInteger(value[name]) || value[name] < 0)
      fail(name, "a nonnegative integer");
  object(value.shared, "shared");
  for (const [key, entry] of Object.entries(value.shared)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail("shared", "valid environment variable names");
    if (typeof entry !== "string" || entry.includes("\0")) fail(`shared.${key}`, "a string without NUL");
  }
  positiveInteger(value.shared.WORKBENCH_CPU_BUDGET, "Invalid local CI worker request: shared.WORKBENCH_CPU_BUDGET");
  if (value.shared.WORKBENCH_CPUS !== undefined)
    positiveInteger(value.shared.WORKBENCH_CPUS, "Invalid local CI worker request: shared.WORKBENCH_CPUS");
  const target = value.target;
  object(target, "target", [
    "id",
    "path",
    "kind",
    "os",
    "architecture",
    "environment",
    "release",
    "toolchain",
    "runtime",
    "version",
    "roles",
    "phases",
    "checks",
  ]);
  text(target.path, "target.path");
  text(target.kind, "target.kind");
  text(target.environment, "target.environment");
  text(target.id, "target.id");
  if (!["native", "environment", "compatibility"].includes(target.kind)) fail("target.kind", "a declared target kind");
  if (isAbsolute(target.path) || !contains(value.workspace, resolve(value.workspace, target.path)))
    fail("target.path", "a relative path within the job workspace");
  if (target.os !== "linux" || target.architecture !== "x64") fail("target", "native Linux x64");
  if (typeof target.release !== "boolean") fail("target.release", "Boolean");
  if (target.kind === "environment") {
    if (!["nix", "guix", "nix-docker", "devcontainer"].includes(target.environment))
      fail("target.environment", "a managed environment");
  } else if (target.environment !== "native") fail("target.environment", "native");
  if (target.toolchain !== undefined) {
    if (target.kind !== "native") fail("target.toolchain", "native tool selection");
    text(target.toolchain, "target.toolchain");
  }
  if (target.kind === "compatibility") {
    text(target.runtime, "target.runtime");
    if (!["node", "python", "go", "rust", "java", "ruby", "php", "clang", "gcc"].includes(target.runtime))
      fail("target.runtime", "a declared compatibility runtime");
    text(target.version, "target.version");
    strings(target.roles, "target.roles");
    if (!target.roles.length) fail("target.roles", "at least one role");
  } else if (["runtime", "version", "roles"].some((key) => Object.hasOwn(target, key)))
    fail("target", "runtime selection only for compatibility jobs");
  if (target.kind !== "native" && target.release) fail("target.release", "false outside native jobs");
  // The selection fields above are validated before computing the expected phases.
  const phases = targetPhases(target as unknown as TargetSelection);
  strings(target.phases, "target.phases");
  if (JSON.stringify(target.phases) !== JSON.stringify(phases))
    fail("target.phases", "the selected target's execution phases");
  if (!Array.isArray(target.checks)) fail("target.checks", "an array");
  for (const check of target.checks) {
    object(check, "target.checks[]", ["name", "role", "command", "source"]);
    text(check.name, "check.name");
    text(check.role, "check.role");
    strings(check.command, "check.command");
    if (!check.command.length) fail("check.command", "a command");
    if (check.source !== undefined) text(check.source, "check.source");
  }
  if (value.profile !== undefined) text(value.profile, "profile");
  if (target.kind !== "environment" || value.profile) text(value.image, "image");
  else if (value.image !== undefined) text(value.image, "image");
}

export function parseCIWorkerRequest(value: unknown): CIWorkerRequest {
  assertCIWorkerRequest(value);
  return value;
}
