import { isAbsolute, relative, resolve, sep } from "node:path";
import { targetPhases } from "./ci-contract.mjs";
import { positiveInteger } from "./cpu-budget.mjs";

/** A private process boundary still requires a complete, checked request before any effects. */
export function parseCIWorkerRequest(value) {
  const fail = (location, expected) => {
    throw new Error(`Invalid local CI worker request: ${location}: expected ${expected}`);
  };
  const object = (entry, location, allowed) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(location, "an object");
    if (allowed && Object.keys(entry).some((key) => !allowed.includes(key))) fail(location, "only declared fields");
  };
  const text = (entry, location) => {
    if (typeof entry !== "string" || !entry.length || entry.includes("\0"))
      fail(location, "a nonempty string without NUL");
  };
  const strings = (entry, location) => {
    if (!Array.isArray(entry)) fail(location, "an array of strings");
    entry.forEach((item, index) => text(item, `${location}[${index}]`));
  };
  const absolute = (entry, location) => {
    text(entry, location);
    if (!isAbsolute(entry)) fail(location, "an absolute path");
  };
  const contains = (parent, child) => {
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
  for (const name of ["workspace", "distribution", "reports", "cache", "adapter"]) absolute(value[name], name);
  if (!contains(value.workspace, value.distribution)) fail("distribution", "a path within the job workspace");
  for (const name of ["uid", "gid"])
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) fail(name, "a nonnegative integer");
  object(value.shared, "shared");
  for (const [key, entry] of Object.entries(value.shared)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail("shared", "valid environment variable names");
    if (typeof entry !== "string" || entry.includes("\0")) fail(`shared.${key}`, "a string without NUL");
  }
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
  for (const name of ["id", "path", "kind", "environment"]) text(target[name], `target.${name}`);
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
    if (!["node", "python", "go", "rust", "java", "ruby", "php", "clang", "gcc"].includes(target.runtime))
      fail("target.runtime", "a declared compatibility runtime");
    text(target.version, "target.version");
    strings(target.roles, "target.roles");
    if (!target.roles.length) fail("target.roles", "at least one role");
  } else if (["runtime", "version", "roles"].some((key) => Object.hasOwn(target, key)))
    fail("target", "runtime selection only for compatibility jobs");
  if (target.kind !== "native" && target.release !== false) fail("target.release", "false outside native jobs");
  const phases = targetPhases(target);
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
  return value;
}
