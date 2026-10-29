import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, mkdirSync } from "node:fs";
import { userDirectory } from "../../src/storage.js";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireProcessLock, type ProcessLock } from "../../src/process-lock.js";
import { withToolCacheAdmissionAsync } from "../../src/tool-cache-lock.js";
import { setTimeout as delay } from "node:timers/promises";
import { replaceManagedFiles } from "../managed-files.mjs";
import { maintenanceInputs, maintenanceTargets } from "./plan.mjs";
import { record, string } from "../values.mjs";

const operations = new WeakSet();
export interface MaintenanceOperation {
  readonly root: string;
  readonly owner: ProcessLock;
}
export async function withMaintenanceOperation<T>(
  root: string,
  action: (operation: MaintenanceOperation) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = join(userDirectory("state"), "maintenance-locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, createHash("sha256").update(realpathSync(root)).digest("hex"));
  const activeSignal = signal ?? new AbortController().signal;
  let owner: ProcessLock | undefined;
  while (!owner) {
    activeSignal.throwIfAborted();
    owner = await withToolCacheAdmissionAsync(() => acquireProcessLock(lock, true), activeSignal);
    if (!owner) await delay(100, undefined, { signal: activeSignal });
  }
  const operation = { root, owner };
  operations.add(operation);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    activeSignal.throwIfAborted();
    result = await action(operation);
  } catch (error) {
    failures.push(error);
  }
  operations.delete(operation);
  try {
    owner.release();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Maintenance and ownership release failed", { cause: failures[0] });
  return result as T;
}

export function assertMaintenanceOperation(root: string, operation: MaintenanceOperation) {
  if (!operations.has(operation) || operation.root !== root)
    throw new Error("Maintenance operation does not own this project");
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Per-file publication is atomic; conflicts preserve the destination and identify any partial batch. */
export function publishDeclarations(
  root: string,
  files: [string, string][],
  check: (published?: Record<string, string>) => void,
) {
  const before = files.map(
    ([path]) => [path, existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null] as const,
  );
  check();
  const published: string[] = [];
  const hashes: Record<string, string> = {};
  try {
    for (const [path, text] of files) {
      check(hashes);
      const expected = before.find(([name]) => name === path)?.[1];
      const actual = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
      if (actual !== expected) throw new Error(`Declaration changed during publication: ${path}`);
      replaceManagedFiles([[join(root, path), text]], () => {
        check(hashes);
        const latest = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
        if (latest !== expected) throw new Error(`Declaration changed before replacement: ${path}`);
      });
      published.push(path);
      hashes[path] = digest(text);
    }
  } catch (error) {
    throw new Error(
      `Maintenance publication failed; published files: ${published.join(", ") || "none"}. Preserve working changes and regenerate a plan after reconciliation.`,
      { cause: error },
    );
  }
}
export interface MaintenanceProgress {
  schema_version: 1;
  plan: string;
  root: string;
  scope: "changed" | "selected";
  phase: "declarations" | "locks" | "complete";
  changedPaths: string[];
  completed: string[];
  checksums?: Record<string, Record<string, string>>;
  declarations?: Record<string, string>;
  goMinima?: Record<string, string>;
  inputs: Record<string, string>;
}
export class MaintenanceJournal {
  value: MaintenanceProgress;
  constructor(
    readonly root: string,
    readonly path: string,
    plan: unknown,
    scope: "changed" | "selected",
    resume: boolean,
  ) {
    const identity = digest(JSON.stringify(plan));
    const snapshot = () => maintenanceInputs(root, maintenanceTargets(root));
    if (resume) {
      const value = record(JSON.parse(readFileSync(path, "utf8")), "Invalid maintenance progress");
      if (
        value.schema_version !== 1 ||
        value.plan !== identity ||
        value.root !== realpathSync(root) ||
        value.scope !== scope ||
        !["declarations", "locks", "complete"].includes(string(value.phase, "Missing maintenance phase")) ||
        !Array.isArray(value.completed) ||
        !value.completed.every((entry) => typeof entry === "string") ||
        !Array.isArray(value.changedPaths) ||
        !value.changedPaths.every((entry) => typeof entry === "string")
      )
        throw new Error("Maintenance progress does not match this plan, project, or lock scope");
      if (!isDeepStrictEqual(value.inputs, snapshot()))
        throw new Error(
          "Maintenance files changed since the last checkpoint; reconcile changes and generate a new plan",
        );
      this.value = value as unknown as MaintenanceProgress;
      if (this.value.phase === "declarations")
        throw new Error(
          "Declaration publication was interrupted; inspect its recorded files and reconcile the partial batch before generating a new plan",
        );
    } else {
      if (existsSync(path))
        throw new Error(`Maintenance progress already exists: ${path}; use --resume or choose a new plan path`);
      this.value = {
        schema_version: 1,
        plan: identity,
        root: realpathSync(root),
        scope,
        phase: "declarations",
        changedPaths: [],
        completed: [],
        inputs: snapshot(),
      };
    }
  }
  save() {
    replaceManagedFiles([[this.path, `${JSON.stringify(this.value, null, 2)}\n`]]);
  }
  protectedInputs() {
    const declarations: Record<string, string> = {},
      goMinima: Record<string, string> = {};
    for (const path of new Set(maintenanceTargets(this.root).map((target) => target.path))) {
      const contents = readFileSync(join(this.root, path), "utf8");
      if (path === "go.mod" || path.endsWith("/go.mod")) {
        goMinima[path] = string(/^go (\S+)$/m.exec(contents)?.[1], `Missing Go support boundary: ${path}`);
      } else if (!path.endsWith("Gemfile.lock")) declarations[path] = digest(contents);
    }
    return { declarations, goMinima };
  }
  verifyDeclarations() {
    if (!this.value.declarations) return;
    const actual = this.protectedInputs();
    if (
      !isDeepStrictEqual(actual.declarations, this.value.declarations) ||
      !isDeepStrictEqual(actual.goMinima, this.value.goMinima)
    )
      throw new Error(
        "A declaration or Go support boundary changed during lock refresh; preserve and review the changes before generating a new plan",
      );
  }
  checkpoint(phase: MaintenanceProgress["phase"]) {
    if (this.value.phase === "declarations" && phase === "locks") Object.assign(this.value, this.protectedInputs());
    else this.verifyDeclarations();
    this.value.phase = phase;
    this.value.inputs = maintenanceInputs(this.root, maintenanceTargets(this.root));
    this.save();
  }
}
