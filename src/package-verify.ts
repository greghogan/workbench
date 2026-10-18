import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractArchive } from "./tool-downloads.js";

/** Execute the checksummed release archive outside the source checkout. */
export async function verifyWorkbenchPackage(artifacts?: string, source = process.cwd()): Promise<void> {
  const root = resolve(source);
  artifacts = resolve(artifacts ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist"));
  const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
  // The archived executable must discover its consumer, independently of the invoking project's runner context.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(
      [
        "WORKBENCH_PROJECT_ROOT",
        "WORKBENCH_DISTRIBUTION_ROOT",
        "WORKBENCH_LOCAL_CONFIG_ROOT",
        "WORKBENCH_POLICY_REVIEW",
        "WORKBENCH_PROFILE_CONTEXT",
        "WORKBENCH_SHELL_ROOT",
        "WORKBENCH_SHELL_ENVIRONMENT",
        "WORKBENCH_EPHEMERAL_CHECKOUT",
        "WORKBENCH_COLLECTIONS_MATERIALIZED",
        "WORKBENCH_BUILD_DIR",
        "WORKBENCH_DIST_DIR",
        "WORKBENCH_DEPENDENCIES_DIR",
        "WORKBENCH_RELEASE_OUTPUT",
        "WORKBENCH_STORAGE_PROJECT",
        "WORKBENCH_EXECUTING_SPEC",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_PREFIX",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
      ].map((name) => [name, undefined]),
    ),
    WORKBENCH_CONFIG_HOME: join(temporary, "config"),
    WORKBENCH_DATA_HOME: join(temporary, "data"),
    WORKBENCH_CACHE_HOME: join(temporary, "cache"),
    WORKBENCH_STATE_HOME: join(temporary, "state"),
    WORKBENCH_STORAGE_EXTERNAL: "false",
    WORKBENCH_STORAGE_ROOT: join(temporary, "cache"),
  };
  function run(command: string, args: string[], cwd = temporary): string {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    if (result.error || result.status !== 0)
      throw new Error(
        `Release artifact check failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status ?? result.signal)}`)}`,
      );
    return result.stdout;
  }
  try {
    const packaged = join(artifacts, "workbench-artifacts");
    const bytes = readFileSync(join(packaged, "workbench.tar.gz"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (readFileSync(join(packaged, "SHA256SUMS"), "utf8") !== `${digest}  workbench.tar.gz\n`)
      throw new Error("Workbench release archive checksum mismatch");
    // Verify and extract the same private bytes, independently of the staging directory.
    const archive = join(temporary, "workbench.tar.gz");
    writeFileSync(archive, bytes);
    const extracted = join(temporary, "runtime with spaces 雪");
    mkdirSync(extracted);
    const directory = await extractArchive(archive, extracted, {
      url: pathToFileURL(archive).href,
      sha256: digest,
      format: "tar",
      strip: 1,
      bin: "bin",
    });
    const consumer = join(temporary, "consumer");
    mkdirSync(consumer);
    run(process.execPath, [join(directory, "bin/workbench.mjs"), "--help"], directory);
    run("git", ["init", "--quiet"], consumer);
    run(process.execPath, [join(directory, "bin/workbench.mjs"), "setup", "--id", "consumer"], consumer);
    cpSync(join(root, "workbench/CHARTER.md"), join(consumer, "workbench/CHARTER.md"));
    writeFileSync(
      join(consumer, "workbench/automation.toml"),
      `[[check]]
  name = "Consumer command"
  role = "test"
  command = ${JSON.stringify(["node", "-e", "require('node:fs').writeFileSync('checked', process.cwd())"])}
  `,
    );
    run(process.execPath, [join(directory, "bin/workbench.mjs"), "sync"], consumer);
    const references = run(process.execPath, [join(directory, "bin/workbench.mjs"), "language"], consumer);
    if (!references.includes(join(directory, "examples/languages/javascript")))
      throw new Error("Release artifact does not discover its own reference examples");
    const removedCommand = spawnSync(process.execPath, [join(directory, "bin/workbench.mjs"), "language", "check"], {
      cwd: consumer,
      env,
      encoding: "utf8",
    });
    if (
      removedCommand.error ||
      removedCommand.status === 0 ||
      !/too many arguments for ['"]language['"]/.test(removedCommand.stderr)
    )
      throw new Error(
        `Release artifact did not reject the removed reference-check command: ${removedCommand.error?.message ?? removedCommand.stderr}`,
      );
    run(process.execPath, [join(directory, "bin/workbench.mjs"), "pre-commit"], consumer);
    if (realpathSync(readFileSync(join(consumer, "checked"), "utf8")) !== realpathSync(consumer))
      throw new Error("Release artifact did not run the consumer's configured check in its project root");
    mkdirSync(join(consumer, "application"));
    run(
      process.execPath,
      [join(directory, "bin/workbench.mjs"), "language", "init", "javascript", "application"],
      consumer,
    );
    run(process.execPath, [join(directory, "bin/workbench.mjs"), "sync"], consumer);
    run(process.execPath, [join(directory, "bin/workbench.mjs"), "validate"], consumer);

    console.log(`Verified release artifacts from ${root} outside the source checkout.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
