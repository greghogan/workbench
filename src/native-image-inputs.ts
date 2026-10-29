import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mavenCheckInputs } from "../scripts/managed-check-inputs.mjs";
import { processCancellation, runOwnedChild } from "../scripts/owned-child.mjs";
import { processFailure } from "../scripts/process-outcome.mjs";
import { ciProcessOwner } from "../scripts/ci-lifecycle.mjs";
import { download } from "./tool-downloads.js";
import { prepareMavenRepository } from "./managed-input-environment.js";
import { required } from "./invariants.js";
import { artifactLimits } from "./artifact-streams.js";
import { readBoundedFileAsync } from "./file-reads.js";

/** Acquire test and analysis inputs through their locks without running the project checks. */
export async function prepareNativeImageInputs(directory: string, distribution: string): Promise<void> {
  const cancellation = processCancellation();
  const run = async (command: string, args: string[]) => {
    const owner = ciProcessOwner();
    const outcome = await runOwnedChild(command, args, {
      cwd: directory,
      env: process.env,
      signal: cancellation.signal,
      ...(owner ? { owner } : {}),
    });
    const failure = processFailure(command, outcome);
    if (failure) throw failure;
  };
  try {
    if (existsSync(join(directory, "Cargo.lock"))) await run("cargo", ["fetch", "--locked"]);
    if (existsSync(join(directory, "go.mod"))) await run("go", ["mod", "download", "all"]);
    if (existsSync(join(directory, ".mvn/checksums/checksums.sha256"))) {
      const sources = mavenCheckInputs(directory);
      const repository = process.env.WORKBENCH_MAVEN_REPOSITORY;
      if (!repository || !isAbsolute(repository))
        throw new Error("Acquire Maven inputs through a configured Workbench shell");
      const files = new Map<string, string>();
      for (const source of sources) {
        cancellation.signal.throwIfAborted();
        const sha256 = Buffer.from(source.hash.slice("sha256-".length), "base64").toString("hex");
        const target = join(repository, source.destination.slice("maven/".length));
        let cached: Buffer | undefined;
        try {
          cached = await readBoundedFileAsync(target, artifactLimits.file, "Maven cache input");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (cached) {
          if (createHash("sha256").update(cached).digest("hex") !== sha256)
            throw new Error(`Maven cache checksum mismatch: ${target}`);
          files.set(source.url, target);
        } else files.set(source.url, await download({ url: source.url, sha256 }, { signal: cancellation.signal }));
      }
      cancellation.signal.throwIfAborted();
      prepareMavenRepository(sources, (source) => required(files.get(source.url), "Missing acquired Maven input"));
    }
    if (existsSync(join(directory, ".xdebug-version")))
      await run(process.execPath, [
        join(distribution, "bin/workbench.mjs"),
        "php-coverage-exec",
        "--",
        "-r",
        'if (!extension_loaded("xdebug")) { exit(1); }',
      ]);
  } finally {
    cancellation.close();
  }
}
