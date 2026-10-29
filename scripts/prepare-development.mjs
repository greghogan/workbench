// Generated from prepare-development.mts; edit the TypeScript source.
import { record, string } from "./values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
const [builder, ...options] = process.argv.slice(2);
if (builder !== "native" && builder !== "nix" && builder !== "guix")
  throw new Error("Use prepare-development.mjs native|nix|guix [--verify] [--path ROOT]...");
const selectedPaths = [];
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
  if (!verify && builder === "native") {
    for (const path of paths)
      await run(process.execPath, [cli, "tools", "install", "--path", path, "--exclude-tool", "miri"]);
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
  for (const path of paths) {
    console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
    const selection = ["check", "--path", path, "--environment", builder, "--no-cache"];
    if (!verify) await run(process.execPath, [cli, ...selection, "--role", "acquire"]);
    await run(process.execPath, [cli, ...selection, "--role", "build", ...verify ? ["--role", "smoke"] : []]);
    console.log("::endgroup::");
  }
  if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
    const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
    await retainPnpmMetadata(root, cli, paths, cancellation.signal);
  }
} finally {
  cancellation.close();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZGV2ZWxvcG1lbnQubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgcnVuT3duZWRDaGlsZCwgY2FwdHVyZU93bmVkQ2hpbGQsIHByb2Nlc3NDYW5jZWxsYXRpb24gfSBmcm9tIFwiLi9vd25lZC1jaGlsZC5tanNcIjtcbmltcG9ydCB7IHByb2Nlc3NGYWlsdXJlIH0gZnJvbSBcIi4vcHJvY2Vzcy1vdXRjb21lLm1qc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vLyBTaGFyZWQgcmVjaXBlOiBhY3F1aXJlIGRlY2xhcmVkIGlucHV0cywgdGhlbiBwcm92ZSBmcmVzaCBvZmZsaW5lIGJ1aWxkcyBhbmQgc21va2UgZXhlY3V0aW9uLlxuY29uc3QgW2J1aWxkZXIsIC4uLm9wdGlvbnNdID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpO1xuaWYgKGJ1aWxkZXIgIT09IFwibmF0aXZlXCIgJiYgYnVpbGRlciAhPT0gXCJuaXhcIiAmJiBidWlsZGVyICE9PSBcImd1aXhcIilcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHByZXBhcmUtZGV2ZWxvcG1lbnQubWpzIG5hdGl2ZXxuaXh8Z3VpeCBbLS12ZXJpZnldIFstLXBhdGggUk9PVF0uLi5cIik7XG5jb25zdCBzZWxlY3RlZFBhdGhzOiBzdHJpbmdbXSA9IFtdO1xubGV0IHZlcmlmeSA9IGZhbHNlO1xuZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IG9wdGlvbnMubGVuZ3RoOyBpbmRleCsrKSB7XG4gIGNvbnN0IG9wdGlvbiA9IG9wdGlvbnNbaW5kZXhdO1xuICBpZiAob3B0aW9uID09PSBcIi0tdmVyaWZ5XCIgJiYgIXZlcmlmeSkgdmVyaWZ5ID0gdHJ1ZTtcbiAgZWxzZSBpZiAob3B0aW9uID09PSBcIi0tcGF0aFwiICYmIG9wdGlvbnNbaW5kZXggKyAxXSAmJiAhb3B0aW9uc1tpbmRleCArIDFdPy5zdGFydHNXaXRoKFwiLS1cIikpXG4gICAgc2VsZWN0ZWRQYXRocy5wdXNoKHN0cmluZyhvcHRpb25zWysraW5kZXhdLCBcIk1pc3NpbmcgcHJlcGFyYXRpb24gcGF0aFwiKSk7XG4gIGVsc2UgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHByZXBhcmF0aW9uIG9wdGlvbjogJHtTdHJpbmcob3B0aW9uKX1gKTtcbn1cbmNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbmNvbnN0IHJvb3QgPSByZXNvbHZlKHByb2Nlc3MuZW52LldPUktCRU5DSF9QUk9KRUNUX1JPT1QgPz8gcHJvY2Vzcy5jd2QoKSk7XG5jb25zdCBjbGkgPSBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKTtcbmNvbnN0IGVudmlyb25tZW50ID0geyAuLi5wcm9jZXNzLmVudiwgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogcm9vdCwgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiBkaXN0cmlidXRpb24gfTtcbmlmICghdmVyaWZ5ICYmIGJ1aWxkZXIgIT09IFwibmF0aXZlXCIpXG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIk1hbmFnZWQgaW1hZ2VzIGFyZSBhc3NlbWJsZWQgYnkgc2NyaXB0cy9wcmVwYXJlLW1hbmFnZWQtZGV2ZWxvcG1lbnQubWpzIGZyb20gdGhlaXIgZGVjbGFyZWQgY2xvc3VyZXNcIixcbiAgKTtcbmNvbnN0IGNhbmNlbGxhdGlvbiA9IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbmFzeW5jIGZ1bmN0aW9uIHJ1bihjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBjd2QgPSByb290KSB7XG4gIGNvbnN0IHF1aWV0ID0gIXZlcmlmeSAmJiBhcmdzWzFdID09PSBcInRvb2xzXCIgJiYgYXJnc1syXSA9PT0gXCJpbnN0YWxsXCI7XG4gIGxldCB0YWlsID0gQnVmZmVyLmFsbG9jKDApLFxuICAgIHRvdGFsID0gMDtcbiAgaWYgKHF1aWV0KSBjb25zb2xlLmxvZyhgUHJlcGFyaW5nIHZlcmlmaWVkIG5hdGl2ZSB0b29scyAoJHthcmdzLnNsaWNlKDMpLmpvaW4oXCIgXCIpfSkuLi5gKTtcbiAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHJ1bk93bmVkQ2hpbGQoY29tbWFuZCwgYXJncywge1xuICAgIGN3ZCxcbiAgICBlbnY6IGVudmlyb25tZW50LFxuICAgIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCxcbiAgICAuLi4ocXVpZXRcbiAgICAgID8ge1xuICAgICAgICAgIG91dHB1dDogKHN0ZG91dDogTm9kZUpTLlJlYWRhYmxlU3RyZWFtLCBzdGRlcnI6IE5vZGVKUy5SZWFkYWJsZVN0cmVhbSkgPT4ge1xuICAgICAgICAgICAgZm9yIChjb25zdCBzdHJlYW0gb2YgW3N0ZG91dCwgc3RkZXJyXSlcbiAgICAgICAgICAgICAgc3RyZWFtLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgICAgICAgICAgIHRvdGFsICs9IGNodW5rLmxlbmd0aDtcbiAgICAgICAgICAgICAgICB0YWlsID0gQnVmZmVyLmNvbmNhdChbdGFpbCwgY2h1bmtdKS5zdWJhcnJheSgtNjQgKiAxMDI0KTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfVxuICAgICAgOiB7fSksXG4gIH0pO1xuICBjb25zdCBmYWlsdXJlID0gcHJvY2Vzc0ZhaWx1cmUoY29tbWFuZCwgb3V0Y29tZSk7XG4gIGlmIChmYWlsdXJlKSB7XG4gICAgaWYgKHF1aWV0KVxuICAgICAgY29uc29sZS5lcnJvcihgJHt0b3RhbCA+IHRhaWwubGVuZ3RoID8gXCJFYXJsaWVyIHByZXBhcmF0aW9uIG91dHB1dCBvbWl0dGVkLlxcblwiIDogXCJcIn0ke3RhaWwudG9TdHJpbmcoXCJ1dGY4XCIpfWApO1xuICAgIHRocm93IGZhaWx1cmU7XG4gIH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5KGFyZ3M6IHN0cmluZ1tdKSB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhcHR1cmVPd25lZENoaWxkKFxuICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgW2NsaSwgLi4uYXJnc10sXG4gICAgeyBjd2Q6IHJvb3QsIGVudjogZW52aXJvbm1lbnQsIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCB9LFxuICAgIDE2ICogMTAyNCAqIDEwMjQsXG4gICk7XG4gIGNvbnN0IGZhaWx1cmUgPSBwcm9jZXNzRmFpbHVyZShcInByZXBhcmF0aW9uIG1ldGFkYXRhXCIsIHJlc3VsdCwgcmVzdWx0KTtcbiAgaWYgKGZhaWx1cmUpIHRocm93IGZhaWx1cmU7XG4gIHJldHVybiByZXN1bHQuc3Rkb3V0O1xufVxudHJ5IHtcbiAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtjbGksIFwicHJvamVjdFwiLCBcImFkZFwiLCByb290XSk7XG4gIGNvbnN0IHJvb3RzOiB1bmtub3duID0gSlNPTi5wYXJzZShhd2FpdCBxdWVyeShbXCJpbWFnZS1yb290c1wiLCAuLi5zZWxlY3RlZFBhdGhzLmZsYXRNYXAoKHBhdGgpID0+IFtcIi0tcGF0aFwiLCBwYXRoXSldKSk7XG4gIGlmICghQXJyYXkuaXNBcnJheShyb290cykgfHwgIXJvb3RzLmxlbmd0aCB8fCByb290cy5zb21lKChwYXRoOiB1bmtub3duKSA9PiB0eXBlb2YgcGF0aCAhPT0gXCJzdHJpbmdcIikpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW1hZ2UgcHJlcGFyYXRpb24gbmVlZHMgcmVnaXN0ZXJlZCBsYW5ndWFnZSByb290c1wiKTtcbiAgY29uc3QgcGF0aHMgPSByb290cyBhcyBzdHJpbmdbXTtcbiAgaWYgKCF2ZXJpZnkgJiYgYnVpbGRlciA9PT0gXCJuYXRpdmVcIikge1xuICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocylcbiAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCBcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tcGF0aFwiLCBwYXRoLCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiXSk7XG4gICAgLy8gT3B0aW9uYWwgQ0kgdG9vbCB2YXJpYW50cyBjb250cmlidXRlIFNES3MsIGJ1dCBDSSBkb2VzIG5vdCBzZWxlY3QgaW1hZ2Ugcm9vdHMgb3IgdmVyaWZpY2F0aW9uIHN1aXRlcy5cbiAgICBjb25zdCBtYXRyaXggPSByZWNvcmQoSlNPTi5wYXJzZShhd2FpdCBxdWVyeShbXCJjaGVja1wiLCBcIm1hdHJpeFwiXSkpLCBcIkludmFsaWQgY2hlY2sgbWF0cml4XCIpO1xuICAgIGNvbnN0IGluY2x1ZGUgPSByZWNvcmQobWF0cml4Lm5hdGl2ZSwgXCJNaXNzaW5nIG5hdGl2ZSBtYXRyaXhcIikuaW5jbHVkZTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoaW5jbHVkZSkpIHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgbmF0aXZlIG1hdHJpeCBlbnRyaWVzXCIpO1xuICAgIGNvbnN0IG9wZXJhdGluZ1N5c3RlbSA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJtYWNvc1wiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJ3aW5kb3dzXCIgOiBwcm9jZXNzLnBsYXRmb3JtO1xuICAgIGNvbnN0IGVudHJpZXMgPSBpbmNsdWRlXG4gICAgICAubWFwKCh2YWx1ZTogdW5rbm93bikgPT4gcmVjb3JkKHZhbHVlLCBcIkludmFsaWQgbWF0cml4IGVudHJ5XCIpKVxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKGVudHJ5KSA9PlxuICAgICAgICAgIGVudHJ5Lm9zID09PSBvcGVyYXRpbmdTeXN0ZW0gJiYgZW50cnkuYXJjaGl0ZWN0dXJlID09PSBwcm9jZXNzLmFyY2ggJiYgcGF0aHMuaW5jbHVkZXMoU3RyaW5nKGVudHJ5LnBhdGgpKSxcbiAgICAgICk7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIFtcbiAgICAgIC4uLm5ldyBTZXQoZW50cmllcy5mbGF0TWFwKChlbnRyeSkgPT4gKGVudHJ5LnRvb2xjaGFpbiA/IFtzdHJpbmcoZW50cnkudG9vbGNoYWluLCBcIkludmFsaWQgdG9vbGNoYWluXCIpXSA6IFtdKSkpLFxuICAgIF0pXG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgXCJ0b29sc1wiLCBcImluc3RhbGxcIiwgXCItLXRvb2xjaGFpblwiLCBuYW1lLCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiXSk7XG4gIH1cbiAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7XG4gICAgY29uc29sZS5sb2coYDo6Z3JvdXA6OiR7dmVyaWZ5ID8gXCJPZmZsaW5lIHZlcmlmaWNhdGlvblwiIDogXCJQcmVwYXJlXCJ9OiAke2J1aWxkZXJ9ICR7cGF0aH1gKTtcbiAgICBjb25zdCBzZWxlY3Rpb24gPSBbXCJjaGVja1wiLCBcIi0tcGF0aFwiLCBwYXRoLCBcIi0tZW52aXJvbm1lbnRcIiwgYnVpbGRlciwgXCItLW5vLWNhY2hlXCJdO1xuICAgIGlmICghdmVyaWZ5KSBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgLi4uc2VsZWN0aW9uLCBcIi0tcm9sZVwiLCBcImFjcXVpcmVcIl0pO1xuICAgIC8vIE9uZSBzZXR1cCBhbmQgYnVpbGQgc2Vzc2lvbiByZXRhaW5zIHRoZSBmcmVzaCBvdXRwdXRzIGZvciBzbW9rZSBleGVjdXRpb24uXG4gICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtjbGksIC4uLnNlbGVjdGlvbiwgXCItLXJvbGVcIiwgXCJidWlsZFwiLCAuLi4odmVyaWZ5ID8gW1wiLS1yb2xlXCIsIFwic21va2VcIl0gOiBbXSldKTtcbiAgICBjb25zb2xlLmxvZyhcIjo6ZW5kZ3JvdXA6OlwiKTtcbiAgfVxuXG4gIGlmIChidWlsZGVyID09PSBcIm5hdGl2ZVwiICYmICF2ZXJpZnkgJiYgcGF0aHMuc29tZSgocGF0aCkgPT4gZXhpc3RzU3luYyhqb2luKHJvb3QsIHBhdGgsIFwicG5wbS1sb2NrLnlhbWxcIikpKSkge1xuICAgIGNvbnN0IHsgcmV0YWluUG5wbU1ldGFkYXRhIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3BucG0tbWV0YWRhdGEubWpzXCIpO1xuICAgIGF3YWl0IHJldGFpblBucG1NZXRhZGF0YShyb290LCBjbGksIHBhdGhzLCBjYW5jZWxsYXRpb24uc2lnbmFsKTtcbiAgfVxufSBmaW5hbGx5IHtcbiAgY2FuY2VsbGF0aW9uLmNsb3NlKCk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsY0FBYztBQUMvQixTQUFTLGVBQWUsbUJBQW1CLDJCQUEyQjtBQUN0RSxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLE1BQU0sZUFBZTtBQUc5QixNQUFNLENBQUMsU0FBUyxHQUFHLE9BQU8sSUFBSSxRQUFRLEtBQUssTUFBTSxDQUFDO0FBQ2xELElBQUksWUFBWSxZQUFZLFlBQVksU0FBUyxZQUFZO0FBQzNELFFBQU0sSUFBSSxNQUFNLHlFQUF5RTtBQUMzRixNQUFNLGdCQUEwQixDQUFDO0FBQ2pDLElBQUksU0FBUztBQUNiLFNBQVMsUUFBUSxHQUFHLFFBQVEsUUFBUSxRQUFRLFNBQVM7QUFDbkQsUUFBTSxTQUFTLFFBQVEsS0FBSztBQUM1QixNQUFJLFdBQVcsY0FBYyxDQUFDLE9BQVEsVUFBUztBQUFBLFdBQ3RDLFdBQVcsWUFBWSxRQUFRLFFBQVEsQ0FBQyxLQUFLLENBQUMsUUFBUSxRQUFRLENBQUMsR0FBRyxXQUFXLElBQUk7QUFDeEYsa0JBQWMsS0FBSyxPQUFPLFFBQVEsRUFBRSxLQUFLLEdBQUcsMEJBQTBCLENBQUM7QUFBQSxNQUNwRSxPQUFNLElBQUksTUFBTSwrQkFBK0IsT0FBTyxNQUFNLENBQUMsRUFBRTtBQUN0RTtBQUNBLE1BQU0sZUFBZSxRQUFRLFlBQVksU0FBUyxJQUFJO0FBQ3RELE1BQU0sT0FBTyxRQUFRLFFBQVEsSUFBSSwwQkFBMEIs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
