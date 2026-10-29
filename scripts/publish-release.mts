import { processCancellation } from "./owned-child.mjs";
import { runCIEntry } from "./ci-errors.mts";
import { isMainScript } from "./script-entry.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readCandidate } from "./ci-candidate.mts";
import { required } from "./values.mjs";
import { successfulReleaseRun, readReleaseProof, verifyReleaseCandidate } from "./release-contract.mts";
import { GitHubRelease } from "./github-release.mts";

/** Promote verified candidate bytes; the privileged path never executes downloaded code. */
export async function publishRelease(id: string, env = process.env): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Select a Checks run ID");
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Release publication must run from main");
  const cancellation = processCancellation();
  try {
    const repository = required(env.GITHUB_REPOSITORY, "Missing repository");
    const github = new GitHubRelease(repository, env, cancellation.signal);
    const selected = successfulReleaseRun(await github.api(`/actions/runs/${id}`), repository, id);
    execFileSync("git", ["merge-base", "--is-ancestor", selected.revision, "HEAD"]);
    const root = mkdtempSync(join(required(env.RUNNER_TEMP, "Missing runner directory"), "workbench-publication-"));
    try {
      const evidence = join(root, "evidence");
      await github.downloadRun(id, `release-ready-${id}-${selected.attempt}`, evidence);
      const proof = readReleaseProof(
        JSON.parse(readFileSync(join(evidence, "release-ready.json"), "utf8")),
        repository,
        id,
        selected,
      );
      const directory = join(root, "candidate");
      await github.downloadRun(id, proof.artifact, directory);
      const candidate = readCandidate(directory, repository, selected.revision);
      verifyReleaseCandidate(
        proof,
        candidate,
        JSON.parse(execFileSync("git", ["show", `${selected.revision}:package.json`], { encoding: "utf8" })) as unknown,
      );
      const tag = `v${candidate.release}`;
      const marker = `Workbench ${tag}\n\nVerified Checks: https://github.com/${repository}/actions/runs/${id}\nSource: ${selected.revision}\nSHA-256: ${candidate.sha256}`;
      const existing = await github.release(tag);
      await github.verifyTag(tag, selected.revision);
      if (existing && (existing.target_commitish !== selected.revision || existing.body !== marker))
        throw new Error("Existing release is not the selected immutable publication; refusing replacement");
      if (!existing) await github.create(tag, selected.revision, marker);
      for (const name of ["workbench.tar.gz", "SHA256SUMS"]) {
        if (existing?.assets.some((asset) => asset.name === name)) continue;
        if (existing && !existing.draft)
          throw new Error("Published release is missing required assets; refusing mutation");
        await github.upload(tag, join(directory, "workbench-artifacts", name));
      }
      const verify = async (destination: string) => {
        await github.download(tag, destination);
        for (const name of ["workbench.tar.gz", "SHA256SUMS"])
          if (!readFileSync(join(destination, name)).equals(readFileSync(join(directory, "workbench-artifacts", name))))
            throw new Error(`Published ${name} differs from the tested archive; preserving release for inspection`);
      };
      await verify(join(root, "draft-verification"));
      if (!existing || existing.draft) await github.publish(tag);
      await verify(join(root, "published-verification"));
      console.log(`Published verified Workbench ${tag}: https://github.com/${repository}/releases/tag/${tag}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    cancellation.close();
  }
}
if (isMainScript(import.meta.url))
  await runCIEntry("Publish verified release", () =>
    publishRelease(required(process.argv[2], "Missing successful Checks run ID")),
  );
