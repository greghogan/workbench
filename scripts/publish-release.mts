import { processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { runCIEntry } from "./ci-errors.mts";
import { isMainScript } from "./script-entry.mjs";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { readCandidate } from "./ci-candidate.mts";
import { record, required, string } from "../app/src/core/runtime/values.mjs";
import {
  checkedWorkbenchZip,
  checkedWorkbenchZipArtifact,
  successfulReleaseRun,
  readReleaseProof,
  verifyReleaseCandidate,
  workbenchZipTargets,
} from "./release-contract.mts";
import { GitHubRelease, publishGitHubFiles } from "../app/src/core/artifacts/github-release.mts";

/** Promote verified candidate bytes; the privileged path never executes downloaded code. */
export async function publishRelease(id: string, output: string, env = process.env): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Select a Checks run ID");
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Release publication must run from main");
  if (existsSync(output)) throw new Error("Release record inputs need a new output directory");
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
      const assetDirectory = join(directory, "workbench-artifacts");
      const assets = [
        { target: "portable-node", file: "workbench.tar.gz" },
        { target: "checksums", file: "SHA256SUMS" },
      ];
      const digests = [`${candidate.sha256}  workbench.tar.gz`];
      for (const target of workbenchZipTargets) {
        const packageDirectory = join(root, target);
        await github.downloadRun(id, checkedWorkbenchZipArtifact(target, proof.artifact), packageDirectory);
        const { file, sha256 } = checkedWorkbenchZip(packageDirectory, target, selected.revision);
        if (proof.zipDigests.get(target) !== sha256)
          throw new Error(`${target}: release package differs from the successful Checks run proof`);
        const name = `workbench-${target}.zip`;
        writeFileSync(join(assetDirectory, name), file, { flag: "wx" });
        assets.push({ target, file: name });
        digests.push(`${sha256}  ${name}`);
      }
      const marker = `Workbench ${tag}\n\nVerified Checks: https://github.com/${repository}/actions/runs/${id}\nSource: ${selected.revision}\n\nSHA-256\n\n\`\`\`\n${digests.join("\n")}\n\`\`\``;
      await publishGitHubFiles(
        github,
        tag,
        selected.revision,
        marker,
        assets.map(({ file }) => join(assetDirectory, file)),
        root,
      );
      await github.verifyTag(tag, selected.revision, true);
      const published = await github.release(tag);
      const released = Date.parse(published?.published_at ?? "");
      if (published?.draft !== false || published.body !== marker || !Number.isFinite(released))
        throw new Error("GitHub did not confirm the published release identity and date");
      const verified = join(root, "published-verification");
      writeFileSync(
        join(verified, "release.json"),
        JSON.stringify({
          version: candidate.release,
          tag,
          revision: selected.revision,
          released: new Date(released).toISOString().slice(0, 10),
          notes: { summary: `Workbench ${tag}`, changes: [] },
          artifacts: assets.map(({ target, file }) => ({ target, path: file, url: github.assetURL(tag, file) })),
        }) + "\n",
        { flag: "wx" },
      );
      renameSync(verified, output);
      console.log(`Published verified Workbench ${tag}: https://github.com/${repository}/releases/tag/${tag}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    cancellation.close();
  }
}

function retainReleaseRecord(inputs: string, output: string): void {
  const created = execFileSync(
    process.execPath,
    [
      join(import.meta.dirname, "../bin/workbench.mjs"),
      "record",
      "add",
      "release",
      join(inputs, "release.json"),
      "--project",
      "workbench-app",
      "--json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const path = string(record(JSON.parse(created), "Invalid record output").path, "Missing record path");
  const destination = join(output, relative(process.cwd(), path));
  mkdirSync(output);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(path, destination);
}

if (isMainScript(import.meta.url)) {
  const [operation, inputs, output] = process.argv.slice(2);
  if (operation === "record")
    await runCIEntry("Retain release record", () => {
      retainReleaseRecord(
        required(inputs, "Missing verified release inputs"),
        required(output, "Missing record output"),
      );
    });
  else
    await runCIEntry("Publish verified release", () =>
      publishRelease(
        required(operation, "Missing successful Checks run ID"),
        required(inputs, "Missing release inputs output"),
      ),
    );
}
