import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { compilerCatalog, type CompilerFamily } from "./compiler-catalog.mjs";
import type { EngineeringRun, EngineeringCommandOptions } from "./engineering-run.mjs";
import { optimizationInputs, fileSHA256, publishOptimization } from "./optimization-artifact.mjs";

interface NativePGOContext {
  builds: string;
  compiler: CompilerFamily;
  language: "c" | "cpp";
  job: EngineeringRun;
  configure: (directory: string, options?: string[]) => Promise<void>;
  test: (directory: string, profiles?: string) => Promise<void>;
  verify: (directory: string) => Promise<void>;
  run: (command: string, args?: string[], options?: EngineeringCommandOptions & { stdio?: "pipe" }) => Promise<string>;
}
const files = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)],
  );

/** Train and verify privately; publish the executable and its evidence only after all checks pass. */
export async function nativePGO(context: NativePGOContext): Promise<void> {
  if (context.compiler === "mvsc")
    throw new Error("The example PGO workflow supports Clang and GCC; mvsc PGO is not configured");
  const recipe = fileURLToPath(import.meta.url);
  const inputs = await optimizationInputs(context.job, process.cwd(), context.builds, recipe);
  const name = `count${process.platform === "win32" ? ".exe" : ""}`;
  await publishOptimization(context.job, join(context.builds, "pgo"), name, async (stage) => {
    const profiles = join(context.job.directory, "profiles"),
      training = join(context.job.directory, "generate"),
      optimized = join(context.job.directory, "use");
    mkdirSync(profiles);
    const flags = ["-DCMAKE_BUILD_TYPE=Release", `-DWORKBENCH_PGO_DIRECTORY=${profiles}`];
    await context.configure(training, [...flags, "-DWORKBENCH_PGO=generate"]);
    await context.test(training, profiles);
    const raw = files(profiles).filter((path) => path.endsWith(context.compiler === "clang" ? ".profraw" : ".gcda"));
    assert.ok(raw.length, "Training produced no compiler profiles; PGO verification cannot continue");
    const merger =
      context.compiler === "clang"
        ? (await context.run("llvm-profdata", ["--version"], { stdio: "pipe" })).trim()
        : undefined;
    if (context.compiler === "clang")
      await context.run("llvm-profdata", ["merge", "-o", join(profiles, "merged.profdata"), ...raw]);
    await context.configure(optimized, [...flags, "-DWORKBENCH_PGO=use"]);
    await context.verify(optimized);
    copyFileSync(join(optimized, name), join(stage, name));
    assert.equal(
      (await context.run(join(stage, name), ["--json", "r", "cherry"], { cwd: stage, stdio: "pipe" })).trim(),
      '{"count":2}',
      "Independent relocated optimized native result",
    );
    assert.equal((await context.run(join(stage, name), ["z", "pizza"], { cwd: stage, stdio: "pipe" })).trim(), "2");
    assert.deepEqual(
      await optimizationInputs(context.job, process.cwd(), context.builds, recipe),
      inputs,
      "PGO source inputs changed during training or verification",
    );
    return {
      language: context.language,
      compiler: context.compiler,
      compilerVersion: (
        await context.run(
          process.env[context.language === "c" ? "WORKBENCH_CC" : "WORKBENCH_CXX"] ??
            compilerCatalog[context.compiler].executables[context.language],
          ["--version"],
          { stdio: "pipe" },
        )
      ).trim(),
      merger,
      inputs,
      platform: `${process.platform}-${process.arch}`,
      training: "canonical application test suite",
      verification: "independent complete tests and relocated release execution",
      profiles: await Promise.all(
        files(profiles).map(async (path) => ({ path: relative(profiles, path), sha256: await fileSHA256(path) })),
      ),
    };
  });
}
