import { record, string } from "./values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Shared recipe: acquire declared inputs, then prove fresh offline builds and smoke execution.
const [builder, ...options] = process.argv.slice(2);
if (builder !== "native" && builder !== "nix" && builder !== "guix")
  throw new Error("Use prepare-development.mjs native|nix|guix [--verify] [--path ROOT]...");
const selectedPaths: string[] = [];
let verify = false;
for (let index = 0; index < options.length; index++) {
  const option = options[index];
  if (option === "--verify" && !verify) verify = true;
  else if (option === "--path" && options[index + 1] && !options[index + 1]?.startsWith("--"))
    selectedPaths.push(string(options[++index], "Missing preparation path"));
  else throw new Error(`Invalid preparation option: ${String(option)}`);
}
const distribution = resolve(import.meta.dirname, "..");
const root = resolve(process.env.WORKBENCH_PROJECT_ROOT ?? process.cwd());
const cli = join(distribution, "bin/workbench.mjs");
const environment = { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution };
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
    env: environment,
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
    { cwd: root, env: environment, signal: cancellation.signal },
    16 * 1024 * 1024,
  );
  const failure = processFailure("preparation metadata", result, result);
  if (failure) throw failure;
  return result.stdout;
}
try {
  await run(process.execPath, [cli, "project", "add", root]);
  const roots: unknown = JSON.parse(await query(["image-roots", ...selectedPaths.flatMap((path) => ["--path", path])]));
  if (!Array.isArray(roots) || !roots.length || roots.some((path: unknown) => typeof path !== "string"))
    throw new Error("Image preparation needs registered language roots");
  const paths = roots as string[];
  if (!verify && builder === "native") {
    for (const path of paths)
      await run(process.execPath, [cli, "tools", "install", "--path", path, "--exclude-tool", "miri"]);
    // Optional CI tool variants contribute SDKs, but CI does not select image roots or verification suites.
    const matrix = record(JSON.parse(await query(["check", "matrix"])), "Invalid check matrix");
    const include = record(matrix.native, "Missing native matrix").include;
    if (!Array.isArray(include)) throw new Error("Missing native matrix entries");
    const operatingSystem =
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
    const entries = include
      .map((value: unknown) => record(value, "Invalid matrix entry"))
      .filter(
        (entry) =>
          entry.os === operatingSystem && entry.architecture === process.arch && paths.includes(String(entry.path)),
      );
    for (const name of [
      ...new Set(entries.flatMap((entry) => (entry.toolchain ? [string(entry.toolchain, "Invalid toolchain")] : []))),
    ])
      await run(process.execPath, [cli, "tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
  }
  for (const path of paths) {
    console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
    const selection = ["check", "--path", path, "--environment", builder, "--no-cache"];
    if (!verify) await run(process.execPath, [cli, ...selection, "--role", "acquire"]);
    // One setup and build session retains the fresh outputs for smoke execution.
    await run(process.execPath, [cli, ...selection, "--role", "build", ...(verify ? ["--role", "smoke"] : [])]);
    console.log("::endgroup::");
  }

  if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
    const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
    await retainPnpmMetadata(root, cli, paths, cancellation.signal);
  }
} finally {
  cancellation.close();
}
