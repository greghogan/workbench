// Generated from prepare-image-tools.mts; edit the TypeScript source.
import { record, string, strings } from "../app/src/core/runtime/values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { join, resolve } from "node:path";
import { isMainScript } from "./script-entry.mjs";
function openImagePreparation(quietTools) {
  const distribution = resolve(import.meta.dirname, "..");
  const root = resolve(process.env.WORKBENCH_PROJECT_ROOT ?? process.cwd());
  const cli = join(distribution, "bin/workbench.mjs");
  const environment = { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution };
  const cancellation = processCancellation();
  async function run(args) {
    const quiet = quietTools && args[0] === "tools" && args[1] === "install";
    let tail = Buffer.alloc(0), total = 0;
    if (quiet) console.log(`Preparing verified native tools (${args.slice(2).join(" ")})...`);
    const outcome = await runOwnedChild(process.execPath, [cli, ...args], {
      cwd: root,
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
    const failure = processFailure("image preparation", outcome);
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
  const paths = async (selectedPaths) => {
    const values = strings(
      JSON.parse(await query(["image-roots", ...selectedPaths.flatMap((path) => ["--path", path])])),
      "Invalid image language roots"
    );
    if (!values.length) throw new Error("Image preparation needs registered language roots");
    return values;
  };
  return { root, cli, cancellation, run, query, paths };
}
async function installImageTools({ run, query }, paths, toolchain, skipCIToolchains = false) {
  const toolchainArgs = toolchain ? ["--toolchain", toolchain] : [];
  for (const path of paths) await run(["tools", "install", "--path", path, ...toolchainArgs, "--exclude-tool", "miri"]);
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
export {
  installImageTools,
  openImagePreparation
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtaW1hZ2UtdG9vbHMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlY29yZCwgc3RyaW5nLCBzdHJpbmdzIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIGNhcHR1cmVPd25lZENoaWxkLCBwcm9jZXNzQ2FuY2VsbGF0aW9uIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL293bmVkLWNoaWxkLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0ZhaWx1cmUgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvcHJvY2Vzcy1vdXRjb21lLm1qc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGlzTWFpblNjcmlwdCB9IGZyb20gXCIuL3NjcmlwdC1lbnRyeS5tanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIG9wZW5JbWFnZVByZXBhcmF0aW9uKHF1aWV0VG9vbHM6IGJvb2xlYW4pIHtcbiAgY29uc3QgZGlzdHJpYnV0aW9uID0gcmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpO1xuICBjb25zdCByb290ID0gcmVzb2x2ZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJPSkVDVF9ST09UID8/IHByb2Nlc3MuY3dkKCkpO1xuICBjb25zdCBjbGkgPSBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKTtcbiAgY29uc3QgZW52aXJvbm1lbnQgPSB7IC4uLnByb2Nlc3MuZW52LCBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiByb290LCBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IGRpc3RyaWJ1dGlvbiB9O1xuICBjb25zdCBjYW5jZWxsYXRpb24gPSBwcm9jZXNzQ2FuY2VsbGF0aW9uKCk7XG4gIGFzeW5jIGZ1bmN0aW9uIHJ1bihhcmdzOiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IHF1aWV0ID0gcXVpZXRUb29scyAmJiBhcmdzWzBdID09PSBcInRvb2xzXCIgJiYgYXJnc1sxXSA9PT0gXCJpbnN0YWxsXCI7XG4gICAgbGV0IHRhaWwgPSBCdWZmZXIuYWxsb2MoMCksXG4gICAgICB0b3RhbCA9IDA7XG4gICAgaWYgKHF1aWV0KSBjb25zb2xlLmxvZyhgUHJlcGFyaW5nIHZlcmlmaWVkIG5hdGl2ZSB0b29scyAoJHthcmdzLnNsaWNlKDIpLmpvaW4oXCIgXCIpfSkuLi5gKTtcbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgcnVuT3duZWRDaGlsZChwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCAuLi5hcmdzXSwge1xuICAgICAgY3dkOiByb290LFxuICAgICAgZW52OiBlbnZpcm9ubWVudCxcbiAgICAgIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCxcbiAgICAgIC4uLihxdWlldFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIG91dHB1dDogKHN0ZG91dDogTm9kZUpTLlJlYWRhYmxlU3RyZWFtLCBzdGRlcnI6IE5vZGVKUy5SZWFkYWJsZVN0cmVhbSkgPT4ge1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHN0cmVhbSBvZiBbc3Rkb3V0LCBzdGRlcnJdKVxuICAgICAgICAgICAgICAgIHN0cmVhbS5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIpID0+IHtcbiAgICAgICAgICAgICAgICAgIHRvdGFsICs9IGNodW5rLmxlbmd0aDtcbiAgICAgICAgICAgICAgICAgIHRhaWwgPSBCdWZmZXIuY29uY2F0KFt0YWlsLCBjaHVua10pLnN1YmFycmF5KC02NCAqIDEwMjQpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuICAgIGNvbnN0IGZhaWx1cmUgPSBwcm9jZXNzRmFpbHVyZShcImltYWdlIHByZXBhcmF0aW9uXCIsIG91dGNvbWUpO1xuICAgIGlmIChmYWlsdXJlKSB7XG4gICAgICBpZiAocXVpZXQpXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYCR7dG90YWwgPiB0YWlsLmxlbmd0aCA/IFwiRWFybGllciBwcmVwYXJhdGlvbiBvdXRwdXQgb21pdHRlZC5cXG5cIiA6IFwiXCJ9JHt0YWlsLnRvU3RyaW5nKFwidXRmOFwiKX1gKTtcbiAgICAgIHRocm93IGZhaWx1cmU7XG4gICAgfVxuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIHF1ZXJ5KGFyZ3M6IHN0cmluZ1tdKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZU93bmVkQ2hpbGQoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW2NsaSwgLi4uYXJnc10sXG4gICAgICB7IGN3ZDogcm9vdCwgZW52OiBlbnZpcm9ubWVudCwgc2lnbmFsOiBjYW5jZWxsYXRpb24uc2lnbmFsIH0sXG4gICAgICAxNiAqIDEwMjQgKiAxMDI0LFxuICAgICk7XG4gICAgY29uc3QgZmFpbHVyZSA9IHByb2Nlc3NGYWlsdXJlKFwicHJlcGFyYXRpb24gbWV0YWRhdGFcIiwgcmVzdWx0LCByZXN1bHQpO1xuICAgIGlmIChmYWlsdXJlKSB0aHJvdyBmYWlsdXJlO1xuICAgIHJldHVybiByZXN1bHQuc3Rkb3V0O1xuICB9XG4gIGNvbnN0IHBhdGhzID0gYXN5bmMgKHNlbGVjdGVkUGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgdmFsdWVzID0gc3RyaW5ncyhcbiAgICAgIEpTT04ucGFyc2UoYXdhaXQgcXVlcnkoW1wiaW1hZ2Utcm9vdHNcIiwgLi4uc2VsZWN0ZWRQYXRocy5mbGF0TWFwKChwYXRoKSA9PiBbXCItLXBhdGhcIiwgcGF0aF0pXSkpLFxuICAgICAgXCJJbnZhbGlkIGltYWdlIGxhbmd1YWdlIHJvb3RzXCIsXG4gICAgKTtcbiAgICBpZiAoIXZhbHVlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIkltYWdlIHByZXBhcmF0aW9uIG5lZWRzIHJlZ2lzdGVyZWQgbGFuZ3VhZ2Ugcm9vdHNcIik7XG4gICAgcmV0dXJuIHZhbHVlcztcbiAgfTtcbiAgcmV0dXJuIHsgcm9vdCwgY2xpLCBjYW5jZWxsYXRpb24sIHJ1biwgcXVlcnksIHBhdGhzIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbnN0YWxsSW1hZ2VUb29scyhcbiAgeyBydW4sIHF1ZXJ5IH06IFJldHVyblR5cGU8dHlwZW9mIG9wZW5JbWFnZVByZXBhcmF0aW9uPixcbiAgcGF0aHM6IHN0cmluZ1tdLFxuICB0b29sY2hhaW4/OiBzdHJpbmcsXG4gIHNraXBDSVRvb2xjaGFpbnMgPSBmYWxzZSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0b29sY2hhaW5BcmdzID0gdG9vbGNoYWluID8gW1wiLS10b29sY2hhaW5cIiwgdG9vbGNoYWluXSA6IFtdO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIGF3YWl0IHJ1bihbXCJ0b29sc1wiLCBcImluc3RhbGxcIiwgXCItLXBhdGhcIiwgcGF0aCwgLi4udG9vbGNoYWluQXJncywgXCItLWV4Y2x1ZGUtdG9vbFwiLCBcIm1pcmlcIl0pO1xuICAvLyBPcHRpb25hbCBDSSB0b29sIHZhcmlhbnRzIGNvbnRyaWJ1dGUgU0RLcywgYnV0IENJIGRvZXMgbm90IHNlbGVjdCBpbWFnZSByb290cyBvciB2ZXJpZmljYXRpb24gc3VpdGVzLlxuICBpZiAoIXRvb2xjaGFpbiAmJiAhc2tpcENJVG9vbGNoYWlucykge1xuICAgIGNvbnN0IG1hdHJpeCA9IHJlY29yZChKU09OLnBhcnNlKGF3YWl0IHF1ZXJ5KFtcImNoZWNrXCIsIFwibWF0cml4XCJdKSksIFwiSW52YWxpZCBjaGVjayBtYXRyaXhcIik7XG4gICAgY29uc3QgaW5jbHVkZSA9IHJlY29yZChtYXRyaXgubmF0aXZlLCBcIk1pc3NpbmcgbmF0aXZlIG1hdHJpeFwiKS5pbmNsdWRlO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShpbmNsdWRlKSkgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBuYXRpdmUgbWF0cml4IGVudHJpZXNcIik7XG4gICAgY29uc3Qgb3BlcmF0aW5nU3lzdGVtID1cbiAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm1hY29zXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcIndpbmRvd3NcIiA6IHByb2Nlc3MucGxhdGZvcm07XG4gICAgY29uc3QgZW50cmllcyA9IGluY2x1ZGVcbiAgICAgIC5tYXAoKHZhbHVlOiB1bmtub3duKSA9PiByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBtYXRyaXggZW50cnlcIikpXG4gICAgICAuZmlsdGVyKFxuICAgICAgICAoZW50cnkpID0+XG4gICAgICAgICAgZW50cnkub3MgPT09IG9wZXJhdGluZ1N5c3RlbSAmJiBlbnRyeS5hcmNoaXRlY3R1cmUgPT09IHByb2Nlc3MuYXJjaCAmJiBwYXRocy5pbmNsdWRlcyhTdHJpbmcoZW50cnkucGF0aCkpLFxuICAgICAgKTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgW1xuICAgICAgLi4ubmV3IFNldChlbnRyaWVzLmZsYXRNYXAoKGVudHJ5KSA9PiAoZW50cnkudG9vbGNoYWluID8gW3N0cmluZyhlbnRyeS50b29sY2hhaW4sIFwiSW52YWxpZCB0b29sY2hhaW5cIildIDogW10pKSksXG4gICAgXSlcbiAgICAgIGF3YWl0IHJ1bihbXCJ0b29sc1wiLCBcImluc3RhbGxcIiwgXCItLXRvb2xjaGFpblwiLCBuYW1lLCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiXSk7XG4gIH1cbn1cblxuaWYgKGlzTWFpblNjcmlwdChpbXBvcnQubWV0YS51cmwpKSB7XG4gIGNvbnN0IHByZXBhcmF0aW9uID0gb3BlbkltYWdlUHJlcGFyYXRpb24odHJ1ZSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgcHJlcGFyYXRpb24ucnVuKFtcInByb2plY3RcIiwgXCJhZGRcIiwgcHJlcGFyYXRpb24ucm9vdF0pO1xuICAgIGF3YWl0IGluc3RhbGxJbWFnZVRvb2xzKHByZXBhcmF0aW9uLCBhd2FpdCBwcmVwYXJhdGlvbi5wYXRocyhbXSkpO1xuICB9IGZpbmFsbHkge1xuICAgIHByZXBhcmF0aW9uLmNhbmNlbGxhdGlvbi5jbG9zZSgpO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsUUFBUSxlQUFlO0FBQ3hDLFNBQVMsZUFBZSxtQkFBbUIsMkJBQTJCO0FBQ3RFLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMsb0JBQW9CO0FBRXRCLFNBQVMscUJBQXFCLFlBQXFCO0FBQ3hELFFBQU0sZUFBZSxRQUFRLFlBQVksU0FBUyxJQUFJO0FBQ3RELFFBQU0sT0FBTyxRQUFRLFFBQVEsSUFBSSwwQkFBMEIsUUFBUSxJQUFJLENBQUM7QUFDeEUsUUFBTSxNQUFNLEtBQUssY0FBYyxtQkFBbUI7QUFDbEQsUUFBTSxjQUFjLEVBQUUsR0FBRyxRQUFRLEtBQUssd0JBQXdCLE1BQU0sNkJBQTZCLGFBQWE7QUFDOUcsUUFBTSxlQUFlLG9CQUFvQjtBQUN6QyxpQkFBZSxJQUFJLE1BQWdCO0FBQ2pDLFVBQU0sUUFBUSxjQUFjLEtBQUssQ0FBQyxNQUFNLFdBQVcsS0FBSyxDQUFDLE1BQU07QUFDL0QsUUFBSSxPQUFPLE9BQU8sTUFBTSxDQUFDLEdBQ3ZCLFFBQVE7QUFDVixRQUFJLE1BQU8sU0FBUSxJQUFJLG9DQUFvQyxLQUFLLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxDQUFDLE1BQU07QUFDeEYsVUFBTSxVQUFVLE1BQU0sY0FBYyxRQUFRLFVBQVUsQ0FBQyxLQUFLLEdBQUcsSUFBSSxHQUFHO0FBQUEsTUFDcEUsS0FBSztBQUFBLE1BQ0wsS0FBSztBQUFBLE1BQ0wsUUFBUSxhQUFhO0FBQUEsTUFDckIsR0FBSSxRQUNBO0FBQUEsUUFDRSxRQUFRLENBQUMsUUFBK0IsV0FBa0M7QUFDeEUscUJBQVcsVUFBVSxDQUFDLFFBQVEsTUFBTTtBQUNsQyxtQkFBTyxHQUFHLFFBQVEsQ0FBQyxVQUFrQjtBQUNuQyx1QkFBUyxNQUFNO0FBQ2YscUJB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
