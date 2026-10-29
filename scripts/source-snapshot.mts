import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { captureOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { sourceCheckoutPaths, sourceCheckoutPathIncluded } from "./source-checkout.mjs";
import { maintainerOutput } from "./tooling-artifacts.mts";
import { ownedPath } from "../src/paths.ts";
import type { ProcessLock } from "../src/process-lock.js";

/** Capture source in a private Git object store; the caller's index, refs, and working files remain untouched. */
export async function createSourceSnapshot(options: {
  source: string;
  destination: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  owner?: ProcessLock;
}): Promise<{ directory: string; tree: string }> {
  options.signal.throwIfAborted();
  const source = realpathSync(options.source),
    destination = resolve(options.destination);
  const inside = relative(source, destination);
  if (!inside || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`)))
    throw new Error("Source snapshot destination must be outside the source checkout");
  mkdirSync(dirname(destination), { recursive: true });
  const capture = mkdtempSync(join(dirname(destination), ".source-capture-"));
  let destinationCreated = false;
  const env = { ...options.environment };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    Reflect.deleteProperty(env, key);
  Object.assign(env, {
    GIT_AUTHOR_NAME: "Workbench source rehearsal",
    GIT_COMMITTER_NAME: "Workbench source rehearsal",
    GIT_AUTHOR_EMAIL: "source-rehearsal@example.invalid",
    GIT_COMMITTER_EMAIL: "source-rehearsal@example.invalid",
  });
  let gitDirectory = join(capture, ".git"),
    worktree = source;
  const run = async (args: string[], cwd: string, reject = true) => {
    const outcome = await captureOwnedChild(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      { cwd, env, signal: options.signal, ...(options.owner ? { owner: options.owner } : {}) },
      32 * 1024 * 1024,
    );
    options.signal.throwIfAborted();
    if (reject) {
      const failure = processFailure("source snapshot Git", outcome, outcome);
      if (failure) throw failure;
    }
    return outcome;
  };
  const git = async (args: string[]) =>
    (
      await run(
        [
          "--git-dir",
          gitDirectory,
          "--work-tree",
          worktree,
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.symlinks=true",
          "-c",
          "commit.gpgsign=false",
          "-c",
          `core.hooksPath=${join(capture, "disabled-hooks")}`,
          ...args,
        ],
        source,
      )
    ).stdout;
  try {
    mkdirSync(destination, { mode: 0o700 });
    destinationCreated = true;
    await run(["init", "--quiet", capture], source);
    const top = await run(["-C", source, "rev-parse", "--show-toplevel"], source, false);
    const gitSource = top.status === 0 && realpathSync(top.stdout.trim()) === source;
    const files = async (): Promise<string[]> => {
      let paths: string[];
      if (gitSource)
        paths = (
          await run(["-C", source, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], source)
        ).stdout
          .split("\0")
          .filter(Boolean);
      else {
        paths = [];
        const visit = (name: string) => {
          if (!sourceCheckoutPathIncluded(name) || maintainerOutput(name) || !existsSync(join(source, name))) return;
          const metadata = lstatSync(ownedPath(source, name));
          if (metadata.isDirectory()) for (const child of readdirSync(join(source, name))) visit(`${name}/${child}`);
          else paths.push(name);
        };
        for (const path of sourceCheckoutPaths) visit(path);
      }
      return [...new Set(paths)]
        .filter((path) => sourceCheckoutPathIncluded(path) && !maintainerOutput(path) && existsSync(join(source, path)))
        .sort();
    };
    const selected = await files();
    if (!selected.length) throw new Error("No source files selected for the checkout rehearsal");
    for (const path of selected)
      if (!lstatSync(ownedPath(source, path)).isFile()) throw new Error(`Unsupported source snapshot path: ${path}`);
    const manifest = join(capture, "source-paths");
    writeFileSync(manifest, selected.join("\0") + "\0", { mode: 0o600 });
    await git(["--literal-pathspecs", "add", "--force", `--pathspec-from-file=${manifest}`, "--pathspec-file-nul"]);
    const changed = await git(["diff-files", "--name-only", "-z"]);
    if (changed || JSON.stringify(await files()) !== JSON.stringify(selected))
      throw new Error("Source changed while capturing the checkout rehearsal; retry with stable inputs");
    const tree = (await git(["write-tree"])).trim();
    await git(["checkout-index", "--all", `--prefix=${destination}${sep}`]);
    renameSync(gitDirectory, join(destination, ".git"));
    gitDirectory = join(destination, ".git");
    worktree = destination;
    await git([
      "-c",
      "user.name=Workbench source rehearsal",
      "-c",
      "user.email=source-rehearsal@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Capture source checkout rehearsal",
    ]);
    rmSync(capture, { recursive: true, force: true });
    return { directory: destination, tree };
  } catch (failure) {
    const cleanup: unknown[] = [];
    for (const path of [capture, ...(destinationCreated ? [destination] : [])])
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        cleanup.push(error);
      }
    if (cleanup.length)
      throw new AggregateError([failure, ...cleanup], "Source snapshot capture and cleanup failed", { cause: failure });
    throw failure;
  }
}
