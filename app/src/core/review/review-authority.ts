import { gitBytes, GitSnapshot } from "../git/git-snapshot.js";
import { repositoryStatePath } from "../git/repository-state.js";
import { gitAncestor, gitRevision } from "../git/refs.js";
import { provisionalMessage } from "../git/commit-history.js";
import { proposedRecordTrees } from "../records/staged-records.js";
import { BoundedState } from "../storage/bounded-state.js";
import { withCacheLockSync } from "../storage/cache-lock.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { record, records, string } from "../runtime/values.mjs";
import { reviewChangeDigest } from "./review-snapshot.js";

interface HistoryAuthority {
  base: string;
  source: string;
}
const oid = (value: unknown) => {
  const result = string(value, "Missing review authority revision");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result)) throw new InvalidInput("Invalid review authority revision");
  return result;
};
function store(root: string) {
  const path = repositoryStatePath(root, "review-authority.json");
  return {
    path,
    state: new BoundedState<{ version: 1; entries: HistoryAuthority[] }>(
      () => path,
      4 * 1024 * 1024,
      (input) => {
        const value = record(input, "Invalid accepted-history authority");
        if (value.version !== 1 || Object.keys(value).some((key) => !["version", "entries"].includes(key)))
          throw new InvalidInput("Unsupported accepted-history authority");
        const entries = records(value.entries, "Invalid accepted comparisons").map((entry) => ({
          base: oid(entry.base),
          source: oid(entry.source),
        }));
        if (entries.length > 4096 || new Set(entries.map((entry) => JSON.stringify(entry))).size !== entries.length)
          throw new InvalidInput("Duplicate or excessive accepted comparisons");
        return { version: 1, entries };
      },
      () => ({ version: 1, entries: [] }),
    ),
  };
}
export const reviewAuthorityPath = (root: string): string => store(root).path;
interface AuthorityContext {
  changes: Set<string>;
  base: string;
  tree: string;
}
const cache = new Map<string, AuthorityContext>();
function context(root: string, base: string, source: string): AuthorityContext {
  const key = JSON.stringify([root, base, source]),
    saved = cache.get(key);
  if (saved) return saved;
  const message = gitBytes(root, ["show", "--no-show-signature", "-s", "--format=%B", source]).toString();
  if (provisionalMessage(root, message) || !gitAncestor(root, base, source))
    throw new InvalidInput("Review authority requires accepted descendant history");
  const snapshot = new GitSnapshot(root, { base, tree: source }),
    [after, before] = proposedRecordTrees(root, snapshot),
    changes = new Set<string>();
  const zero = "0".repeat(source.length);
  for (const path of new Set([...(before?.entries.keys() ?? []), ...(after?.entries.keys() ?? [])])) {
    const old = before?.entries.get(path),
      next = after?.entries.get(path),
      a = old ? `${old.mode}:${old.oid}` : `000000:${zero}`,
      b = next ? `${next.mode}:${next.oid}` : `000000:${zero}`;
    if (a !== b && (before?.classify(path).protected || after?.classify(path).protected))
      changes.add(
        reviewChangeDigest({
          path,
          before: a,
          after: b,
          charter: before?.classify(path).charter === true || after?.classify(path).charter === true,
        }),
      );
  }
  const result = {
    changes,
    base: gitBytes(root, ["rev-parse", `${base}^{tree}`])
      .toString()
      .trim(),
    tree: gitBytes(root, ["rev-parse", `${source}^{tree}`])
      .toString()
      .trim(),
  };
  if (cache.size >= 32) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, result);
  return result;
}
export function acceptedComparisonDigests(root: string): Set<string> {
  return new Set(
    store(root)
      .state.read()
      .entries.flatMap((entry) => [...context(root, entry.base, entry.source).changes]),
  );
}
export function acceptedAgentContext(root: string, base: string, tree: string): boolean {
  return store(root)
    .state.read()
    .entries.some((entry) => {
      const proof = context(root, entry.base, entry.source);
      return proof.base === base && proof.tree === tree;
    });
}
/** Accepted Git history supplies authority, without inventing a human acknowledgment or its date. */
export function retainReviewAuthority(root: string, base: string, source: string): void {
  context(root, base, source);
  const target = store(root);
  gitBytes(root, ["update-ref", `refs/workbench/review-authority/${source}`, source]);
  withCacheLockSync(
    target.path,
    () => {
      const current = target.state.read();
      if (!current.entries.some((entry) => entry.base === base && entry.source === source))
        current.entries.push({ base, source });
      target.state.write(current);
    },
    0,
  );
}

export function pruneReviewAuthority(root: string, changes: ReadonlySet<string>, projects: ReadonlySet<string>): void {
  const target = store(root);
  withCacheLockSync(
    target.path,
    () => {
      const state = target.state.read();
      if (!state.entries.length) return;
      const entries = state.entries.filter((entry) => {
        const proof = context(root, entry.base, entry.source);
        return (
          projects.has(JSON.stringify([proof.base, proof.tree])) ||
          [...proof.changes].some((digest) => changes.has(digest))
        );
      });
      target.state.write({ version: 1, entries });
      const retained = new Set(entries.map((entry) => entry.source));
      for (const source of new Set(state.entries.map((entry) => entry.source))) {
        const ref = `refs/workbench/review-authority/${source}`;
        if (!retained.has(source) && gitRevision(root, ref) === source)
          gitBytes(root, ["update-ref", "-d", ref, source]);
      }
    },
    0,
  );
}
