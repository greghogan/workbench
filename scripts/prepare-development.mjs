// Generated from prepare-development.mts; edit the TypeScript source.
import { record, string } from "../app/src/core/runtime/values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
const [builder, ...options] = process.argv.slice(2);
if (builder !== "native" && builder !== "nix" && builder !== "guix")
  throw new Error(
    "Use prepare-development.mjs native|nix|guix [--verify|--verify-tools|--tools-only|--dependencies-only|--acquire-only] [--path ROOT]... [--toolchain NAME] [--skip-ci-toolchains]"
  );
const selectedPaths = [];
let toolchain;
let skipCIToolchains = false;
const modes = ["verify", "verify-tools", "tools-only", "dependencies-only", "acquire-only"];
let mode = "prepare";
for (let index = 0; index < options.length; index++) {
  const option = options[index];
  const selected = modes.find((candidate) => option === `--${candidate}`);
  if (selected && mode === "prepare") mode = selected;
  else if (option === "--path" && options[index + 1] && !options[index + 1]?.startsWith("--"))
    selectedPaths.push(string(options[++index], "Missing preparation path"));
  else if (option === "--toolchain" && !toolchain && /^[a-z][a-z0-9_-]*$/.test(options[index + 1] ?? ""))
    toolchain = options[++index];
  else if (option === "--skip-ci-toolchains" && !skipCIToolchains) skipCIToolchains = true;
  else throw new Error(`Invalid preparation option: ${String(option)}`);
}
if (toolchain && builder !== "native") throw new Error("--toolchain selects a native preparation toolchain");
const toolchainArgs = toolchain ? ["--toolchain", toolchain] : [];
const verify = mode === "verify" || mode === "verify-tools";
const distribution = resolve(import.meta.dirname, "..");
const root = resolve(process.env.WORKBENCH_PROJECT_ROOT ?? process.cwd());
const cli = join(distribution, "bin/workbench.mjs");
const environment = { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution };
if (!verify && builder !== "native")
  throw new Error(
    "Managed images are assembled by scripts/prepare-managed-development.mjs from their declared closures"
  );
