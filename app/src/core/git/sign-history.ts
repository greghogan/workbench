import { randomUUID } from "node:crypto";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { commitVersion } from "../review/review-units.js";
import { configuredCommitAuthor, isConfiguredCommitAuthor, rewriteCommit, RewriteSigning } from "./commit-writing.js";
import {
  activeGitOperation,
  activatePreparedRefs,
  checkFinalizationCheckouts,
  decodeRefMoves,
  finalizationBranch,
  finalizationRefs,
  finalizationTagContents,
  protectRewriteObjects,
  reportRefRecovery,
  retargetFinalizationTag,
  rewriteCheckout,
  rewriteRevision,
  type PreparedRefMove,
} from "./finalization-refs.js";
import { gitBytes } from "./git-snapshot.js";
import { gitRevision } from "./refs.js";
import { repositoryStatePath, withRepositoryOperation } from "./repository-state.js";
import { checkSigningTags, signingPublication } from "./signing-publication.js";
import { trustedCommitSignature, verifiedSignatureKey } from "./signatures.js";
import { BoundedState } from "../storage/bounded-state.js";
import { record, string, strings } from "../runtime/values.mjs";

interface SigningOperation {
  version: 1;
  checkout: string;
  completed: boolean;
  recovery: string;
  originals: string[];
  moves: PreparedRefMove[];
  signed: number;
  otherAuthors: number;
}

interface SigningResult {
  signed: number;
  otherAuthors: number;
  updated: string[];
  recovery?: string;
}

function signingStore(root: string) {
  return new BoundedState<SigningOperation | undefined>(
    () => repositoryStatePath(root, "signing-operation.json"),
    4 * 1024 * 1024,
    (value) => {
      if (value === undefined) return undefined;
      const data = record(value, "Invalid signing operation"),
        checkout = string(data.checkout, "Missing signing checkout"),
        recovery = string(data.recovery, "Missing signing recovery reference"),
        originals = strings(data.originals, "Invalid original signing objects").map(rewriteRevision),
        moves = decodeRefMoves(data.moves),
        { signed, otherAuthors } = data;
      if (
        data.version !== 1 ||
        typeof data.completed !== "boolean" ||
        !/^refs\/workbench\/recovery\/[a-f0-9-]{36}$/.test(recovery) ||
        !originals.length ||
        !moves.length ||
        typeof signed !== "number" ||
        !Number.isSafeInteger(signed) ||
        signed < 1 ||
        signed > originals.length ||
        typeof otherAuthors !== "number" ||
        !Number.isSafeInteger(otherAuthors) ||
        otherAuthors < 0
      )
        throw new InvalidInput("Invalid signing operation");
      return { version: 1, checkout, completed: data.completed, recovery, originals, moves, signed, otherAuthors };
    },
    () => undefined,
  );
}

function selectedRef(root: string, selector: string | undefined): string {
  if (selector === undefined) {
    const branch = finalizationBranch(root);
    if (!branch) throw new InvalidInput("Switch to a local branch or name a branch or tag to sign");
    return branch;
  }
  const names = selector.startsWith("refs/") ? [selector] : [`refs/heads/${selector}`, `refs/tags/${selector}`];
  const matches = names.filter((name) => {
    if (!/^refs\/(?:heads|tags)\//.test(name) || /[~^:?*[\s\\]/.test(name) || name.includes("@{")) return false;
    return gitRevision(root, name) !== undefined;
  });
  const selected = matches[0];
  if (matches.length > 1) throw new InvalidInput("Name the branch or tag with refs/heads/ or refs/tags/");
  if (!selected) throw new InvalidInput(`No local branch or tag named ${selector}`);
  return selected;
}

function history(root: string, tips: readonly string[], published: readonly string[]) {
  const input = [...new Set(tips), ...published.map((oid) => `^${oid}`)].join("\n") + "\n";
  return gitBytes(root, ["rev-list", "--topo-order", "--reverse", "--parents", "--stdin"], input)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [revision, ...parents] = row.split(" ");
      if (!revision) throw new InvalidInput("Git returned an invalid signing history");
      return { revision, parents };
    });
}

