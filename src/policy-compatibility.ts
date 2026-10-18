import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { decisionScopes } from "./decisions.js";
import { hasCollectionProject, localCollectionDirectories, resolveLocalCollections } from "./collections.js";
import { bytesHash, collectionBytes, collectionWorkingFiles, policyFilesHash } from "./collection-files.js";
import { userDirectory } from "./storage.js";
import { writeAtomic } from "./core.js";
import { localContextFresh } from "./local-context.js";
import { withCacheLockSync } from "./cache-lock.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Fingerprint current authoritative records, not their upstream pins or generated summaries. */
export function projectPolicyFingerprint(root: string): string {
  if (!hasCollectionProject(root)) return hash([]);
  return hash(
    decisionScopes(root, false)
      .map((scope) => ({
        id: scope.project.id,
        scopes: scope.appliesTo,
        charter:
          !scope.shared && existsSync(join(scope.directory, "workbench/CHARTER.md"))
            ? bytesHash(collectionBytes(scope.directory, "workbench/CHARTER.md"))
            : null,
        records: existsSync(join(scope.recordsDirectory, "decisions"))
          ? policyFilesHash(collectionWorkingFiles(join(scope.recordsDirectory, "decisions")))
          : hash([]),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

export function policyCompatibility(root: string, localRoot = root) {
  const local = resolveLocalCollections(localRoot);
  const sources = local
    .map((entry) => ({ id: entry.pin.id, directory: entry.directory, digest: policyFilesHash(entry.files) }))
    .sort((a, b) => a.directory.localeCompare(b.directory));
  const conflicts: string[] = [];
  const seen = new Map<string, string>();
  const projects = hasCollectionProject(root) ? decisionScopes(root, false) : [];
  for (const source of sources) {
    if (seen.has(source.id) && seen.get(source.id) !== source.digest)
      conflicts.push(`different local copies use namespace '${source.id}'`);
    seen.set(source.id, source.digest);
    const project = projects.find((scope) => scope.project.id === source.id);
    if (
      project &&
      (!project.shared ||
        project.appliesTo.length !== 1 ||
        project.appliesTo[0] !== "." ||
        policyFilesHash(collectionWorkingFiles(project.recordsDirectory)) !== source.digest)
    )
      conflicts.push(`local and project records collide in namespace '${source.id}'; reconcile their adopted copies`);
  }
  const project = projectPolicyFingerprint(root);
  const localDigest = hash([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const digest = hash({ project, local: localDigest });
  const receipt =
    process.env.WORKBENCH_COLLECTIONS_MATERIALIZED === "1"
      ? join(localRoot, "workbench/.collections/compatibility.json")
      : join(
          userDirectory("state"),
          "policy-reviews",
          hash(
            realpathSync(
              process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1"
                ? (process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root)
                : localRoot,
            ),
          ),
          "receipt.json",
        );
  const staleContexts = sources.length
    ? localCollectionDirectories(localRoot).filter(
        (base) => existsSync(join(base, "index.toml")) && !localContextFresh(base),
      )
    : [];
  let current = false;
  if (existsSync(receipt)) {
    const saved = JSON.parse(readFileSync(receipt, "utf8")) as { digest?: unknown; reviewed?: unknown };
    current = saved.digest === digest && saved.reviewed === true;
  }
  const inherited = process.env.WORKBENCH_POLICY_REVIEW;
  if (inherited) {
    const claim = JSON.parse(inherited) as { project?: unknown; locals?: unknown; reviewed?: unknown };
    if (!Array.isArray(claim.locals) || claim.reviewed !== true || typeof claim.project !== "string")
      throw new Error("invalid inherited policy review");
    const claimed = new Map<string, string>();
    for (const entry of claim.locals as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string")
        throw new Error("invalid inherited policy review");
      if (claimed.has(entry[0]) && claimed.get(entry[0]) !== entry[1])
        throw new Error("conflicting inherited policy review");
      claimed.set(entry[0], entry[1]);
    }
    const managed =
      process.env.WORKBENCH_DISTRIBUTION_MATERIALIZED === "1" || process.env.WORKBENCH_DEVCONTAINER === "1";
    if (
      claim.project === project &&
      (managed || claimed.size === seen.size) &&
      sources.every((source) => claimed.get(source.id) === source.digest)
    )
      current = true;
  }
  return {
    status: conflicts.length
      ? "conflict"
      : staleContexts.length
        ? "stale-context"
        : !sources.length
          ? "not-required"
          : current
            ? "current"
            : "review-required",
    digest,
    project,
    local: localDigest,
    sources,
    project_sources: projects.map((scope) => ({
      id: scope.project.id,
      scopes: scope.appliesTo,
      decision_map: join(scope.recordsDirectory, "decision-map.md"),
    })),
    conflicts,
    stale_contexts: staleContexts,
    receipt,
  };
}

/** This acknowledges a performed review; arbitrary policy prose cannot be certified by static validation. */
export function acknowledgePolicyCompatibility(
  root: string,
  expected: string,
  reviewed: boolean,
  localRoot = root,
): void {
  if (!reviewed)
    throw new Error("acknowledgment requires --reviewed after checking both policy sets for compatibility");
  const status = policyCompatibility(root, localRoot);
  withCacheLockSync(status.receipt, () => {
    const current = policyCompatibility(root, localRoot);
    if (current.digest !== expected) throw new Error("policy contents changed; review compatibility again");
    if (current.conflicts.length || current.stale_contexts.length)
      throw new Error("resolve policy collisions and refresh local contexts before acknowledgment");
    if (current.status === "not-required") throw new Error("no active local collections require compatibility review");
    writeAtomic(
      current.receipt,
      JSON.stringify(
        {
          digest: current.digest,
          project: current.project,
          local: current.local,
          sources: current.sources,
          reviewed: true,
          reviewed_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  });
}

export function checkPolicyCompatibility(root: string, localRoot = root): void {
  if (!resolveLocalCollections(localRoot).length) return;
  const status = policyCompatibility(root, localRoot);
  if (status.status === "current" || status.status === "not-required") return;
  throw new Error(
    `local/project policy compatibility is ${status.status}: ${[...status.conflicts, ...status.stale_contexts.map((base) => `refresh ${base}/AGENTS.md using collection local sync`)].join("; ") || "review both policy sets"}. Inspect 'workbench collection compatibility' and acknowledge its digest after review; use --staged for proposed commits. Agents may perform this review; refer conflicts to the human.`,
  );
}

/** Carry the performed host review across managed process boundaries, retaining exact project and local contents. */
export function policyExecutionEnvironment(root: string): NodeJS.ProcessEnv {
  if (!resolveLocalCollections(root).length) return {};
  const status = policyCompatibility(root);
  if (status.status !== "current") checkPolicyCompatibility(root);
  return {
    WORKBENCH_POLICY_REVIEW: JSON.stringify({
      project: status.project,
      locals: [...new Map(status.sources.map((source) => [source.id, source.digest]))],
      reviewed: true,
    }),
  };
}
