import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import { captureCommittedReview, commitVersion, pendingCommitReviews } from "../../../src/core/review/review-units.ts";
import { approveCapturedReviews } from "../../../src/core/review/review-service.ts";
import { finalizationPlan, finalizeHistory } from "../../../src/core/git/finalization.ts";
import {
  pendingFinalizationStatus,
  queueFinalization,
  resumeFinalization,
} from "../../../src/core/git/finalization-requests.ts";
import { unsignedTagPayload, verifiedSignatureKey } from "../../../src/core/git/signatures.ts";
import { gitBytes } from "../../../src/core/git/git-snapshot.ts";
import { reviewUnitFixture } from "../../fixtures/review-units.mjs";

const { fixture } = reviewUnitFixture();

test("unattended finalization retains an unsigned result when the repository signer needs a terminal", () => {
  const f = fixture(),
    prior = f.commit("Reviewed policy");
  f.agent(prior);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, prior).captured, false);
  git(f.root, "config", "commit.gpgSign", "true");
  git(f.root, "config", "gpg.program", join(f.root, "interactive-signing-only"));
  queueFinalization(f.root, { revision: prior });
  resumeFinalization(f.root);
  expect(commitVersion(f.root, "HEAD")).toMatchObject({
    tree: commitVersion(f.root, prior).tree,
    signed: false,
    provisional: false,
  });
  expect(pendingCommitReviews(f.root)).toEqual([]);
  expect(pendingFinalizationStatus(f.root)).toBeUndefined();
});

test.for(["terminal", "background", "unavailable key", "different key", "foreign author"] as const)(
  "finalization preserves reviewed content and signed recovery history with %s",
  (mode, { skip }) => {
    const f = fixture();
    const key = (name: string) => {
      const file = join(f.root, ".git", name),
        generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { encoding: "utf8" });
      if (generated.error && (generated.error as NodeJS.ErrnoException).code === "ENOENT")
        skip("OpenSSH signing is unavailable on this host");
      expect(generated.status, generated.stderr).toBe(0);
      return file;
    };
    const original = key("original-key"),
      other = key("other-key"),
      signers = join(f.root, ".git/signers");
    writeFileSync(
      signers,
      [original, other].map((file) => `review@example.invalid ${readFileSync(file + ".pub", "utf8")}`).join(""),
    );
    git(f.root, "config", "gpg.format", "ssh");
    git(f.root, "config", "gpg.ssh.program", "ssh-keygen");
    git(f.root, "config", "gpg.ssh.allowedSignersFile", signers);
    git(f.root, "config", "user.signingkey", original);
    git(f.root, "config", "commit.gpgSign", "false");
    const tagged = f.commit("Reviewed starting point");
    f.agent(tagged);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, tagged).captured, false);
    git(f.root, "tag", "--sign", "--message", "Original annotation\n\nKeep this paragraph.", "reviewed", tagged);
    const tag = git(f.root, "rev-parse", "refs/tags/reviewed"),
      originalPayload = unsignedTagPayload(gitBytes(f.root, ["cat-file", "tag", tag])),
      signer = verifiedSignatureKey(f.root, "tag", tag);
    git(f.root, "config", "commit.gpgSign", "true");
    const signedCommit = f.commit("Reviewed signed successor", true);
    f.agent(signedCommit);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, signedCommit).captured, false);
    if (mode === "unavailable key") git(f.root, "config", "user.signingkey", join(f.root, "missing-key"));
    if (mode === "different key") git(f.root, "config", "user.signingkey", other);
    if (mode === "foreign author") {
      git(f.root, "config", "user.name", "Other Author");
      expect(() => finalizeHistory(f.root, finalizationPlan(f.root).digest, false, true)).toThrow(/tagger.*differs/);
      expect(git(f.root, "rev-parse", "refs/tags/reviewed")).toBe(tag);
      git(f.root, "tag", "-d", "reviewed");
      expect(() => finalizeHistory(f.root, finalizationPlan(f.root).digest, false, true)).toThrow(/author.*differs/);
      expect(git(f.root, "rev-parse", "HEAD")).toBe(signedCommit);
      expect(git(f.root, "for-each-ref", "--format=%(refname)", "refs/workbench/recovery")).toBe("");
      return;
    }
    const final = finalizeHistory(f.root, finalizationPlan(f.root).digest, false, mode === "background"),
      replaced = git(f.root, "rev-parse", "refs/tags/reviewed^{commit}"),
      newTag = git(f.root, "rev-parse", "refs/tags/reviewed");
    expect(replaced).not.toBe(tagged);
    expect(commitVersion(f.root, final.after)).toMatchObject({
      signed: mode === "terminal",
      provisional: false,
      parents: [replaced],
      tree: commitVersion(f.root, signedCommit).tree,
    });
    const replacementTag = gitBytes(f.root, ["cat-file", "tag", newTag]);
    if (mode === "terminal") {
      expect(verifiedSignatureKey(f.root, "commit", final.after)).toBe(
        verifiedSignatureKey(f.root, "commit", signedCommit),
      );
      expect(verifiedSignatureKey(f.root, "tag", newTag)).toBe(signer);
    } else expect(unsignedTagPayload(replacementTag)).toEqual(replacementTag);
    expect(unsignedTagPayload(replacementTag)).toEqual(
      Buffer.concat([Buffer.from(`object ${replaced}`), originalPayload.subarray(originalPayload.indexOf(10))]),
    );
    expect(git(f.root, "rev-parse", final.recovery)).toBe(signedCommit);
    expect(git(f.root, "rev-parse", `${final.recovery.replace(/\/before$/, "")}/before-refs/refs/tags/reviewed`)).toBe(
      tag,
    );
  },
);
