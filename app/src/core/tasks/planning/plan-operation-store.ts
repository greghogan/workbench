import { decodeTransferData, decodeRenameData, type TransferData, type RenameData } from "./plan-operation-data.js";
import { gitRevision } from "../../git/refs.js";
import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import {
  gitBytes,
  readGitObjects,
  readGitTree,
  updatedReviewTree,
  writeReviewBlobs,
  type GitEntry,
} from "../../git/git-snapshot.js";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { record, string } from "../../runtime/values.mjs";
import { parsePlanReference, planningPaths, safePlanFile } from "./plan-model.js";

interface OperationBase {
  version: 1;
  id: string;
  checkout: string;
  completed: boolean;
}
export type PlanOperation = OperationBase &
  ({ kind: "transfer"; payload: TransferData } | { kind: "rename"; payload: RenameData });
export interface StoredPlanOperation {
  ref: string;
  tree: string;
  operation: PlanOperation;
}
const metadataPath = "operation.json",
  limit = 4 * 1024 * 1024;
function decode(value: unknown, ref: string): PlanOperation {
  const input = record(value, "Invalid planning operation"),
    id = string(input.id, "Missing planning operation ID");
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
    ref !== planningPaths.operations + id ||
    input.version !== 1 ||
    !["transfer", "rename"].includes(String(input.kind)) ||
    typeof input.completed !== "boolean" ||
    Object.keys(input).some((key) => !["version", "id", "kind", "checkout", "completed", "payload"].includes(key))
  )
    throw new InvalidInput("Invalid planning operation identity or version");
  const checkout = string(input.checkout, "Missing planning checkout");
  if (!isAbsolute(checkout) || /[\0\r\n]/.test(checkout)) throw new InvalidInput("Invalid planning checkout");
  return {
    version: 1,
    id,
    checkout,
    completed: input.completed,
    ...(input.kind === "transfer"
      ? { kind: "transfer" as const, payload: decodeTransferData(input.payload) }
      : { kind: "rename" as const, payload: decodeRenameData(input.payload) }),
  };
}
export function readPlanOperations(root: string): StoredPlanOperation[] {
  const rows = gitBytes(root, ["for-each-ref", "--format=%(refname) %(objectname)", planningPaths.operations])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  if (rows.length > 1000)
    throw new InvalidInput("Too many unfinished planning operations; finish existing transfers before starting more");
  const refs = rows.map((row) => {
    const [ref, tree] = row.split(" ");
    if (!ref || !tree) throw new InvalidInput("Invalid planning operation reference");
    const entry = readGitTree(root, tree).get(metadataPath);
    if (entry?.mode !== "100644") throw new InvalidInput("Planning recovery metadata is missing");
    return { ref, tree, entry };
  });
  const objects = readGitObjects(
    root,
    refs.map(({ entry }) => entry.oid),
    limit,
    { retainedBytes: 16 * 1024 * 1024 },
  );
  return refs.map(({ ref, tree, entry }) => {
    const contents = objects.get(entry.oid);
    if (!contents) throw new InvalidInput("Planning operation metadata is unavailable");
    return { ref, tree, operation: decode(JSON.parse(contents.toString()) as unknown, ref) };
  });
}
/** One ref activates the complete immutable recovery payload and its supporting Git trees. */
export function writePlanOperation(
  root: string,
  operation: PlanOperation,
  attachments: ReadonlyMap<string, GitEntry> = new Map(),
  expected?: string,
): StoredPlanOperation {
  const ref = planningPaths.operations + operation.id,
    checked = decode(operation, ref),
    contents = JSON.stringify(checked) + "\n";
  if (Buffer.byteLength(contents) > limit)
    throw new InvalidInput("Planning operation exceeds the recovery metadata limit");
  if (attachments.has(metadataPath)) throw new InvalidInput("Planning payload cannot replace its operation metadata");
  const body = writeReviewBlobs(root, [Buffer.from(contents)])[0];
  if (!body) throw new InvalidInput("Cannot retain planning recovery metadata");
  const tree = updatedReviewTree(
    root,
    expected ?? "",
    [...attachments]
      .map(([path, entry]) => ({ path, entry }))
      .concat([{ path: metadataPath, entry: { mode: "100644", oid: body } }]),
  );
  try {
    gitBytes(root, ["update-ref", "--create-reflog", ref, tree, expected ?? "0".repeat(tree.length)]);
  } catch (cause) {
    if (gitRevision(root, ref) !== expected)
      throw new StateConflict("The planning operation changed before activation; inspect its current status", {
        cause,
      });
    throw cause;
  }
  return { ref, tree, operation: checked };
}
export function removePlanOperation(root: string, stored: StoredPlanOperation): void {
  if (stored.ref !== planningPaths.operations + stored.operation.id)
    throw new StateConflict("Planning recovery ownership differs");
  gitBytes(root, ["update-ref", "-d", stored.ref, stored.tree]);
}
export interface PlanClaim {
  operation: StoredPlanOperation;
  reference: string;
  task: string;
}
export function planClaims(root: string): PlanClaim[] {
  const claims: PlanClaim[] = [],
    names = new Set<string>();
  for (const stored of readPlanOperations(root)) {
    if (stored.operation.kind !== "transfer") continue;
    for (const plan of stored.operation.payload.plans) {
      const reference = plan.reference,
        task = plan.task;
      parsePlanReference(reference);
      if (!/^[a-z][a-z0-9_-]*:TSK-[0-9A-Z]+$/.test(task) || names.has(reference))
        throw new InvalidInput("Invalid or repeated implementation claim");
      names.add(reference);
      claims.push({ operation: stored, reference, task });
    }
  }
  return claims;
}
export function planClaim(root: string, reference: string): PlanClaim | undefined {
  parsePlanReference(reference);
  return planClaims(root).find((claim) => claim.reference === reference);
}

/** Preserve the intended Git mode before an unstaged handoff can be represented in an index. */
export function transferredFileModes(root: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const stored of readPlanOperations(root)) {
    if (stored.operation.kind !== "transfer" || stored.operation.checkout !== realpathSync.native(root)) continue;
    const captured = readGitTree(root, stored.tree);
    for (const file of stored.operation.payload.files) {
      const path = file.path,
        entry = captured.get("files/" + path);
      if (
        !safePlanFile(path) ||
        entry?.mode !== file.mode ||
        entry.oid !== file.oid ||
        !["100644", "100755"].includes(entry.mode) ||
        modes.has(path)
      )
        throw new StateConflict("Conflicting or invalid transferred file modes");
      modes.set(path, entry.mode);
    }
  }
  return modes;
}
