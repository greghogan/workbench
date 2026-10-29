import { record, string } from "./values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Project-owned recipe: retain native check inputs, then prove fresh offline execution.
const [builder, option] = process.argv.slice(2);
if ((builder !== "native" && builder !== "nix" && builder !== "guix") || (option && option !== "--verify"))
  throw new Error("Use prepare-development.mjs native|nix|guix [--verify]");
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "bin/workbench.mjs");
const verify = option === "--verify";
if (!verify && builder !== "native")
  throw new Error(
    "Managed images are assembled by scripts/prepare-managed-development.mjs from their declared closures",
  );
const cancellation = processCancellation();
async function run(command: string, args: string[], cwd = root) {
  const quiet = !verify && args[1] === "tools" && args[2] === "install";
  let tail = Buffer.alloc(0),
    total = 0;
  if (quiet) console.log(`Preparing verified native tools (${args.slice(3).join(" ")})...`);
  const outcome = await runOwnedChild(command, args, {
    cwd,
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: root },
    signal: cancellation.signal,
    ...(quiet
      ? {
          output: (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => {
            for (const stream of [stdout, stderr])
              stream.on("data", (chunk: Buffer) => {
                total += chunk.length;
                tail = Buffer.concat([tail, chunk]).subarray(-64 * 1024);
              });
          },
        }
      : {}),
  });
  const failure = processFailure(command, outcome);
  if (failure) {
    if (quiet)
      console.error(`${total > tail.length ? "Earlier preparation output omitted.\n" : ""}${tail.toString("utf8")}`);
    throw failure;
  }
}
async function query(args: string[]) {
  const result = await captureOwnedChild(
    process.execPath,
    [cli, ...args],
    { cwd: root, env: process.env, signal: cancellation.signal },
    16 * 1024 * 1024,
  );
  const failure = processFailure("preparation metadata", result, result);
  if (failure) throw failure;
  return result.stdout;
}
try {
  await run(process.execPath, [cli, "project", "add", root]);
  const matrix = record(JSON.parse(await query(["check", "matrix"])), "Invalid check matrix");
  const include = record(matrix[builder === "native" ? "native" : "environments"], "Missing builder matrix").include;
  if (!Array.isArray(include)) throw new Error("Missing native matrix entries");
  const operatingSystem =
    process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  const entries = include
    .map((value: unknown) => record(value, "Invalid matrix entry"))
    .filter((entry) =>
      builder === "native"
        ? entry.os === operatingSystem && entry.architecture === process.arch
        : entry.environment === builder,
    );
  if (!entries.length)
    throw new Error(`No configured ${builder} preparation targets for ${operatingSystem}-${process.arch}`);
  const paths = [...new Set(entries.map((entry) => string(entry.path, "Missing matrix path")))];
  if (!verify && builder === "native") {
    await run(process.execPath, [cli, "tools", "install", "--exclude-tool", "miri"]);
    for (const name of [
      ...new Set(entries.flatMap((entry) => (entry.toolchain ? [string(entry.toolchain, "Invalid toolchain")] : []))),
    ])
      await run(process.execPath, [cli, "tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
  }
  for (const path of paths) {
    console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
    const selection = ["check", "--path", path, "--environment", builder, "--no-cache"];
    await run(process.execPath, [cli, ...selection, "--role", "build"]);
    if (builder === "native") {
      const plan = record(JSON.parse(await query([...selection, "--stage", "ci", "--json"])), "Invalid check plan");
      // Resolve the configured CI variants, including coverage and analysis tools missed by ordinary build/test.
      // Advisory databases are live inputs, so query them in CI rather than freezing them into the image.
      if (!Array.isArray(plan.selected)) throw new Error("Missing selected checks");
      const roles = [
        ...new Set(
          plan.selected.map((check: unknown) => string(record(check, "Invalid check").role, "Missing check role")),
        ),
      ].filter((role) => !["setup", "build", "advisory"].includes(role));
      if (roles.length)
        await run(process.execPath, [cli, ...selection, "--stage", "ci", ...roles.flatMap((role) => ["--role", role])]);
    } else await run(process.execPath, [cli, ...selection, "--role", "test"]);
    console.log("::endgroup::");
  }

  if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
    const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
    await retainPnpmMetadata(root, cli, paths, cancellation.signal);
  }
} finally {
  cancellation.close();
}
