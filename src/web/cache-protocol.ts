import { decodeWorkerFailure } from "./error-response.js";
import { isAbsolute } from "node:path";
import type { CacheSize } from "../cache-size.js";
import { InvalidInput } from "../input-errors.js";
import { decodeProjectRegistry } from "../project-registry.js";
import type { CacheInventory, CacheProgress } from "./cache-inventory.js";
import type { CacheResults, CacheTask } from "./cache-worker.js";
import { decodeCacheSize } from "./size-protocol.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidInput("Invalid cache worker object");
  return value as ObjectValue;
}
function check(valid: boolean): asserts valid {
  if (!valid) throw new InvalidInput("Invalid cache worker data");
}
const text = (value: unknown): value is string => typeof value === "string";
const path = (value: unknown): value is string => text(value) && isAbsolute(value);
const bytes = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const optionalBytes = (value: unknown): boolean => value === undefined || bytes(value);
const member = (value: unknown, choices: readonly string[]): boolean =>
  typeof value === "string" && choices.includes(value);
const hash = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
function list(value: unknown, decode: (entry: unknown) => unknown): void {
  check(Array.isArray(value));
  for (const entry of value) decode(entry);
}
function strings(value: unknown): void {
  list(value, (entry) => {
    check(text(entry));
  });
}
function size(value: unknown, options: { currentRead?: true } = {}): CacheSize {
  let data: CacheSize;
  try {
    data = decodeCacheSize(value, options);
  } catch (cause) {
    throw new InvalidInput("Invalid cache worker data", { cause });
  }
  check(path(data.directory));
  return data;
}
function identity(value: unknown): void {
  const data = object(value);
  check(path(data.checkout) && text(data.root) && text(data.environment) && text(data.fingerprint));
}
function report(value: unknown): void {
  const data = object(value);
  check(text(data.storageRoot) && (data.checkout === null || text(data.checkout)));
  list(data.entries, (value) => {
    const entry = object(value);
    check(
      member(entry.kind, ["builds", "dependencies", "checks", "logs"]) &&
        path(entry.directory) &&
        optionalBytes(entry.bytes),
    );
    check(entry.blockedBy === undefined || text(entry.blockedBy));
    check(entry.generation === undefined || hash(entry.generation));
    if (entry.measurement !== undefined) size(entry.measurement, { currentRead: true });
    identity(entry.identity);
  });
  if (data.tools !== undefined) {
    const tools = object(data.tools);
    strings(tools.issues);
    const refs = object(tools.references);
    strings(refs.issues);
    list(refs.results, (value) => {
      const entry = object(value);
      check(path(entry.directory) && path(entry.storageRoot));
      if (entry.measurement !== undefined) size(entry.measurement, { currentRead: true });
      identity(entry.identity);
      list(entry.tools, (tool) => {
        const t = object(tool);
        check(text(t.tool) && text(t.version) && (t.directory === undefined || path(t.directory)));
      });
    });
    list(tools.entries, (value) => {
      const entry = object(value);
      check(
        text(entry.id) &&
          text(entry.tool) &&
          text(entry.version) &&
          text(entry.platform) &&
          path(entry.directory) &&
          text(entry.identity) &&
          optionalBytes(entry.bytes),
      );
      if (entry.measurement !== undefined) size(entry.measurement, { currentRead: true });
      check(member(entry.provider, ["workbench", "rustup", "uv"]));
      strings(entry.protected);
      strings(entry.pinnedBy);
      list(entry.protections, (value) => {
        const protection = object(value);
        check(
          member(protection.kind, [
            "result",
            "project",
            "unavailable-project",
            "keep",
            "active",
            "lock",
            "references",
          ]) && text(protection.reason),
        );
        if (protection.kind === "result") check(path(protection.directory));
        if (protection.kind === "project" || protection.kind === "unavailable-project") check(path(protection.project));
      });
    });
  }
  for (const field of ["builders", "images"] as const)
    if (data[field] !== undefined) {
      const part = object(data[field]);
      strings(part.issues);
      if (field === "images") check(part.location === "local" || part.location === "registry");
      list(part.entries, (value) => {
        const entry = object(value);
        check(
          text(entry.key) && optionalBytes(entry.bytes) && (entry.blockedBy === undefined || text(entry.blockedBy)),
        );
        if (field === "images")
          check(
            path(entry.checkout) &&
              text(entry.profile) &&
              text(entry.reference) &&
              text(entry.image) &&
              path(entry.lock) &&
              text(entry.identity),
          );
        else {
          check(text(entry.builder));
          strings(entry.volumes);
        }
      });
    }
}
function projectPlan(value: unknown): void {
  const data = object(value);
  check(
    path(data.project) && text(data.registration) && text(data.root) && hash(data.digest) && optionalBytes(data.bytes),
  );
  strings(data.blocked);
  list(data.reports, report);
}
function inventory(value: unknown): CacheInventory {
  const data = object(value);
  report(data.inventory);
  decodeProjectRegistry({ version: 1, projects: data.projects, kept: data.kept });
  strings(data.prunable);
  strings(data.uncertainConsumers);
  for (const values of Object.values(object(data.consumers))) strings(values);
  list(data.sizes, size);
  list(data.issues, (value) => {
    const issue = object(value);
    check(
      member(issue.component, [
        "registry",
        "requirements",
        "references",
        "builds",
        "tools",
        "builders",
        "images",
        "size",
      ]) &&
        (issue.phase === "discovery" || issue.phase === "measurement") &&
        text(issue.message) &&
        (issue.path === undefined || text(issue.path)),
    );
  });
  return data as unknown as CacheInventory;
}
export function decodeCacheTask(value: unknown): CacheTask {
  const data = object(value);
  switch (data.kind) {
    case "inventory":
      check(data.force === undefined || typeof data.force === "boolean");
      check(data.priority === undefined || path(data.priority));
      break;
    case "register":
      check(text(data.path));
      break;
    case "project":
      check(path(data.path) && (data.root === undefined || text(data.root)));
      break;
    case "apply":
      projectPlan(data.plan);
      check(typeof data.remove === "boolean");
      break;
    case "assets":
      check(data.digest === undefined || hash(data.digest));
      break;
    case "keep":
      check(path(data.identity) && typeof data.keep === "boolean");
      break;
    default:
      throw new InvalidInput("Unknown cache worker task");
  }
  return data as unknown as CacheTask;
}
export function decodeCacheResult<T extends keyof CacheResults>(kind: T, value: unknown): CacheResults[T] {
  const data = object(value);
  switch (kind) {
    case "inventory":
      inventory(data);
      break;
    case "project":
      projectPlan(data);
      break;
    case "register":
      check(data.registered === true);
      break;
    case "apply":
    case "keep":
      check(data.applied === true);
      break;
    case "assets":
      check(hash(data.digest) && optionalBytes(data.bytes));
      strings(data.issues);
      report({
        storageRoot: "",
        checkout: null,
        entries: [],
        tools: { entries: data.entries, issues: [], references: { results: [], issues: [] } },
      });
      break;
  }
  return data as unknown as CacheResults[T];
}
export function decodeCacheProgress(value: unknown): CacheProgress {
  const data = object(value);
  if (data.kind === "metadata") return { kind: "metadata", value: inventory(data.value) };
  if (data.kind === "size") return { kind: "size", size: size(data.size) };
  throw new InvalidInput("Unknown cache inventory progress");
}
export const decodeCacheError = decodeWorkerFailure;