function activateSigning(root: string, operation: SigningOperation, recovering = true) {
  const updated = operation.moves.map((move) => move.name);
  const partial = activatePreparedRefs(root, operation.moves, recovering, () => {
    if (recovering) {
      const publication = signingPublication(root);
      checkSigningTags(publication, updated);
      if (publication.commits.length) {
        const unpublished = new Set(
          history(
            root,
            operation.moves.map((move) => move.before),
            publication.commits,
          ).map(({ revision }) => revision),
        );
        const published = operation.originals.find((oid) => !unpublished.has(oid));
        if (published) throw new StateConflict(`Preserve published history at ${published.slice(0, 12)}`);
      }
      const unexpected = finalizationRefs(root, operation.originals).find(({ name }) => !updated.includes(name));
      if (unexpected) throw new StateConflict(`New affected Git reference: ${unexpected.name}`);
    } else signingStore(root).write(operation);
  });
  signingStore(root).write({ ...operation, completed: true });
  if (recovering) reportRefRecovery("signing", partial);
  return { signed: operation.signed, otherAuthors: operation.otherAuthors, updated, recovery: operation.recovery };
}

export function resumePreparedSigning(root: string) {
  const previous = signingStore(root).read();
  if (!previous || previous.completed) return undefined;
  return withRepositoryOperation(
    root,
    () => {
      const operation = signingStore(root).read();
      return operation && !operation.completed
        ? activateSigning(rewriteCheckout(root, operation.checkout), operation)
        : undefined;
    },
    "signing",
  );
}

/** Best-effort signing after Git's normal commit hooks, restricted to the commit just created. */
export function signCreatedCommit(
  root: string,
  branch: string,
  tree: string,
  parents: readonly string[],
  message: string,
): string | undefined {
  return withRepositoryOperation(
    root,
    () => {
      if (finalizationBranch(root) !== branch || activeGitOperation(root)) return;
      const head = gitRevision(root, branch);
      if (!head) return;
      const commit = commitVersion(root, head);
      if (
        commit.signed ||
        commit.tree !== tree ||
        commit.parents.join(" ") !== parents.join(" ") ||
        commit.message !== gitBytes(root, ["stripspace"], message).toString()
      )
        return;
      const privateBranch = () => {
        const [ref, ...others] = finalizationRefs(root, [head]);
        return (
          ref?.name === branch &&
          !others.length &&
          !gitBytes(root, ["for-each-ref", `--contains=${head}`, "--format=%(refname)", "refs/remotes"])
            .toString()
            .trim()
        );
      };
      if (!privateBranch()) return;
      const replacement = rewriteCommit(root, head, commit.parents, commit.provisional, RewriteSigning.Opportunistic);
      const rewritten = commitVersion(root, replacement);
      if (
        !rewritten.signed ||
        rewritten.message !== commit.message ||
        rewritten.tree !== commit.tree ||
        rewritten.author !== commit.author ||
        rewritten.committerDate !== commit.committerDate ||
        rewritten.parents.join(" ") !== commit.parents.join(" ")
      )
        return;
      if (finalizationBranch(root) !== branch || activeGitOperation(root) || !privateBranch()) return;
      gitBytes(root, ["update-ref", "-m", "workbench: sign newly created commit", branch, replacement, head]);
      return replacement;
    },
    "signing",
  );
}