const cancellation = processCancellation();
async function run(command, args, cwd = root) {
  const quiet = !verify && args[1] === "tools" && args[2] === "install";
  let tail = Buffer.alloc(0), total = 0;
  if (quiet) console.log(`Preparing verified native tools (${args.slice(3).join(" ")})...`);
  const outcome = await runOwnedChild(command, args, {
    cwd,
    env: environment,
    signal: cancellation.signal,
    ...quiet ? {
      output: (stdout, stderr) => {
        for (const stream of [stdout, stderr])
          stream.on("data", (chunk) => {
            total += chunk.length;
            tail = Buffer.concat([tail, chunk]).subarray(-64 * 1024);
          });
      }
    } : {}
  });
  const failure = processFailure(command, outcome);
  if (failure) {
    if (quiet)
      console.error(`${total > tail.length ? "Earlier preparation output omitted.\n" : ""}${tail.toString("utf8")}`);
    throw failure;
  }
}
async function query(args) {
  const result = await captureOwnedChild(
    process.execPath,
    [cli, ...args],
    { cwd: root, env: environment, signal: cancellation.signal },
    16 * 1024 * 1024
  );
  const failure = processFailure("preparation metadata", result, result);
  if (failure) throw failure;
  return result.stdout;
}
try {
  await run(process.execPath, [cli, "project", "add", root]);
  const roots = JSON.parse(await query(["image-roots", ...selectedPaths.flatMap((path) => ["--path", path])]));
  if (!Array.isArray(roots) || !roots.length || roots.some((path) => typeof path !== "string"))
    throw new Error("Image preparation needs registered language roots");
  const paths = roots;
  if (!verify && mode !== "dependencies-only" && mode !== "acquire-only" && builder === "native") {
    for (const path of paths)
      await run(process.execPath, [
        cli,
        "tools",
        "install",
        "--path",
        path,
        ...toolchainArgs,
        "--exclude-tool",
        "miri"
      ]);
    if (!toolchain && !skipCIToolchains) {
      const matrix = record(JSON.parse(await query(["check", "matrix"])), "Invalid check matrix");
      const include = record(matrix.native, "Missing native matrix").include;
      if (!Array.isArray(include)) throw new Error("Missing native matrix entries");
      const operatingSystem = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
      const entries = include.map((value) => record(value, "Invalid matrix entry")).filter(
        (entry) => entry.os === operatingSystem && entry.architecture === process.arch && paths.includes(String(entry.path))
      );
      for (const name of [
        ...new Set(entries.flatMap((entry) => entry.toolchain ? [string(entry.toolchain, "Invalid toolchain")] : []))
      ])
        await run(process.execPath, [cli, "tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
    }
  }
  if (mode === "verify-tools") {
    for (const path of paths)
      await run(process.execPath, [
        cli,
        "shell",
        "--path",
        path,
        "--environment",
        builder,
        ...toolchainArgs,
        "--",
        "node",
        "--version"
      ]);
  } else if (mode !== "tools-only") {
    for (const path of paths) {
      console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
      const selection = ["check", "--path", path, "--environment", builder, "--no-cache", ...toolchainArgs];
      if (!verify) await run(process.execPath, [cli, ...selection, "--role", "acquire"]);
      if (mode !== "acquire-only")
        await run(process.execPath, [cli, ...selection, "--role", "build", ...verify ? ["--role", "smoke"] : []]);
      console.log("::endgroup::");
    }
    if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
      const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
      await retainPnpmMetadata(root, cli, paths, cancellation.signal);
    }
  }
} finally {
  cancellation.close();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZGV2ZWxvcG1lbnQubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIGNhcHR1cmVPd25lZENoaWxkLCBwcm9jZXNzQ2FuY2VsbGF0aW9uIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL293bmVkLWNoaWxkLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0ZhaWx1cmUgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvcHJvY2Vzcy1vdXRjb21lLm1qc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vLyBTaGFyZWQgcmVjaXBlOiBhY3F1aXJlIGRlY2xhcmVkIGlucHV0cywgdGhlbiBwcm92ZSBmcmVzaCBvZmZsaW5lIGJ1aWxkcyBhbmQgc21va2UgZXhlY3V0aW9uLlxuY29uc3QgW2J1aWxkZXIsIC4uLm9wdGlvbnNdID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpO1xuaWYgKGJ1aWxkZXIgIT09IFwibmF0aXZlXCIgJiYgYnVpbGRlciAhPT0gXCJuaXhcIiAmJiBidWlsZGVyICE9PSBcImd1aXhcIilcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiVXNlIHByZXBhcmUtZGV2ZWxvcG1lbnQubWpzIG5hdGl2ZXxuaXh8Z3VpeCBbLS12ZXJpZnl8LS12ZXJpZnktdG9vbHN8LS10b29scy1vbmx5fC0tZGVwZW5kZW5jaWVzLW9ubHl8LS1hY3F1aXJlLW9ubHldIFstLXBhdGggUk9PVF0uLi4gWy0tdG9vbGNoYWluIE5BTUVdIFstLXNraXAtY2ktdG9vbGNoYWluc11cIixcbiAgKTtcbmNvbnN0IHNlbGVjdGVkUGF0aHM6IHN0cmluZ1tdID0gW107XG5sZXQgdG9vbGNoYWluOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5sZXQgc2tpcENJVG9vbGNoYWlucyA9IGZhbHNlO1xuY29uc3QgbW9kZXMgPSBbXCJ2ZXJpZnlcIiwgXCJ2ZXJpZnktdG9vbHNcIiwgXCJ0b29scy1vbmx5XCIsIFwiZGVwZW5kZW5jaWVzLW9ubHlcIiwgXCJhY3F1aXJlLW9ubHlcIl0gYXMgY29uc3Q7XG5sZXQgbW9kZTogXCJwcmVwYXJlXCIgfCAodHlwZW9mIG1vZGVzKVtudW1iZXJdID0gXCJwcmVwYXJlXCI7XG5mb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgb3B0aW9ucy5sZW5ndGg7IGluZGV4KyspIHtcbiAgY29uc3Qgb3B0aW9uID0gb3B0aW9uc1tpbmRleF07XG4gIGNvbnN0IHNlbGVjdGVkID0gbW9kZXMuZmluZCgoY2FuZGlkYXRlKSA9PiBvcHRpb24gPT09IGAtLSR7Y2FuZGlkYXRlfWApO1xuICBpZiAoc2VsZWN0ZWQgJiYgbW9kZSA9PT0gXCJwcmVwYXJlXCIpIG1vZGUgPSBzZWxlY3RlZDtcbiAgZWxzZSBpZiAob3B0aW9uID09PSBcIi0tcGF0aFwiICYmIG9wdGlvbnNbaW5kZXggKyAxXSAmJiAhb3B0aW9uc1tpbmRleCArIDFdPy5zdGFydHNXaXRoKFwiLS1cIikpXG4gICAgc2VsZWN0ZWRQYXRocy5wdXNoKHN0cmluZyhvcHRpb25zWysraW5kZXhdLCBcIk1pc3NpbmcgcHJlcGFyYXRpb24gcGF0aFwiKSk7XG4gIGVsc2UgaWYgKG9wdGlvbiA9PT0gXCItLXRvb2xjaGFpblwiICYmICF0b29sY2hhaW4gJiYgL15bYS16XVthLXowLTlfLV0qJC8udGVzdChvcHRpb25zW2luZGV4ICsgMV0gPz8gXCJcIikpXG4gICAgdG9vbGNoYWluID0gb3B0aW9uc1srK2luZGV4XTtcbiAgZWxzZSBpZiAob3B0aW9uID09PSBcIi0tc2tpcC1jaS10b29sY2hhaW5zXCIgJiYgIXNraXBDSVRvb2xjaGFpbnMpIHNraXBDSVRvb2xjaGFpbnMgPSB0cnVlO1xuICBlbHNlIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBwcmVwYXJhdGlvbiBvcHRpb246ICR7U3RyaW5nKG9wdGlvbil9YCk7XG59XG5pZiAodG9vbGNoYWluICYmIGJ1aWxkZXIgIT09IFwibmF0aXZlXCIpIHRocm93IG5ldyBFcnJvcihcIi0tdG9vbGNoYWluIHNlbGVjdHMgYSBuYXRpdmUgcHJlcGFyYXRpb24gdG9vbGNoYWluXCIpO1xuY29uc3QgdG9vbGNoYWluQXJncyA9IHRvb2xjaGFpbiA/IFtcIi0tdG9vbGNoYWluXCIsIHRvb2xjaGFpbl0gOiBbXTtcbmNvbnN0IHZlcmlmeSA9IG1vZGUgPT09IFwidmVyaWZ5XCIgfHwgbW9kZSA9PT0gXCJ2ZXJpZnktdG9vbHNcIjtcbmNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbmNvbnN0IHJvb3QgPSByZXNvbHZlKHByb2Nlc3MuZW52LldPUktCRU5DSF9QUk9KRUNUX1JPT1QgPz8gcHJvY2Vzcy5jd2QoKSk7XG5jb25zdCBjbGkgPSBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKTtcbmNvbnN0IGVudmlyb25tZW50ID0geyAuLi5wcm9jZXNzLmVudiwgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogcm9vdCwgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiBkaXN0cmlidXRpb24gfTtcbmlmICghdmVyaWZ5ICYmIGJ1aWxkZXIgIT09IFwibmF0aXZlXCIpXG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIk1hbmFnZWQgaW1hZ2VzIGFyZSBhc3NlbWJsZWQgYnkgc2NyaXB0cy9wcmVwYXJlLW1hbmFnZWQtZGV2ZWxvcG1lbnQubWpzIGZyb20gdGhlaXIgZGVjbGFyZWQgY2xvc3VyZXNcIixcbiAgKTtcbmNvbnN0IGNhbmNlbGxhdGlvbiA9IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbmFzeW5jIGZ1bmN0aW9uIHJ1bihjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBjd2QgPSByb290KSB7XG4gIGNvbnN0IHF1aWV0ID0gIXZlcmlmeSAmJiBhcmdzWzFdID09PSBcInRvb2xzXCIgJiYgYXJnc1syXSA9PT0gXCJpbnN0YWxsXCI7XG4gIGxldCB0YWlsID0gQnVmZmVyLmFsbG9jKDApLFxuICAgIHRvdGFsID0gMDtcbiAgaWYgKHF1aWV0KSBjb25zb2xlLmxvZyhgUHJlcGFyaW5nIHZlcmlmaWVkIG5hdGl2ZSB0b29scyAoJHthcmdzLnNsaWNlKDMpLmpvaW4oXCIgXCIpfSkuLi5gKTtcbiAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgYXJncywge1xuICAgIGN3ZCxcbiAgICBlbnY6IGVudmlyb25tZW50LFxuICAgIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCxcbiAgICAuLi4ocXVpZXRcbiAgICAgID8ge1xuICAgICAgICAgIG91dHB1dDogKHN0ZG91dDogTm9kZUpTLlJlYWRhYmxlU3RyZWFtLCBzdGRlcnI6IE5vZGVKUy5SZWFkYWJsZVN0cmVhbSkgPT4ge1xuICAgICAgICAgICAgZm9yIChjb25zdCBzdHJlYW0gb2YgW3N0ZG91dCwgc3RkZXJyXSlcbiAgICAgICAgICAgICAgc3RyZWFtLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgICAgICAgICAgIHRvdGFsICs9IGNodW5rLmxlbmd0aDtcbiAgICAgICAgICAgICAgICB0YWlsID0gQnVmZmVyLmNvbmNhdChbdGFpbCwgY2h1bmtdKS5zdWJhcnJheSgtNjQgKiAxMDI0KTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfVxuICAgICAgOiB7fSksXG4gIH0pO1xuICBjb25zdCBmYWlsdXJlID0gcHJvY2Vzc0ZhaWx1cmUoY29tbWFuZCwgb3V0Y29tZSk7XG4gIGlmIChmYWlsdXJlKSB7XG4gICAgaWYgKHF1aWV0KVxuICAgICAgY29uc29sZS5lcnJvcihgJHt0b3RhbCA+IHRhaWwubGVuZ3RoID8gXCJFYXJsaWVyIHByZXBhcmF0aW9uIG91dHB1dCBvbWl0dGVkLlxcblwiIDogXCJcIn0ke3RhaWwudG9TdHJpbmcoXCJ1dGY4XCIpfWApO1xuICAgIHRocm93IGZhaWx1cmU7XG4gIH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5KGFyZ3M6IHN0cmluZ1tdKSB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhcHR1cmVPd25lZENoaWxkKFxuICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgW2NsaSwgLi4uYXJnc10sXG4gICAgeyBjd2Q6IHJvb3QsIGVudjogZW52aXJvbm1lbnQsIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCB9LFxuICAgIDE2ICogMTAyNCAqIDEwMjQsXG4gICk7XG4gIGNvbnN0IGZhaWx1cmUgPSBwcm9jZXNzRmFpbHVyZShcInByZXBhcmF0aW9uIG1ldGFkYXRhXCIsIHJlc3VsdCwgcmVzdWx0KTtcbiAgaWYgKGZhaWx1cmUpIHRocm93IGZhaWx1cmU7XG4gIHJldHVybiByZXN1bHQuc3Rkb3V0O1xufVxudHJ5IHtcbiAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtjbGksIFwicHJvamVjdFwiLCBcImFkZFwiLCByb290XSk7XG4gIGNvbnN0IHJvb3RzOiB1bmtub3duID0gSlNPTi5wYXJzZShhd2FpdCBxdWVyeShbXCJpbWFnZS1yb290c1wiLCAuLi5zZWxlY3RlZFBhdGhzLmZsYXRNYXAoKHBhdGgpID0+IFtcIi0tcGF0aFwiLCBwYXRoXSldKSk7XG4gIGlmICghQXJyYXkuaXNBcnJheShyb290cykgfHwgIXJvb3RzLmxlbmd0aCB8fCByb290cy5zb21lKChwYXRoOiB1bmtub3duKSA9PiB0eXBlb2YgcGF0aCAhPT0gXCJzdHJpbmdcIikpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW1hZ2UgcHJlcGFyYXRpb24gbmVlZHMgcmVnaXN0ZXJlZCBsYW5ndWFnZSByb290c1wiKTtcbiAgY29uc3QgcGF0aHMgPSByb290cyBhcyBzdHJpbmdbXTtcbiAgaWYgKCF2ZXJpZnkgJiYgbW9kZSAhPT0gXCJkZXBlbmRlbmNpZXMtb25seVwiICYmIG1vZGUgIT09IFwiYWNxdWlyZS1vbmx5XCIgJiYgYnVpbGRlciA9PT0gXCJuYXRpdmVcIikge1xuICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocylcbiAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbXG4gICAgICAgIGNsaSxcbiAgICAgICAgXCJ0b29sc1wiLFxuICAgICAgICBcImluc3RhbGxcIixcbiAgICAgICAgXCItLXBhdGhcIixcbiAgICAgICAgcGF0aCxcbiAgICAgICAgLi4udG9vbGNoYWluQXJncyxcbiAgICAgICAgXCItLWV4Y2x1ZGUtdG9vbFwiLFxuICAgICAgICBcIm1pcmlcIixcbiAgICAgIF0pO1xuICAgIC8vIE9wdGlvbmFsIENJIHRvb2wgdmFyaWFudHMgY29udHJpYnV0ZSBTREtzLCBidXQgQ0kgZG9lcyBub3Qgc2VsZWN0IGltYWdlIHJvb3RzIG9yIHZlcmlmaWNhdGlvbiBzdWl0ZXMuXG4gICAgaWYgKCF0b29sY2hhaW4gJiYgIXNraXBDSVRvb2xjaGFpbnMpIHtcbiAgICAgIGNvbnN0IG1hdHJpeCA9IHJlY29yZChKU09OLnBhcnNlKGF3YWl0IHF1ZXJ5KFtcImNoZWNrXCIsIFwibWF0cml4XCJdKSksIFwiSW52YWxpZCBjaGVjayBtYXRyaXhcIik7XG4gICAgICBjb25zdCBpbmNsdWRlID0gcmVjb3JkKG1hdHJpeC5uYXRpdmUsIFwiTWlzc2luZyBuYXRpdmUgbWF0cml4XCIpLmluY2x1ZGU7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkoaW5jbHVkZSkpIHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgbmF0aXZlIG1hdHJpeCBlbnRyaWVzXCIpO1xuICAgICAgY29uc3Qgb3BlcmF0aW5nU3lzdGVtID1cbiAgICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwibWFjb3NcIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwid2luZG93c1wiIDogcHJvY2Vzcy5wbGF0Zm9ybTtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBpbmNsdWRlXG4gICAgICAgIC5tYXAoKHZhbHVlOiB1bmtub3duKSA9PiByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBtYXRyaXggZW50cnlcIikpXG4gICAgICAgIC5maWx0ZXIoXG4gICAgICAgICAgKGVudHJ5KSA9PlxuICAgICAgICAgICAgZW50cnkub3MgPT09IG9wZXJhdGluZ1N5c3RlbSAmJiBlbnRyeS5hcmNoaXRlY3R1cmUgPT09IHByb2Nlc3MuYXJjaCAmJiBwYXRocy5pbmNsdWRlcyhTdHJpbmcoZW50cnkucGF0aCkpLFxuICAgICAgICApO1xuICAgICAgZm9yIChjb25zdCBuYW1lIG9mIFtcbiAgICAgICAgLi4ubmV3IFNldChlbnRyaWVzLmZsYXRNYXAoKGVudHJ5KSA9PiAoZW50cnkudG9vbGNoYWluID8gW3N0cmluZyhlbnRyeS50b29sY2hhaW4sIFwiSW52YWxpZCB0b29sY2hhaW5cIildIDogW10pKSksXG4gICAgICBdKVxuICAgICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgXCJ0b29sc1wiLCBcImluc3RhbGxcIiwgXCItLXRvb2xjaGFpblwiLCBuYW1lLCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiXSk7XG4gICAgfVxuICB9XG4gIGlmIChtb2RlID09PSBcInZlcmlmeS10b29sc1wiKSB7XG4gICAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKVxuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgY2xpLFxuICAgICAgICBcInNoZWxsXCIsXG4gICAgICAgIFwiLS1wYXRoXCIsXG4gICAgICAgIHBhdGgsXG4gICAgICAgIFwiLS1lbnZpcm9ubWVudFwiLFxuICAgICAgICBidWlsZGVyLFxuICAgICAgICAuLi50b29sY2hhaW5BcmdzLFxuICAgICAgICBcIi0tXCIsXG4gICAgICAgIFwibm9kZVwiLFxuICAgICAgICBcIi0tdmVyc2lvblwiLFxuICAgICAgXSk7XG4gIH0gZWxzZSBpZiAobW9kZSAhPT0gXCJ0b29scy1vbmx5XCIpIHtcbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICAgIGNvbnNvbGUubG9nKGA6Omdyb3VwOjoke3ZlcmlmeSA/IFwiT2ZmbGluZSB2ZXJpZmljYXRpb25cIiA6IFwiUHJlcGFyZVwifTogJHtidWlsZGVyfSAke3BhdGh9YCk7XG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSBbXCJjaGVja1wiLCBcIi0tcGF0aFwiLCBwYXRoLCBcIi0tZW52aXJvbm1lbnRcIiwgYnVpbGRlciwgXCItLW5vLWNhY2hlXCIsIC4uLnRvb2xjaGFpbkFyZ3NdO1xuICAgICAgaWYgKCF2ZXJpZnkpIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCAuLi5zZWxlY3Rpb24sIFwiLS1yb2xlXCIsIFwiYWNxdWlyZVwiXSk7XG4gICAgICAvLyBPbmUgc2V0dXAgYW5kIGJ1aWxkIHNlc3Npb24gcmV0YWlucyB0aGUgZnJlc2ggb3V0cHV0cyBmb3Igc21va2UgZXhlY3V0aW9uLlxuICAgICAgaWYgKG1vZGUgIT09IFwiYWNxdWlyZS1vbmx5XCIpXG4gICAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCAuLi5zZWxlY3Rpb24sIFwiLS1yb2xlXCIsIFwiYnVpbGRcIiwgLi4uKHZlcmlmeSA/IFtcIi0tcm9sZVwiLCBcInNtb2tlXCJdIDogW10pXSk7XG4gICAgICBjb25zb2xlLmxvZyhcIjo6ZW5kZ3JvdXA6OlwiKTtcbiAgICB9XG5cbiAgICBpZiAoYnVpbGRlciA9PT0gXCJuYXRpdmVcIiAmJiAhdmVyaWZ5ICYmIHBhdGhzLnNvbWUoKHBhdGgpID0+IGV4aXN0c1N5bmMoam9pbihyb290LCBwYXRoLCBcInBucG0tbG9jay55YW1sXCIpKSkpIHtcbiAgICAgIGNvbnN0IHsgcmV0YWluUG5wbU1ldGFkYXRhIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3BucG0tbWV0YWRhdGEubWpzXCIpO1xuICAgICAgYXdhaXQgcmV0YWluUG5wbU1ldGFkYXRhKHJvb3QsIGNsaSwgcGF0aHMsIGNhbmNlbGxhdGlvbi5zaWduYWwpO1xuICAgIH1cbiAgfVxufSBmaW5hbGx5IHtcbiAgY2FuY2VsbGF0aW9uLmNsb3NlKCk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsY0FBYztBQUMvQixTQUFTLGVBQWUsbUJBQW1CLDJCQUEyQjtBQUN0RSxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLE1BQU0sZUFBZTtBQUc5QixNQUFNLENBQUMsU0FBUyxHQUFHLE9BQU8sSUFBSSxRQUFRLEtBQUssTUFBTSxDQUFDO0FBQ2xELElBQUksWUFBWSxZQUFZLFlBQVksU0FBUyxZQUFZO0FBQzNELFFBQU0sSUFBSTtBQUFBLElBQ1I7QUFBQSxFQUNGO0FBQ0YsTUFBTSxnQkFBMEIsQ0FBQztBQUNqQyxJQUFJO0FBQ0osSUFBSSxtQkFBbUI7QUFDdkIsTUFBTSxRQUFRLENBQUMsVUFBVSxnQkFBZ0IsY0FBYyxxQkFBcUIsY0FBYztBQUMxRixJQUFJLE9BQTJDO0FBQy9DLFNBQVMsUUFBUSxHQUFHLFFBQVEsUUFBUSxRQUFRLFNBQVM7QUFDbkQsUUFBTSxTQUFTLFFBQVEsS0FBSztBQUM1QixRQUFNLFdBQVcsTUFBTSxLQUFLLENBQUMsY0FBYyxXQUFXLEtBQUssU0FBUyxFQUFFO0FBQ3RFLE1BQUksWUFBWSxTQUFTLFVBQVcsUUFBTztBQUFBLFdBQ2xDLFdBQVcsWUFBWSxRQUFRLFFBQVEsQ0FBQyxLQUFLLENBQUMsUUFBUSxRQUFRLENBQUMsR0FBRyxXQUFXLElBQUk7QUFDeEYsa0JBQWMsS0FBSyxPQUFPLFFBQVEsRUFBRSxLQUFLLEdBQUcsMEJBQTBCLENBQUM7QUFBQSxXQUNoRSxXQUFXLGlCQUFpQixDQUFDLGFBQWEscUJBQXFCLEtBQUssUUFBUSxRQUFRLENBQUMsS0FBSyxFQUFFO0FBQ25HLGdCQUFZLFFBQVEsRUFBRSxLQUFLO0FBQUEsV0FDcEIsV0FBVywwQkFBMEIsQ0FBQyxpQkFBa0Isb0JBQW1CO0FBQUEsTUFDL0UsT0FBTSxJQUFJLE1BQU0sK0JBQStCLE9BQU8sTUFBTSxDQUFDLEVBQUU7QUFDdEU7QUFDQSxJQUFJLGFBQWEsWUFBWSxTQUFVLE9BQU0sSUFBSSxNQUFNLG9EQUFvRDtBQUMzRyxNQUFNLGdCQUFnQixZQUFZLENBQUMsZUFBZSxTQUFTLElBQUksQ0FBQztBQUNoRSxNQUFNLFNBQVMsU0FBUyxZQUFZLFNBQVM7QUFDN0MsTUFBTSxlQUFlLFFBQVEsWUFBWSxTQUFTLElBQUk7QUFDdEQsTUFBTSxPQUFPLFFBQVEsUUFBUSxJQUFJLDBCQUEwQixRQUFRLElBQUksQ0FBQztBQUN4RSxNQUFNLE1BQU0sS0FBSyxjQUFjLG1CQUFtQjtBQUNsRCxNQUFNLGNBQWMsRUFBRSxHQUFHLFFBQVEsS0FBSyx3QkFBd0IsTUFBTSw2QkFBNkIsYUFBYTtBQUM5RyxJQUFJLENBQUMsVUFBVSxZQUFZO0FBQ3pCLFFBQU0sSUFBSTtBQUFBLElBQ1I7QUFBQSxFQUNGO0FBQ0YsTUFBTSxlQUFlLG9CQUFvQjtBQUN6QyxlQUFlLElBQUksU0FBaUIsTUFBZ0IsTUFBTSxNQUFNO0FBQzlELFFBQU0sUUFBUSxDQUFDLFVBQVUsS0FBSyxDQUFDLE1BQU0sV0FBVyxLQUFLLENBQUMsTUFBTTtBQUM1RCxNQUFJLE9BQU8sT0FBTyxNQUFNLENBQUMsR0FDdkIsUUFBUTtBQUNWLE1BQUksTUFBTyxTQUFRLElBQUksb0NBQW9DLEtBQUssTUFBTSxDQUFDLEVBQUUsS0FBSyxHQUFHLENBQUMsTUFBTTtBQUN4RixRQUFNLFVBQVUsTUFBTSxjQUFjLFNBQVMsTUFBTTtBQUFBLElBQ2pEO0FBQUEsSUFDQSxLQUFLO0FBQUEsSUFDTCxRQUFRLGFBQWE7QUFBQSxJQUNyQixHQUFJLFFBQ0E7QUFBQSxNQUNFLFFBQVEsQ0FBQyxRQUErQixXQUFrQztBQUN4RSxtQkFBVyxVQUFVLENBQUMsUUFBUSxNQUFNO0FBQ2xDLGlCQUFPLEdBQUcsUUFBUSxDQUFDLFVBQWtCO0FBQ25DLHFCQUFTLE1BQU07QUFDZixtQkFBTyxPQUFPLE9BQU8sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLFNBQVMsTUFBTSxJQUFJO0FBQUEsVUFDekQsQ0FBQztBQUFBLE1BQ0w7QUFBQSxJQUNGLElBQ0EsQ0FBQztBQUFBLEVBQ1AsQ0FBQztBQUNELFFBQU0sVUFBVSxlQUFlLFNBQVMsT0FBTztBQUMvQyxNQUFJLFNBQVM7QUFDWCxRQUFJO0FBQ0YsY0FBUSxNQUFNLEdBQUcsUUFBUSxLQUFLLFNBQVMsMENBQTBDLEVBQUUsR0FBRyxLQUFLLFNBQVMsTUFBTSxDQUFDLEVBQUU7QUFDL0csVUFBTTtBQUFBLEVBQ1I7QUFDRjtBQUNBLGVBQWUsTUFBTSxNQUFnQjtBQUNuQyxRQUFNLFNBQVMsTUFBTTtBQUFBLElBQ25CLFFBQVE7QUFBQSxJQUNSLENBQUMsS0FBSyxHQUFHLElBQUk7QUFBQSxJQUNiLEVBQUUsS0FBSyxNQUFNLEtBQUssYUFBYSxRQUFRLGFBQWEsT0FBTztBQUFBLElBQzNELEtBQUssT0FBTztBQUFBLEVBQ2Q7QUFDQSxRQUFNLFVBQVUsZUFBZSx3QkFBd0IsUUFBUSxNQUFNO0FBQ3JFLE1BQUksUUFBUyxPQUFNO0FBQ25CLFNBQU8sT0FBTztBQUNoQjtBQUNBLElBQUk7QUFDRixRQUFNLElBQUksUUFBUSxVQUFVLENBQUMsS0FBSyxXQUFXLE9BQU8sSUFBSSxDQUFDO0FBQ3pELFFBQU0sUUFBaUIsS0FBSyxNQUFNLE1BQU0sTUFBTSxDQUFDLGVBQWUsR0FBRyxjQUFjLFFBQVEsQ0FBQyxTQUFTLENBQUMsVUFBVSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEgsTUFBSSxDQUFDLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQyxNQUFNLFVBQVUsTUFBTSxLQUFLLENBQUMsU0FBa0IsT0FBTyxTQUFTLFFBQVE7QUFDbEcsVUFBTSxJQUFJLE1BQU0sbURBQW1EO0FBQ3JFLFFBQU0sUUFBUTtBQUNkLE1BQUksQ0FBQyxVQUFVLFNBQVMsdUJBQXVCLFNBQVMsa0JBQWtCLFlBQVksVUFBVTtBQUM5RixlQUFXLFFBQVE7QUFDakIsWUFBTSxJQUFJLFFBQVEsVUFBVTtBQUFBLFFBQzFCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0EsR0FBRztBQUFBLFFBQ0g7QUFBQSxRQUNBO0FBQUEsTUFDRixDQUFDO0FBRUgsUUFBSSxDQUFDLGFBQWEsQ0FBQyxrQkFBa0I7QUFDbkMsWUFBTSxTQUFTLE9BQU8sS0FBSyxNQUFNLE1BQU0sTUFBTSxDQUFDLFNBQVMsUUFBUSxDQUFDLENBQUMsR0FBRyxzQkFBc0I7QUFDMUYsWUFBTSxVQUFVLE9BQU8sT0FBTyxRQUFRLHVCQUF1QixFQUFFO0FBQy9ELFVBQUksQ0FBQyxNQUFNLFFBQVEsT0FBTyxFQUFHLE9BQU0sSUFBSSxNQUFNLCtCQUErQjtBQUM1RSxZQUFNLGtCQUNKLFFBQVEsYUFBYSxXQUFXLFVBQVUsUUFBUSxhQUFhLFVBQVUsWUFBWSxRQUFRO0FBQy9GLFlBQU0sVUFBVSxRQUNiLElBQUksQ0FBQyxVQUFtQixPQUFPLE9BQU8sc0JBQXNCLENBQUMsRUFDN0Q7QUFBQSxRQUNDLENBQUMsVUFDQyxNQUFNLE9BQU8sbUJBQW1CLE1BQU0saUJBQWlCLFFBQVEsUUFBUSxNQUFNLFNBQVMsT0FBTyxNQUFNLElBQUksQ0FBQztBQUFBLE1BQzVHO0FBQ0YsaUJBQVcsUUFBUTtBQUFBLFFBQ2pCLEdBQUcsSUFBSSxJQUFJLFFBQVEsUUFBUSxDQUFDLFVBQVcsTUFBTSxZQUFZLENBQUMsT0FBTyxNQUFNLFdBQVcsbUJBQW1CLENBQUMsSUFBSSxDQUFDLENBQUUsQ0FBQztBQUFBLE1BQ2hIO0FBQ0UsY0FBTSxJQUFJLFFBQVEsVUFBVSxDQUFDLEtBQUssU0FBUyxXQUFXLGVBQWUsTUFBTSxrQkFBa0IsTUFBTSxDQUFDO0FBQUEsSUFDeEc7QUFBQSxFQUNGO0FBQ0EsTUFBSSxTQUFTLGdCQUFnQjtBQUMzQixlQUFXLFFBQVE7QUFDakIsWUFBTSxJQUFJLFFBQVEsVUFBVTtBQUFBLFFBQzFCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLEdBQUc7QUFBQSxRQUNIO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLENBQUM7QUFBQSxFQUNMLFdBQVcsU0FBUyxjQUFjO0FBQ2hDLGVBQVcsUUFBUSxPQUFPO0FBQ3hCLGNBQVEsSUFBSSxZQUFZLFNBQVMseUJBQXlCLFNBQVMsS0FBSyxPQUFPLElBQUksSUFBSSxFQUFFO0FBQ3pGLFlBQU0sWUFBWSxDQUFDLFNBQVMsVUFBVSxNQUFNLGlCQUFpQixTQUFTLGNBQWMsR0FBRyxhQUFhO0FBQ3BHLFVBQUksQ0FBQyxPQUFRLE9BQU0sSUFBSSxRQUFRLFVBQVUsQ0FBQyxLQUFLLEdBQUcsV0FBVyxVQUFVLFNBQVMsQ0FBQztBQUVqRixVQUFJLFNBQVM7QUFDWCxjQUFNLElBQUksUUFBUSxVQUFVLENBQUMsS0FBSyxHQUFHLFdBQVcsVUFBVSxTQUFTLEdBQUksU0FBUyxDQUFDLFVBQVUsT0FBTyxJQUFJLENBQUMsQ0FBRSxDQUFDO0FBQzVHLGNBQVEsSUFBSSxjQUFjO0FBQUEsSUFDNUI7QUFFQSxRQUFJLFlBQVksWUFBWSxDQUFDLFVBQVUsTUFBTSxLQUFLLENBQUMsU0FBUyxXQUFXLEtBQUssTUFBTSxNQUFNLGdCQUFnQixDQUFDLENBQUMsR0FBRztBQUMzRyxZQUFNLEVBQUUsbUJBQW1CLElBQUksTUFBTSxPQUFPLHFCQUFxQjtBQUNqRSxZQUFNLG1CQUFtQixNQUFNLEtBQUssT0FBTyxhQUFhLE1BQU07QUFBQSxJQUNoRTtBQUFBLEVBQ0Y7QUFDRixVQUFFO0FBQ0EsZUFBYSxNQUFNO0FBQ3JCOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcHJlcGFyZS1kZXZlbG9wbWVudC5tanMifQ==
