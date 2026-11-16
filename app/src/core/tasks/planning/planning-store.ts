import {
  decodePlanScopes,
  indexPlanningRevision,
  planTreeEntries,
  validatePlanEntries,
  type PlanScope,
  type SavedPlan,
} from "./planning-index.js";
import { existsSync } from "node:fs";
import { gitBytes, readGitObjects, readGitTree, type GitEntry } from "../../git/git-snapshot.js";
import { gitRevision } from "../../git/refs.js";
import { InvalidInput, MissingResource } from "../../runtime/input-errors.js";
import { record, string } from "../../runtime/values.mjs";
import { readProjects } from "../../projects/project-configuration.js";
import { projectPaths } from "../../projects/project-paths.js";
import { join } from "node:path";
import {
  parsePlan,
  planContent,
  planVersion,
  planStateVersion,
  planDraftRef,
  planBaseRef,
  planRemovalRef,
  planIdentity,
  planningPaths,
  type PlanIdentity,
  type PlanDocument,
} from "./plan-model.js";
import { taskPlanApprovalDigest } from "../task-plan.js";
import { planningSettings } from "./planning-settings.js";

export interface PlanView extends PlanIdentity {
  tree: string;
  entries: ReadonlyMap<string, GitEntry>;
  contents: string;
  digest: string;
  document?: PlanDocument;
  problem?: string;
  draft: boolean;
  conflict: boolean;
  branchTree?: string;
  baseTree?: string;
  approval?: { at: string; contents: string; entries: ReadonlyMap<string, GitEntry>; current: boolean };
}
export function planningScopes(root: string): PlanScope[] {
  if (existsSync(join(root, projectPaths.projects)))
    return readProjects(root).map(({ id, path, name }) => ({ id, path, ...(name ? { name } : {}) }));
  const branch = planningSettings(root).branch,
    tip = branch ? gitRevision(root, `refs/heads/${branch}`) : undefined;
  const entry = tip ? readGitTree(root, tip).get(planningPaths.scopes) : undefined,
    bytes = entry ? readGitObjects(root, [entry.oid]).get(entry.oid) : undefined;
  if (!bytes) throw new InvalidInput("Open a configured project checkout before creating plans");
  return decodePlanScopes(JSON.parse(bytes.toString()) as unknown);
}
export function savedPlanTrees(root: string): ReadonlyMap<string, SavedPlan> {
  const branch = planningSettings(root).branch,
    tip = branch ? gitRevision(root, `refs/heads/${branch}`) : undefined;
  if (!tip) return new Map();
  return indexPlanningRevision(root, tip);
}
export function draftPlanIdentities(root: string, prefix: string = planningPaths.drafts): PlanIdentity[] {
  return gitBytes(root, ["for-each-ref", "--format=%(refname)", prefix])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((ref) => {
      const [scope, name, ...extra] = ref.slice(prefix.length).split("/");
      if (!scope || !name || extra.length) throw new InvalidInput("Invalid plan draft reference");
      return planIdentity(scope, name);
    });
}
interface PlanRead {
  identity: PlanIdentity;
  tree: string;
  entries: ReadonlyMap<string, GitEntry>;
  branchTree: string | undefined;
  draftTree: string | undefined;
  baseTree: string | undefined;
}
function planRead(
  root: string,
  identity: PlanIdentity,
  saved: ReadonlyMap<string, SavedPlan>,
  refs?: ReadonlyMap<string, string>,
): PlanRead {
  if (refs ? refs.has(planRemovalRef(identity)) : gitRevision(root, planRemovalRef(identity)))
    throw new MissingResource(`Plan removed locally: ${identity.reference}; checkpoint the pending changes`);
  const branch = saved.get(identity.reference),
    branchTree = branch?.tree,
    draftTree = refs ? refs.get(planDraftRef(identity)) : gitRevision(root, planDraftRef(identity)),
    baseTree = draftTree
      ? refs
        ? refs.get(planBaseRef(identity))
        : gitRevision(root, planBaseRef(identity))
      : undefined,
    tree = draftTree ?? branchTree;
  if (!tree) throw new MissingResource(`Plan not found: ${identity.reference}`);
  const entries = draftTree ? planTreeEntries(root, draftTree) : branch?.entries;
  if (!entries) throw new MissingResource(`Plan contents unavailable: ${identity.reference}`);
  return { identity, tree, entries, branchTree, draftTree, baseTree };
}
function planRequests(input: PlanRead): string[] {
  return [planningPaths.document, planningPaths.approval, planningPaths.approved + planningPaths.document].flatMap(
    (path) => {
      const entry = input.entries.get(path);
      return entry ? [entry.oid] : [];
    },
  );
}
function planView(input: PlanRead, objects: ReadonlyMap<string, Buffer | undefined>): PlanView {
  const { identity, tree, entries, branchTree, draftTree, baseTree } = input,
    body = objects.get(entries.get(planningPaths.document)?.oid ?? "");
  if (!body) throw new MissingResource(`Plan contents unavailable: ${identity.reference}`);
  const contents = body.toString();
  let document: PlanDocument | undefined, problem: string | undefined;
  try {
    document = parsePlan(contents, identity.reference);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const approved = new Map(
    [...entries]
      .filter(([path]) => path.startsWith(planningPaths.approved))
      .map(([path, entry]) => [path.slice(planningPaths.approved.length), entry]),
  );
  const approvalEntry = entries.get(planningPaths.approval);
  let approval: PlanView["approval"];
  if (approved.size || approvalEntry) {
    if (!approved.has(planningPaths.document) || !approvalEntry)
      throw new InvalidInput("Incomplete plan approval snapshot");
    validatePlanEntries(approved);
    const metadata = objects.get(approvalEntry.oid),
      prior = objects.get(approved.get(planningPaths.document)?.oid ?? "");
    if (!metadata || !prior) throw new MissingResource("Approved plan snapshot is unavailable locally");
    const receipt = record(JSON.parse(metadata.toString()) as unknown, "Invalid plan approval"),
      at = string(receipt.at, "Missing approval time");
    if (Object.keys(receipt).some((key) => key !== "at") || !Number.isFinite(Date.parse(at)))
      throw new InvalidInput("Invalid plan approval time");
    if (parsePlan(prior.toString(), identity.reference).metadata.status !== "Approved")
      throw new InvalidInput("Approved plan snapshot has the wrong state");
    approval = {
      at,
      contents: prior.toString(),
      entries: approved,
      current:
        document?.metadata.status === "Approved" &&
        taskPlanApprovalDigest(prior.toString()) === taskPlanApprovalDigest(contents) &&
        planVersion(new Map([...planContent(entries)].filter(([path]) => path !== planningPaths.document))) ===
          planVersion(new Map([...approved].filter(([path]) => path !== planningPaths.document))),
    };
  }
  return {
    ...identity,
    tree,
    entries,
    contents,
    digest: planStateVersion(tree, branchTree, baseTree),
    ...(document ? { document } : {}),
    ...(problem ? { problem } : {}),
    draft: !!draftTree,
    conflict: !!draftTree && branchTree !== baseTree && draftTree !== branchTree,
    ...(branchTree ? { branchTree } : {}),
    ...(baseTree ? { baseTree } : {}),
    ...(approval ? { approval } : {}),
  };
}
export function readPlan(root: string, identity: PlanIdentity, saved = savedPlanTrees(root)): PlanView {
  const input = planRead(root, identity, saved);
  return planView(input, readGitObjects(root, planRequests(input)));
}
export function readPlans(root: string): PlanView[] {
  const saved = savedPlanTrees(root),
    refs = new Map(
      gitBytes(root, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        planningPaths.drafts,
        planningPaths.bases,
        planningPaths.removals,
      ])
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((row) => {
          const pair = row.split(" ");
          return [pair[0] ?? "", pair[1] ?? ""] as const;
        }),
    );
  const identities = new Map([...saved].map(([reference, item]) => [reference, item.identity]));
  for (const ref of refs.keys())
    if (ref.startsWith(planningPaths.drafts)) {
      const [scope, name, ...rest] = ref.slice(planningPaths.drafts.length).split("/");
      if (!scope || !name || rest.length) throw new InvalidInput("Invalid plan draft reference");
      const identity = planIdentity(scope, name);
      identities.set(identity.reference, identity);
    }
  for (const ref of refs.keys())
    if (ref.startsWith(planningPaths.removals)) {
      const [scope, name, ...rest] = ref.slice(planningPaths.removals.length).split("/");
      if (!scope || !name || rest.length) throw new InvalidInput("Invalid removed plan reference");
      identities.delete(planIdentity(scope, name).reference);
    }
  const inputs = [...identities.values()].map((identity) => planRead(root, identity, saved, refs)),
    objects = readGitObjects(root, inputs.flatMap(planRequests), 2 * 1024 * 1024, { retainedBytes: 64 * 1024 * 1024 });
  return inputs
    .map((input) => planView(input, objects))
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}
