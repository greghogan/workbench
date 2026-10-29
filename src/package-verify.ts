import { createOwnedScratch, type OwnedScratch } from "../scripts/owned-scratch.mjs";
import { captureOwnedChild, processCancellation } from "../scripts/owned-child.mjs";
import { settleCleanup } from "./diagnostics.js";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { pathToFileURL } from "node:url";
import { extractArchive } from "./tool-downloads.js";
import { npmCommand } from "./npm-command.js";
import { readDistributionManifest } from "./distribution-source-manifest.js";
import { cpuBudget } from "../scripts/cpu-budget.mjs";
import { workQueue } from "../scripts/work-admission.mjs";

export interface VerifiedWorkbenchPackage {
  temporary: string;
  directory: string;
  launcher: string;
  prefix: string;
  environment: NodeJS.ProcessEnv;
  languages: string[];
}

/** Execute the checksummed release archive outside the source checkout. */
export async function verifyWorkbenchPackage(
  artifacts?: string,
  source = process.cwd(),
  exercise?: (installed: VerifiedWorkbenchPackage) => Promise<void>,
  options: {
    signal?: AbortSignal;
    scope?: OwnedScratch;
    environment?: NodeJS.ProcessEnv;
    onCleanupIssue?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const root = resolve(source);
  artifacts = resolve(artifacts ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist"));
  const scratch = options.scope ?? createOwnedScratch(tmpdir(), "workbench-release-check");
  const temporary = options.scope ? mkdtempSync(join(scratch.directory, "verification-")) : scratch.directory;
  const owner = scratch.owner;
  // The archived executable must discover its consumer, independently of the invoking project's runner context.
  const env: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    ...Object.fromEntries(
      [
        "WORKBENCH_PROJECT_ROOT",
        "WORKBENCH_CI_CANDIDATE",
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
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_update_notifier: "false",
    GIT_CONFIG_GLOBAL: join(temporary, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const cancellation = processCancellation();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  async function run(command: string, args: string[], cwd = temporary): Promise<string> {
    const result = await captureOwnedChild(command, args, {
      cwd,
      env,
      signal,
      owner,
    });
    if (result.error || result.status !== 0)
      throw new Error(`Release artifact check failed: ${result.error?.message ?? result.stderr}`, {
        cause: result.error,
      });
    return result.stdout;
  }
  let failure: unknown;
  try {
    writeFileSync(join(temporary, "gitconfig"), "");
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
    readDistributionManifest(directory);
    const consumer = join(temporary, "consumer");
    mkdirSync(consumer);
    await run(process.execPath, [join(directory, "bin/workbench.mjs"), "--help"], directory);
    await run("git", ["init", "--quiet"], consumer);
    await run(process.execPath, [join(directory, "bin/workbench.mjs"), "setup", "--id", "consumer"], consumer);
    const fixtureCharter = join(directory, "tests/fixtures/records/CHARTER.md");
    cpSync(fixtureCharter, join(consumer, "workbench/CHARTER.md"));
    writeFileSync(
      join(consumer, "workbench/automation.toml"),
      `[[check]]
  name = "Consumer command"
  role = "test"
  command = ${JSON.stringify(["node", "-e", "require('node:fs').writeFileSync('checked', process.cwd())"])}
  `,
    );
    await run(process.execPath, [join(directory, "bin/workbench.mjs"), "sync"], consumer);
    const references = await run(process.execPath, [join(directory, "bin/workbench.mjs"), "language"], consumer);
    if (!references.includes(join(directory, "examples/languages/javascript")))
      throw new Error("Release artifact does not discover its own reference examples");
    const removedCommand = await captureOwnedChild(
      process.execPath,
      [join(directory, "bin/workbench.mjs"), "language", "check"],
      { cwd: consumer, env, signal, owner },
    );
    if (
      removedCommand.error ||
      removedCommand.status === 0 ||
      !/too many arguments for ['"]language['"]/.test(removedCommand.stderr)
    )
      throw new Error(
        `Release artifact did not reject the removed reference-check command: ${removedCommand.error?.message ?? removedCommand.stderr}`,
      );
    await run(process.execPath, [join(directory, "bin/workbench.mjs"), "pre-commit"], consumer);
    if (realpathSync(readFileSync(join(consumer, "checked"), "utf8")) !== realpathSync(consumer))
      throw new Error("Release artifact did not run the consumer's configured check in its project root");
    mkdirSync(join(consumer, "application"));
    await run(
      process.execPath,
      [join(directory, "bin/workbench.mjs"), "language", "init", "javascript", "application"],
      consumer,
    );
    await run(process.execPath, [join(directory, "bin/workbench.mjs"), "sync"], consumer);
    await run(process.execPath, [join(directory, "bin/workbench.mjs"), "validate"], consumer);

    // Extraction alone misses npm's transformations of template files such as .gitignore.
    const npm = npmCommand({ sdkOnly: true });
    const prefix = join(temporary, "npm installation with spaces 雪");
    await run(npm.command, [
      ...npm.prefix,
      "install",
      "--global",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      archive,
    ]);
    const installed = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules/@workbench/cli");
    const launcher = join(installed, "bin/workbench.mjs");
    if (readDistributionManifest(installed).sha256 !== readDistributionManifest(directory).sha256)
      throw new Error("npm installation changed the candidate's original source manifest");
    const index = parse(readFileSync(join(installed, "languages/index.toml"), "utf8")) as { languages: string[] };
    await workQueue(index.languages, { capacity: cpuBudget(), signal }, async (language) => {
      const project = join(temporary, `consumer-${language}`);
      await run(process.execPath, [launcher, "init", project, "--language", language]);
      cpSync(fixtureCharter, join(project, "workbench/CHARTER.md"));
      await run(process.execPath, [launcher, "sync"], project);
      await run(process.execPath, [launcher, "validate"], project);
      const plan = await run(process.execPath, [launcher, "check", "--list", "--stage", "commit"], project);
      if (!plan.includes(`${language}@.`)) throw new Error(`${language}: installed starter has no configured checks`);
      if (language === "ruby" && !existsSync(join(project, "test/coverage_helper.rb")))
        throw new Error("Ruby starter omits its coverage helper");
    });

    await exercise?.({
      temporary,
      directory: installed,
      launcher,
      prefix,
      environment: env,
      languages: index.languages,
    });
    console.log(
      `Verified release artifacts from ${root} outside the source checkout, including npm-installed starters for every bundled language.`,
    );
  } catch (error) {
    failure = error;
  } finally {
    await settleCleanup(
      [
        () => {
          cancellation.close();
        },
        () => {
          try {
            owner.assertIdle();
            if (options.scope) rmSync(temporary, { recursive: true, force: true });
            else scratch.release();
          } catch (error) {
            options.onCleanupIssue?.(error);
            throw error;
          }
        },
      ],
      failure,
    );
  }
}
