import { record, string, strings } from "../app/src/core/runtime/values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { join, resolve } from "node:path";
import { isMainScript } from "./script-entry.mjs";

export function openImagePreparation(quietTools: boolean) {
  const distribution = resolve(import.meta.dirname, "..");
  const root = resolve(process.env.WORKBENCH_PROJECT_ROOT ?? process.cwd());
  const cli = join(distribution, "bin/workbench.mjs");
  const environment = { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution };
  const cancellation = processCancellation();
  async function run(args: string[]) {
    const quiet = quietTools && args[0] === "tools" && args[1] === "install";
    let tail = Buffer.alloc(0),
      total = 0;
    if (quiet) console.log(`Preparing verified native tools (${args.slice(2).join(" ")})...`);
    const outcome = await runOwnedChild(process.execPath, [cli, ...args], {
      cwd: root,
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
    const failure = processFailure("image preparation", outcome);
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
  const paths = async (selectedPaths: string[]) => {
    const values = strings(
      JSON.parse(await query(["image-roots", ...selectedPaths.flatMap((path) => ["--path", path])])),
      "Invalid image language roots",
    );
    if (!values.length) throw new Error("Image preparation needs registered language roots");
    return values;
  };
  return { root, cli, cancellation, run, query, paths };
}

export async function installImageTools(
  { run, query }: ReturnType<typeof openImagePreparation>,
  paths: string[],
  toolchain?: string,
  skipCIToolchains = false,
): Promise<void> {
  const toolchainArgs = toolchain ? ["--toolchain", toolchain] : [];
  for (const path of paths) await run(["tools", "install", "--path", path, ...toolchainArgs, "--exclude-tool", "miri"]);
  // Optional CI tool variants contribute SDKs, but CI does not select image roots or verification suites.
  if (!toolchain && !skipCIToolchains) {
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
      await run(["tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
  }
}

if (isMainScript(import.meta.url)) {
  const preparation = openImagePreparation(true);
  try {
    await preparation.run(["project", "add", preparation.root]);
    await installImageTools(preparation, await preparation.paths([]));
  } finally {
    preparation.cancellation.close();
  }
}