/** Prepare a complete, verified replacement before a single ref transaction makes it visible. */
export function signHistory(root: string, selector?: string): SigningResult {
  return withRepositoryOperation(
    root,
    () => {
      const previous = signingStore(root).read();
      if (previous && !previous.completed) return activateSigning(rewriteCheckout(root, previous.checkout), previous);
      const source = selectedRef(root, selector),
        tip = gitRevision(root, `${source}^{commit}`);
      if (!tip) throw new InvalidInput(`${source} does not name a commit`);
      const publication = signingPublication(root);
      const unsigned = history(root, [tip], publication.commits)
        .map(({ revision }) => commitVersion(root, revision))
        .filter((commit) => !commit.signed);
      const author = configuredCommitAuthor(root);
      if (unsigned.length && !author) throw new InvalidInput("Configure your Git author name and email before signing");
      const selected = new Set(
        unsigned.filter((commit) => isConfiguredCommitAuthor(commit.author, author)).map((commit) => commit.revision),
      );
      const otherAuthors = unsigned.length - selected.size;
      if (!selected.size) return { signed: 0, otherAuthors, updated: [] };
      const references = finalizationRefs(root, [...selected]);
      checkSigningTags(
        publication,
        references.map((ref) => ref.name),
      );
      checkFinalizationCheckouts(root, new Set(references.map((ref) => ref.name)));
      const annotations = references.map((ref) => ({ ref, tags: finalizationTagContents(root, ref) }));
      const affected = new Set<string>();
      const commits = history(
        root,
        references.map((ref) => ref.target),
        publication.commits,
      ).flatMap(({ revision, parents }) => {
        if (!selected.has(revision) && !parents.some((parent) => affected.has(parent))) return [];
        const commit = commitVersion(root, revision);
        if (commit.signed && !isConfiguredCommitAuthor(commit.author, author))
          throw new StateConflict(`${revision.slice(0, 12)} needs its author's signature after reparenting`);
        affected.add(revision);
        return [{ commit, signer: commit.signed ? verifiedSignatureKey(root, "commit", revision) : undefined }];
      });
      const recovery = `refs/workbench/recovery/${randomUUID()}`;
      const retained = new Map(references.map((ref) => [`before-refs/${ref.name}`, ref.before]));
      const replacements = new Map<string, string>();
      for (const { commit, signer } of commits) {
        const parents = commit.parents.map((parent) => replacements.get(parent) ?? parent);
        const signing = signer || selected.has(commit.revision) ? RewriteSigning.Required : RewriteSigning.Unsigned;
        const after = rewriteCommit(root, commit.revision, parents, commit.provisional, signing, author ?? null);
        const key = signing === RewriteSigning.Required ? verifiedSignatureKey(root, "commit", after) : undefined;
        if (key && !trustedCommitSignature(root, after))
          throw new StateConflict(`Git does not trust the signature for ${commit.revision.slice(0, 12)}`);
        if (signer && key !== signer)
          throw new StateConflict(`${commit.revision.slice(0, 12)} would replace another signing key`);
        const result = commitVersion(root, after);
        if (
          result.message !== commit.message ||
          result.tree !== commit.tree ||
          result.author !== commit.author ||
          result.committerDate !== commit.committerDate ||
          result.parents.join(" ") !== parents.join(" ")
        )
          throw new StateConflict(
            `Signing changed the contents, authorship, or date of ${commit.revision.slice(0, 12)}`,
          );
        retained.set(`prepared/${commit.revision}`, after);
        replacements.set(commit.revision, after);
      }
      const moves = annotations.map(({ ref, tags }) => {
        const replacement = replacements.get(ref.target);
        if (!replacement) throw new StateConflict(`Signing could not preserve ${ref.name}`);
        const after = retargetFinalizationTag(root, tags, replacement, (oid) => {
          retained.set(`prepared-tags/${oid}`, oid);
        });
        return { name: ref.name, before: ref.before, after };
      });
      const latest = signingPublication(root);
      if (
        JSON.stringify(latest.observations) !== JSON.stringify(publication.observations) ||
        JSON.stringify(finalizationRefs(root, [...selected])) !== JSON.stringify(references)
      )
        throw new StateConflict("Git references changed during signing. Inspect the current references and retry.");
      checkSigningTags(
        latest,
        references.map((ref) => ref.name),
      );
      protectRewriteObjects(root, recovery, retained);
      return activateSigning(
        root,
        {
          version: 1,
          checkout: root,
          completed: false,
          recovery,
          originals: [...replacements.keys()],
          moves,
          signed: selected.size,
          otherAuthors,
        },
        false,
      );
    },
    "signing",
  );
}
