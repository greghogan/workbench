import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { sourceCheckoutPathIncluded } from "./source-checkout.mjs";
import { readBoundedFile } from "../src/file-reads.ts";
import { buildPaths, readBuildIdentity } from "../src/builds.ts";
import { withCacheLock } from "../src/cache-lock.ts";
import { writeAtomic } from "./file-publication.mjs";
import { cacheGenerationMarker, cacheSizeMarker } from "./cache-generation.mjs";
import type { EngineeringRun } from "./engineering-run.mjs";

export async function fileSHA256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
  return hash.digest("hex");
}
/** Bind optimization evidence to the declared build inputs and all owned source files, rather than a filename recipe. */
export async function optimizationInputs(run: EngineeringRun, root: string, builds: string, recipe: string) {
  const identity = readBuildIdentity(builds, ".workbench-build.json");
  // Ownership retains the host checkout name; read sources from the mounted root-relative location.
  const checkout = resolve(
    root,
    ...identity.root
      .split(/[\\/]/)
      .filter((part) => part !== "" && part !== ".")
      .map(() => ".."),
  );
  const declared = buildPaths(checkout, root, identity.environment, {}, false).inputs;
  let ancestor = root;
  while (!existsSync(join(ancestor, ".git")) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  let listed: string[];
  if (existsSync(join(ancestor, ".git")))
    listed = (
      await run.run("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
        capture: true,
      })
    )
      .split("\0")
      .filter(Boolean);
  else {
    // Prepared images retain source files without a Git object store. Hash the same source tree without outputs.
    const visit = (directory: string): string[] =>
      readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        return !sourceCheckoutPathIncluded(path) || entry.isSymbolicLink()
          ? []
          : entry.isDirectory()
            ? visit(path)
            : [path];
      });
    listed = visit("");
  }
  const paths = [...new Set([...declared.map((path) => relative(root, path)), ...listed])]
    .filter((path) => !/^(?:coverage|build|dist|\.git)\//.test(path))
    .sort();
  const files: Record<string, string> = {};
  for (const path of paths) {
    const absolute = join(root, path);
    if (existsSync(absolute) && lstatSync(absolute).isFile()) files[path] = await fileSHA256(absolute);
  }
  return {
    identity,
    files,
    recipe,
    recipeSHA256: await fileSHA256(recipe),
    modes: Object.fromEntries(
      ["WORKBENCH_COMPILER", "WORKBENCH_C_STANDARD", "WORKBENCH_CXX_STANDARD", "WORKBENCH_LANGUAGE_STANDARD"].flatMap(
        (key) => (process.env[key] ? [[key, process.env[key]]] : []),
      ),
    ),
    inheritedFlagsSHA256: createHash("sha256")
      .update(
        JSON.stringify([process.env.CARGO_ENCODED_RUSTFLAGS ?? process.env.RUSTFLAGS ?? "", process.env.GOFLAGS ?? ""]),
      )
      .digest("hex"),
  };
}
export async function publishOptimization(
  run: EngineeringRun,
  output: string,
  name: string,
  prepare: (stage: string) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<void> {
  await withCacheLock(
    output,
    async () => {
      const stage = join(run.directory, `artifact-${randomUUID()}`);
      mkdirSync(stage);
      const provenance = await prepare(stage); // Includes relocation verification before either retained file changes.
      const artifact = { name, sha256: await fileSHA256(join(stage, name)) };
      writeAtomic(
        join(stage, "provenance.json"),
        JSON.stringify({ schema_version: 1, ...provenance, artifact }, null, 2) + "\n",
      );
      run.signal.throwIfAborted();
      const backup = `${output}.previous-${randomUUID()}`;
      let hadPrevious = false;
      if (existsSync(output)) {
        if (
          !lstatSync(output).isDirectory() ||
          readdirSync(output).some(
            (entry) => ![name, "provenance.json", cacheGenerationMarker, cacheSizeMarker].includes(entry),
          )
        )
          throw new Error(`Preserving an unrecognized optimization output: ${output}`);
        const previous: unknown = JSON.parse(
          readBoundedFile(join(output, "provenance.json"), 1024 * 1024, "optimization provenance").toString("utf8"),
        );
        if (
          !previous ||
          typeof previous !== "object" ||
          !("artifact" in previous) ||
          !previous.artifact ||
          typeof previous.artifact !== "object" ||
          !("name" in previous.artifact) ||
          previous.artifact.name !== name ||
          !("sha256" in previous.artifact) ||
          previous.artifact.sha256 !== (await fileSHA256(join(output, name)))
        )
          throw new Error(`Preserving inconsistent optimization evidence: ${output}`);
        renameSync(output, backup);
        hadPrevious = true;
      }
      try {
        renameSync(stage, output);
      } catch (failure) {
        if (hadPrevious) {
          try {
            renameSync(backup, output);
          } catch (restore) {
            throw new AggregateError(
              [failure, restore],
              `Optimization replacement failed; previous output preserved at ${backup}`,
              { cause: restore },
            );
          }
        }
        throw failure;
      }
      if (hadPrevious) rmSync(backup, { recursive: true });
      console.log(`Verified optimization artifact: ${join(output, name)}. No performance improvement is claimed.`);
    },
    undefined,
    run.signal,
  );
}
