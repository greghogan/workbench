import { spawnSync } from "node:child_process";
import { StateConflict } from "../runtime/input-errors.js";
import { commitVersion } from "../review/review-units.js";
import { provisionalTrailer, removeProvisionalTrailer } from "./commit-history.js";
import { runGitSigner, signatureKey, trustedCommitSignature, verifiedSignatureKey } from "./signatures.js";
import { gitEnvironment } from "../distribution/update-git.js";

const authorHeader = /^(.* <[^<>]*>) (\d+ [+-]\d{4})$/;

export function configuredCommitAuthor(root: string): string | undefined {
  const env = gitEnvironment();
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "EMAIL"])
    Reflect.deleteProperty(env, key);
  const identity = spawnSync("git", ["-C", root, "-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"], {
    encoding: "utf8",
    env,
  });
  return !identity.error && identity.status === 0 ? authorHeader.exec(identity.stdout.trimEnd())?.[1] : undefined;
}

export function isConfiguredCommitAuthor(author: string, configured: string | undefined): boolean {
  return configured !== undefined && authorHeader.exec(author)?.[1] === configured;
}

export function commitSigningEnabled(root: string): boolean {
  const setting = spawnSync("git", ["-C", root, "config", "--bool", "--get", "commit.gpgSign"], { encoding: "utf8" });
  if (setting.error || (setting.status !== 0 && setting.status !== 1))
    throw new StateConflict("Cannot inspect commit signing policy");
  return setting.stdout.trim() === "true";
}

export enum RewriteSigning {
  Configured = "configured",
  Opportunistic = "opportunistic",
  Required = "required",
  Unsigned = "unsigned",
}

/** Replacement commits retain the original author and committer dates. */
export function rewriteCommit(
  root: string,
  revision: string,
  parents: string[],
  provisional: boolean,
  signing = RewriteSigning.Configured,
  configuredAuthor?: string | null,
): string {
  const unit = commitVersion(root, revision),
    author = /^(.*) <([^<>]*)> (\d+ [+-]\d{4})$/.exec(unit.author);
  if (!author) throw new StateConflict("Cannot preserve the commit author");
  if (unit.embeddedMergeTag)
    throw new StateConflict(`Rewriting ${revision.slice(0, 12)} would remove a signed merge tag`);
  const requested =
    signing === RewriteSigning.Required ||
    (signing === RewriteSigning.Opportunistic && unit.signed) ||
    (signing !== RewriteSigning.Unsigned && commitSigningEnabled(root));
  const owned =
    (requested || unit.signed) &&
    isConfiguredCommitAuthor(
      unit.author,
      configuredAuthor === undefined ? configuredCommitAuthor(root) : (configuredAuthor ?? undefined),
    );
  if (!owned && (unit.signed || signing === RewriteSigning.Required))
    throw new StateConflict(`The author of ${revision.slice(0, 12)} differs from the configured Git author`);
  if (unit.signed && signing === RewriteSigning.Configured && !requested)
    throw new StateConflict("Enable commit.gpgSign before rewriting a signed commit");
  const opportunistic = signing === RewriteSigning.Opportunistic;
  const signer = unit.signed
    ? signing === RewriteSigning.Configured
      ? verifiedSignatureKey(root, "commit", revision)
      : opportunistic
        ? signatureKey(root, "commit", revision)
        : undefined
    : undefined;
  const sign = requested && owned && (!opportunistic || !unit.signed || signer !== undefined);
  const message = provisional
    ? unit.provisional
      ? unit.message
      : unit.message.trimEnd() + `\n\n${provisionalTrailer}: true\n`
    : unit.provisional
      ? removeProvisionalTrailer(root, unit.message)
      : unit.message;
  const cmd = ["-C", root, "commit-tree", unit.tree, ...parents.flatMap((parent) => ["-p", parent])];
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author[1],
    GIT_AUTHOR_EMAIL: author[2],
    GIT_AUTHOR_DATE: author[3],
    GIT_COMMITTER_DATE: unit.committerDate,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const prepare = (signed: boolean) =>
    signed
      ? runGitSigner((path) => [...cmd, "-S", "-F", path], message, env)
      : spawnSync("git", [...cmd, "--no-gpg-sign"], {
          encoding: "utf8",
          input: message,
          env,
          maxBuffer: 1024 * 1024,
        });
  const attempt = prepare(sign);
  const result =
    sign &&
    opportunistic &&
    !attempt.error &&
    attempt.status !== null &&
    attempt.status !== 130 &&
    (attempt.status !== 0 ||
      !trustedCommitSignature(root, attempt.stdout.trim()) ||
      (signer !== undefined && signatureKey(root, "commit", attempt.stdout.trim()) !== signer))
      ? prepare(false)
      : attempt;
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result.stdout.trim()))
    throw new StateConflict("Cannot prepare rewritten commit", {
      cause:
        result.error ?? new Error(sign && process.stdin.isTTY ? "Git did not complete signing" : result.stderr.trim()),
    });
  const after = result.stdout.trim();
  if (!opportunistic && signer && verifiedSignatureKey(root, "commit", after) !== signer)
    throw new StateConflict(`${revision.slice(0, 12)} would replace another signing key`);
  if (commitVersion(root, after).provisional !== provisional)
    throw new StateConflict("The rewritten commit has an unexpected review marker");
  return after;
}
