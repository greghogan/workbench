import { WeightedCache } from "../../storage/weighted-cache.js";
import { gitBytes, readGitObjects, readGitTree, type GitEntry } from "../../git/git-snapshot.js";
import { workspaceSchemaVersion } from "../../projects/project-model.js";
import { InvalidInput, MissingResource } from "../../runtime/input-errors.js";
import { record, records, string } from "../../runtime/values.mjs";
import { planIdentity, planningPaths, safePlanFile, type PlanIdentity } from "./plan-model.js";

export interface PlanScope {
  id: string;
  path: string;
  name?: string;
}
export interface SavedPlan {
  identity: PlanIdentity;
  tree: string;
  entries: ReadonlyMap<string, GitEntry>;
}
const indexedFileLimit = 16_384;
const branchIndexes = new WeightedCache<ReadonlyMap<string, SavedPlan>>(indexedFileLimit),
  trees = new WeightedCache<ReadonlyMap<string, GitEntry>>(indexedFileLimit);
export function decodePlanScopes(value: unknown): PlanScope[] {
  const manifest = record(value, "Invalid planning metadata");
  if (
    manifest.schema_version !== workspaceSchemaVersion ||
    Object.keys(manifest).some((key) => !["schema_version", "scopes"].includes(key))
  )
    throw new InvalidInput("Unsupported planning metadata schema");
  const scopes = records(manifest.scopes, "Invalid planning project scopes").map((item) => {
    const id = string(item.id, "Missing plan scope"),
      path = string(item.path, "Missing scope path");
    planIdentity(id, "plan");
    if (path !== "." && (!safePlanFile(path) || path.includes(":"))) throw new InvalidInput("Invalid plan scope path");
    if (
      Object.keys(item).some((key) => !["id", "path", "name"].includes(key)) ||
      (item.name !== undefined && (typeof item.name !== "string" || !item.name.trim()))
    )
      throw new InvalidInput("Invalid plan scope metadata");
    return { id, path, ...(typeof item.name === "string" ? { name: item.name } : {}) };
  });
  if (!scopes.length || new Set(scopes.map((scope) => scope.id)).size !== scopes.length)
    throw new InvalidInput("Planning scopes must be nonempty and distinct");
  return scopes;
}
export function validatePlanEntries(entries: ReadonlyMap<string, GitEntry>): void {
  for (const [path, entry] of entries)
    if (
      !safePlanFile(path) ||
      !["100644", "100755"].includes(entry.mode) ||
      !(
        path === planningPaths.document ||
        path.startsWith(planningPaths.files) ||
        path === planningPaths.approval ||
        path === planningPaths.approved + planningPaths.document ||
        path.startsWith(planningPaths.approved + planningPaths.files)
      )
    )
      throw new InvalidInput(`Unexpected plan file: ${path}`);
  if (!entries.has(planningPaths.document)) throw new InvalidInput("Plan contents are missing");
}
export function planTreeEntries(root: string, tree: string): ReadonlyMap<string, GitEntry> {
  const key = root + ":" + tree,
    cached = trees.get(key);
  if (cached) return cached;
  const entries = readGitTree(root, tree);
  validatePlanEntries(entries);
  trees.set(key, entries, entries.size);
  return entries;
}
export function indexPlanningRevision(root: string, tip: string): ReadonlyMap<string, SavedPlan> {
  const key = root + ":" + tip,
    cached = branchIndexes.get(key);
  if (cached) return cached;
  const directories = new Map<string, string>(),
    files = new Map<string, GitEntry>();
  for (const row of gitBytes(root, ["ls-tree", "-r", "-t", "-z", tip]).toString().split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t"),
      [mode, type, oid] = row.slice(0, tab).split(" "),
      path = row.slice(tab + 1);
    if (tab < 0 || !mode || !oid || !safePlanFile(path)) throw new InvalidInput("Unsafe planning tree entry");
    if (type === "tree") directories.set(path, oid);
    else files.set(path, { mode, oid });
  }
  const metadata = files.get(planningPaths.scopes);
  if (metadata?.mode !== "100644") throw new InvalidInput("Planning history lacks project-scope metadata");
  const body = readGitObjects(root, [metadata.oid]).get(metadata.oid);
  if (!body) throw new MissingResource("Planning scope metadata is unavailable locally");
  const scopes = new Set(decodePlanScopes(JSON.parse(body.toString()) as unknown).map((scope) => scope.id)),
    groups = new Map<string, { identity: PlanIdentity; entries: Map<string, GitEntry> }>();
  for (const [path, entry] of files) {
    if (path === planningPaths.scopes) continue;
    if (!path.startsWith(planningPaths.records))
      throw new InvalidInput(`Planning history contains an unexpected file: ${path}`);
    const [scope, name, ...tail] = path.slice(planningPaths.records.length).split("/");
    if (!scope || !name || !tail.length)
      throw new InvalidInput(`Planning history contains an unexpected file: ${path}`);
    const identity = planIdentity(scope, name);
    if (!scopes.has(identity.scope)) throw new InvalidInput(`Unknown plan scope: ${identity.scope}`);
    let group = groups.get(identity.reference);
    if (!group) {
      group = { identity, entries: new Map() };
      groups.set(identity.reference, group);
    }
    group.entries.set(tail.join("/"), entry);
  }
  const result = new Map<string, SavedPlan>();
  for (const [reference, group] of groups) {
    validatePlanEntries(group.entries);
    const tree = directories.get(`${planningPaths.records}${group.identity.scope}/${group.identity.name}`);
    if (!tree) throw new InvalidInput("Plan subtree is unavailable");
    result.set(reference, { ...group, tree });
    trees.set(root + ":" + tree, group.entries, group.entries.size);
  }
  branchIndexes.set(key, result, files.size);
  return result;
}
