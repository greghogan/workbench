import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { writeAtomic, readLanguageRoots } from "./core.js";
import { readBuildGeneration, type BuildIdentity } from "./builds.js";
import { nativeInstallationPlan } from "./native-tools.js";
import type { CompilerSelection } from "./compilers.js";
import { userDirectory } from "./storage.js";
import { ownedPath } from "./paths.js";
import { withToolCacheAdmission } from "./tool-cache-lock.js";
import { toolRequirement, isToolRequirement, type ToolRequirement } from "./tool-requirements.js";
export interface ResultToolReference {
  directory: string;
  storageRoot: string;
  identity: BuildIdentity;
  kind: "builds" | "dependencies" | "checks";
  tools: ToolRequirement[];
}
export interface ToolReferences {
  results: ResultToolReference[];
  issues: string[];
}
interface ReferenceIndex {
  version: 1;
  results: ResultToolReference[];
}
const location = () => ownedPath(userDirectory("state"), "cache-tool-references.json");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function readIndex(): ReferenceIndex {
  const path = location();
  if (!existsSync(path)) return { version: 1, results: [] };
  if (!lstatSync(path).isFile() || lstatSync(path).size > 16 * 1024 * 1024)
    throw new Error(`${path}: invalid cache reference index`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.results) ||
    !value.results.every(
      (r: unknown) =>
        object(r) &&
        text(r.directory) &&
        isAbsolute(r.directory) &&
        text(r.storageRoot) &&
        isAbsolute(r.storageRoot) &&
        ["builds", "dependencies", "checks"].includes(String(r.kind)) &&
        object(r.identity) &&
        Array.isArray(r.tools) &&
        r.tools.every((tool: unknown) => isToolRequirement(tool)),
    )
  )
    throw new Error(`${path}: invalid cache reference index`);
  return value as unknown as ReferenceIndex;
}

export function selectedToolRequirements(
  root: string,
  path?: string | string[],
  selection: CompilerSelection = {},
): ToolRequirement[] {
  const paths = path === undefined ? undefined : Array.isArray(path) ? path : [path];
  const registered = new Set(readLanguageRoots(root).map((entry) => entry.path));
  const plan = paths
    ? paths.filter((entry) => registered.has(entry)).flatMap((entry) => nativeInstallationPlan(root, entry, selection))
    : nativeInstallationPlan(root, undefined, selection);
  return plan.map((entry) =>
    toolRequirement({ name: entry.tool, version: entry.version }, "directory" in entry ? entry.directory : undefined),
  );
}

function retained(reference: ResultToolReference): boolean {
  if (!existsSync(reference.directory)) return false;
  readBuildGeneration(reference.storageRoot, reference.directory, reference.kind, reference.identity);
  if (reference.kind === "checks") return existsSync(ownedPath(reference.directory, "result.json"));
  // Preparing an empty workspace and writing logs does not create a build result.
  return readdirSync(reference.directory).some(
    (name) => ![".workbench-build.json", ".workbench-dependencies.json", "check-logs"].includes(name),
  );
}

/** Results own tool references. Removing a result releases them without a project lifecycle command. */
export function recordResultTools(reference: ResultToolReference, admissionHeld = false): void {
  const record = () => {
    readBuildGeneration(reference.storageRoot, reference.directory, reference.kind, reference.identity);
    const state = readIndex();
    const previous = state.results.find((r) => r.directory === reference.directory);
    if (previous && retained(previous))
      reference = {
        ...reference,
        tools: [
          ...new Map([...previous.tools, ...reference.tools].map((tool) => [JSON.stringify(tool), tool])).values(),
        ],
      };
    state.results = state.results.filter((r) => r.directory !== reference.directory);
    state.results.push(reference);
    writeAtomic(location(), JSON.stringify(state, null, 2) + "\n", 0o600);
  };
  if (admissionHeld) record();
  else withToolCacheAdmission(record);
}

/** Inspection refreshes from actual retained results, independently of present-day project pins. */
export function inspectToolReferences(): ToolReferences {
  const references: ToolReferences = { results: [], issues: [] };
  try {
    for (const reference of readIndex().results) {
      try {
        if (retained(reference)) references.results.push(reference);
      } catch (error) {
        references.results.push(reference);
        references.issues.push(`${reference.directory}: ${String(error)}`);
      }
    }
  } catch (error) {
    references.issues.push(`Cache references could not be verified: ${String(error)}`);
  }
  return references;
}

/** Pruning automatically drops references whose result was removed; ordinary inspection stays read-only. */
export function refreshToolReferences(): ToolReferences {
  return withToolCacheAdmission(() => {
    const references = inspectToolReferences();
    if (!references.issues.length && existsSync(location()))
      writeAtomic(location(), JSON.stringify({ version: 1, results: references.results }, null, 2) + "\n", 0o600);
    return references;
  });
}
