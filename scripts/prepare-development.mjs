// Generated from prepare-development.mts; edit the TypeScript source.
import { record, string } from "./values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
const [builder, option] = process.argv.slice(2);
if (builder !== "native" && builder !== "nix" && builder !== "guix" || option && option !== "--verify")
  throw new Error("Use prepare-development.mjs native|nix|guix [--verify]");
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "bin/workbench.mjs");
const verify = option === "--verify";
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
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: root },
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
    { cwd: root, env: process.env, signal: cancellation.signal },
    16 * 1024 * 1024
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
  const operatingSystem = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  const entries = include.map((value) => record(value, "Invalid matrix entry")).filter(
    (entry) => builder === "native" ? entry.os === operatingSystem && entry.architecture === process.arch : entry.environment === builder
  );
  if (!entries.length)
    throw new Error(`No configured ${builder} preparation targets for ${operatingSystem}-${process.arch}`);
  const paths = [...new Set(entries.map((entry) => string(entry.path, "Missing matrix path")))];
  if (!verify && builder === "native") {
    await run(process.execPath, [cli, "tools", "install", "--exclude-tool", "miri"]);
    for (const name of [
      ...new Set(entries.flatMap((entry) => entry.toolchain ? [string(entry.toolchain, "Invalid toolchain")] : []))
    ])
      await run(process.execPath, [cli, "tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
  }
  for (const path of paths) {
    console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
    const selection = ["check", "--path", path, "--environment", builder, "--no-cache"];
    await run(process.execPath, [cli, ...selection, "--role", "build"]);
    if (builder === "native") {
      const plan = record(JSON.parse(await query([...selection, "--stage", "ci", "--json"])), "Invalid check plan");
      if (!Array.isArray(plan.selected)) throw new Error("Missing selected checks");
      const roles = [
        ...new Set(
          plan.selected.map((check) => string(record(check, "Invalid check").role, "Missing check role"))
        )
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZGV2ZWxvcG1lbnQubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgcnVuT3duZWRDaGlsZCwgY2FwdHVyZU93bmVkQ2hpbGQsIHByb2Nlc3NDYW5jZWxsYXRpb24gfSBmcm9tIFwiLi9vd25lZC1jaGlsZC5tanNcIjtcbmltcG9ydCB7IHByb2Nlc3NGYWlsdXJlIH0gZnJvbSBcIi4vcHJvY2Vzcy1vdXRjb21lLm1qc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vLyBQcm9qZWN0LW93bmVkIHJlY2lwZTogcmV0YWluIG5hdGl2ZSBjaGVjayBpbnB1dHMsIHRoZW4gcHJvdmUgZnJlc2ggb2ZmbGluZSBleGVjdXRpb24uXG5jb25zdCBbYnVpbGRlciwgb3B0aW9uXSA9IHByb2Nlc3MuYXJndi5zbGljZSgyKTtcbmlmICgoYnVpbGRlciAhPT0gXCJuYXRpdmVcIiAmJiBidWlsZGVyICE9PSBcIm5peFwiICYmIGJ1aWxkZXIgIT09IFwiZ3VpeFwiKSB8fCAob3B0aW9uICYmIG9wdGlvbiAhPT0gXCItLXZlcmlmeVwiKSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHByZXBhcmUtZGV2ZWxvcG1lbnQubWpzIG5hdGl2ZXxuaXh8Z3VpeCBbLS12ZXJpZnldXCIpO1xuY29uc3Qgcm9vdCA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbmNvbnN0IGNsaSA9IGpvaW4ocm9vdCwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKTtcbmNvbnN0IHZlcmlmeSA9IG9wdGlvbiA9PT0gXCItLXZlcmlmeVwiO1xuaWYgKCF2ZXJpZnkgJiYgYnVpbGRlciAhPT0gXCJuYXRpdmVcIilcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiTWFuYWdlZCBpbWFnZXMgYXJlIGFzc2VtYmxlZCBieSBzY3JpcHRzL3ByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tanMgZnJvbSB0aGVpciBkZWNsYXJlZCBjbG9zdXJlc1wiLFxuICApO1xuY29uc3QgY2FuY2VsbGF0aW9uID0gcHJvY2Vzc0NhbmNlbGxhdGlvbigpO1xuYXN5bmMgZnVuY3Rpb24gcnVuKGNvbW1hbmQ6IHN0cmluZywgYXJnczogc3RyaW5nW10sIGN3ZCA9IHJvb3QpIHtcbiAgY29uc3QgcXVpZXQgPSAhdmVyaWZ5ICYmIGFyZ3NbMV0gPT09IFwidG9vbHNcIiAmJiBhcmdzWzJdID09PSBcImluc3RhbGxcIjtcbiAgbGV0IHRhaWwgPSBCdWZmZXIuYWxsb2MoMCksXG4gICAgdG90YWwgPSAwO1xuICBpZiAocXVpZXQpIGNvbnNvbGUubG9nKGBQcmVwYXJpbmcgdmVyaWZpZWQgbmF0aXZlIHRvb2xzICgke2FyZ3Muc2xpY2UoMykuam9pbihcIiBcIil9KS4uLmApO1xuICBjb25zdCBvdXRjb21lID0gYXdhaXQgcnVuT3duZWRDaGlsZChjb21tYW5kLCBhcmdzLCB7XG4gICAgY3dkLFxuICAgIGVudjogeyAuLi5wcm9jZXNzLmVudiwgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogcm9vdCwgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiByb290IH0sXG4gICAgc2lnbmFsOiBjYW5jZWxsYXRpb24uc2lnbmFsLFxuICAgIC4uLihxdWlldFxuICAgICAgPyB7XG4gICAgICAgICAgb3V0cHV0OiAoc3Rkb3V0OiBOb2RlSlMuUmVhZGFibGVTdHJlYW0sIHN0ZGVycjogTm9kZUpTLlJlYWRhYmxlU3RyZWFtKSA9PiB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHN0cmVhbSBvZiBbc3Rkb3V0LCBzdGRlcnJdKVxuICAgICAgICAgICAgICBzdHJlYW0ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICAgICAgICAgICAgdG90YWwgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgICAgICAgICAgIHRhaWwgPSBCdWZmZXIuY29uY2F0KFt0YWlsLCBjaHVua10pLnN1YmFycmF5KC02NCAqIDEwMjQpO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICA6IHt9KSxcbiAgfSk7XG4gIGNvbnN0IGZhaWx1cmUgPSBwcm9jZXNzRmFpbHVyZShjb21tYW5kLCBvdXRjb21lKTtcbiAgaWYgKGZhaWx1cmUpIHtcbiAgICBpZiAocXVpZXQpXG4gICAgICBjb25zb2xlLmVycm9yKGAke3RvdGFsID4gdGFpbC5sZW5ndGggPyBcIkVhcmxpZXIgcHJlcGFyYXRpb24gb3V0cHV0IG9taXR0ZWQuXFxuXCIgOiBcIlwifSR7dGFpbC50b1N0cmluZyhcInV0ZjhcIil9YCk7XG4gICAgdGhyb3cgZmFpbHVyZTtcbiAgfVxufVxuYXN5bmMgZnVuY3Rpb24gcXVlcnkoYXJnczogc3RyaW5nW10pIHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZU93bmVkQ2hpbGQoXG4gICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICBbY2xpLCAuLi5hcmdzXSxcbiAgICB7IGN3ZDogcm9vdCwgZW52OiBwcm9jZXNzLmVudiwgc2lnbmFsOiBjYW5jZWxsYXRpb24uc2lnbmFsIH0sXG4gICAgMTYgKiAxMDI0ICogMTAyNCxcbiAgKTtcbiAgY29uc3QgZmFpbHVyZSA9IHByb2Nlc3NGYWlsdXJlKFwicHJlcGFyYXRpb24gbWV0YWRhdGFcIiwgcmVzdWx0LCByZXN1bHQpO1xuICBpZiAoZmFpbHVyZSkgdGhyb3cgZmFpbHVyZTtcbiAgcmV0dXJuIHJlc3VsdC5zdGRvdXQ7XG59XG50cnkge1xuICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgXCJwcm9qZWN0XCIsIFwiYWRkXCIsIHJvb3RdKTtcbiAgY29uc3QgbWF0cml4ID0gcmVjb3JkKEpTT04ucGFyc2UoYXdhaXQgcXVlcnkoW1wiY2hlY2tcIiwgXCJtYXRyaXhcIl0pKSwgXCJJbnZhbGlkIGNoZWNrIG1hdHJpeFwiKTtcbiAgY29uc3QgaW5jbHVkZSA9IHJlY29yZChtYXRyaXhbYnVpbGRlciA9PT0gXCJuYXRpdmVcIiA/IFwibmF0aXZlXCIgOiBcImVudmlyb25tZW50c1wiXSwgXCJNaXNzaW5nIGJ1aWxkZXIgbWF0cml4XCIpLmluY2x1ZGU7XG4gIGlmICghQXJyYXkuaXNBcnJheShpbmNsdWRlKSkgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBuYXRpdmUgbWF0cml4IGVudHJpZXNcIik7XG4gIGNvbnN0IG9wZXJhdGluZ1N5c3RlbSA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwibWFjb3NcIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwid2luZG93c1wiIDogcHJvY2Vzcy5wbGF0Zm9ybTtcbiAgY29uc3QgZW50cmllcyA9IGluY2x1ZGVcbiAgICAubWFwKCh2YWx1ZTogdW5rbm93bikgPT4gcmVjb3JkKHZhbHVlLCBcIkludmFsaWQgbWF0cml4IGVudHJ5XCIpKVxuICAgIC5maWx0ZXIoKGVudHJ5KSA9PlxuICAgICAgYnVpbGRlciA9PT0gXCJuYXRpdmVcIlxuICAgICAgICA/IGVudHJ5Lm9zID09PSBvcGVyYXRpbmdTeXN0ZW0gJiYgZW50cnkuYXJjaGl0ZWN0dXJlID09PSBwcm9jZXNzLmFyY2hcbiAgICAgICAgOiBlbnRyeS5lbnZpcm9ubWVudCA9PT0gYnVpbGRlcixcbiAgICApO1xuICBpZiAoIWVudHJpZXMubGVuZ3RoKVxuICAgIHRocm93IG5ldyBFcnJvcihgTm8gY29uZmlndXJlZCAke2J1aWxkZXJ9IHByZXBhcmF0aW9uIHRhcmdldHMgZm9yICR7b3BlcmF0aW5nU3lzdGVtfS0ke3Byb2Nlc3MuYXJjaH1gKTtcbiAgY29uc3QgcGF0aHMgPSBbLi4ubmV3IFNldChlbnRyaWVzLm1hcCgoZW50cnkpID0+IHN0cmluZyhlbnRyeS5wYXRoLCBcIk1pc3NpbmcgbWF0cml4IHBhdGhcIikpKV07XG4gIGlmICghdmVyaWZ5ICYmIGJ1aWxkZXIgPT09IFwibmF0aXZlXCIpIHtcbiAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgXCJ0b29sc1wiLCBcImluc3RhbGxcIiwgXCItLWV4Y2x1ZGUtdG9vbFwiLCBcIm1pcmlcIl0pO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbXG4gICAgICAuLi5uZXcgU2V0KGVudHJpZXMuZmxhdE1hcCgoZW50cnkpID0+IChlbnRyeS50b29sY2hhaW4gPyBbc3RyaW5nKGVudHJ5LnRvb2xjaGFpbiwgXCJJbnZhbGlkIHRvb2xjaGFpblwiKV0gOiBbXSkpKSxcbiAgICBdKVxuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtjbGksIFwidG9vbHNcIiwgXCJpbnN0YWxsXCIsIFwiLS10b29sY2hhaW5cIiwgbmFtZSwgXCItLWV4Y2x1ZGUtdG9vbFwiLCBcIm1pcmlcIl0pO1xuICB9XG4gIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgIGNvbnNvbGUubG9nKGA6Omdyb3VwOjoke3ZlcmlmeSA/IFwiT2ZmbGluZSB2ZXJpZmljYXRpb25cIiA6IFwiUHJlcGFyZVwifTogJHtidWlsZGVyfSAke3BhdGh9YCk7XG4gICAgY29uc3Qgc2VsZWN0aW9uID0gW1wiY2hlY2tcIiwgXCItLXBhdGhcIiwgcGF0aCwgXCItLWVudmlyb25tZW50XCIsIGJ1aWxkZXIsIFwiLS1uby1jYWNoZVwiXTtcbiAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgLi4uc2VsZWN0aW9uLCBcIi0tcm9sZVwiLCBcImJ1aWxkXCJdKTtcbiAgICBpZiAoYnVpbGRlciA9PT0gXCJuYXRpdmVcIikge1xuICAgICAgY29uc3QgcGxhbiA9IHJlY29yZChKU09OLnBhcnNlKGF3YWl0IHF1ZXJ5KFsuLi5zZWxlY3Rpb24sIFwiLS1zdGFnZVwiLCBcImNpXCIsIFwiLS1qc29uXCJdKSksIFwiSW52YWxpZCBjaGVjayBwbGFuXCIpO1xuICAgICAgLy8gUmVzb2x2ZSB0aGUgY29uZmlndXJlZCBDSSB2YXJpYW50cywgaW5jbHVkaW5nIGNvdmVyYWdlIGFuZCBhbmFseXNpcyB0b29scyBtaXNzZWQgYnkgb3JkaW5hcnkgYnVpbGQvdGVzdC5cbiAgICAgIC8vIEFkdmlzb3J5IGRhdGFiYXNlcyBhcmUgbGl2ZSBpbnB1dHMsIHNvIHF1ZXJ5IHRoZW0gaW4gQ0kgcmF0aGVyIHRoYW4gZnJlZXppbmcgdGhlbSBpbnRvIHRoZSBpbWFnZS5cbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShwbGFuLnNlbGVjdGVkKSkgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBzZWxlY3RlZCBjaGVja3NcIik7XG4gICAgICBjb25zdCByb2xlcyA9IFtcbiAgICAgICAgLi4ubmV3IFNldChcbiAgICAgICAgICBwbGFuLnNlbGVjdGVkLm1hcCgoY2hlY2s6IHVua25vd24pID0+IHN0cmluZyhyZWNvcmQoY2hlY2ssIFwiSW52YWxpZCBjaGVja1wiKS5yb2xlLCBcIk1pc3NpbmcgY2hlY2sgcm9sZVwiKSksXG4gICAgICAgICksXG4gICAgICBdLmZpbHRlcigocm9sZSkgPT4gIVtcInNldHVwXCIsIFwiYnVpbGRcIiwgXCJhZHZpc29yeVwiXS5pbmNsdWRlcyhyb2xlKSk7XG4gICAgICBpZiAocm9sZXMubGVuZ3RoKVxuICAgICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgLi4uc2VsZWN0aW9uLCBcIi0tc3RhZ2VcIiwgXCJjaVwiLCAuLi5yb2xlcy5mbGF0TWFwKChyb2xlKSA9PiBbXCItLXJvbGVcIiwgcm9sZV0pXSk7XG4gICAgfSBlbHNlIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCAuLi5zZWxlY3Rpb24sIFwiLS1yb2xlXCIsIFwidGVzdFwiXSk7XG4gICAgY29uc29sZS5sb2coXCI6OmVuZGdyb3VwOjpcIik7XG4gIH1cblxuICBpZiAoYnVpbGRlciA9PT0gXCJuYXRpdmVcIiAmJiAhdmVyaWZ5ICYmIHBhdGhzLnNvbWUoKHBhdGgpID0+IGV4aXN0c1N5bmMoam9pbihyb290LCBwYXRoLCBcInBucG0tbG9jay55YW1sXCIpKSkpIHtcbiAgICBjb25zdCB7IHJldGFpblBucG1NZXRhZGF0YSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9wbnBtLW1ldGFkYXRhLm1qc1wiKTtcbiAgICBhd2FpdCByZXRhaW5QbnBtTWV0YWRhdGEocm9vdCwgY2xpLCBwYXRocywgY2FuY2VsbGF0aW9uLnNpZ25hbCk7XG4gIH1cbn0gZmluYWxseSB7XG4gIGNhbmNlbGxhdGlvbi5jbG9zZSgpO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxRQUFRLGNBQWM7QUFDL0IsU0FBUyxlQUFlLG1CQUFtQiwyQkFBMkI7QUFDdEUsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxNQUFNLGVBQWU7QUFHOUIsTUFBTSxDQUFDLFNBQVMsTUFBTSxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDOUMsSUFBSyxZQUFZLFlBQVksWUFBWSxTQUFTLFlBQVksVUFBWSxVQUFVLFdBQVc7QUFDN0YsUUFBTSxJQUFJLE1BQU0sd0RBQXdEO0FBQzFFLE1BQU0sT0FBTyxRQUFRLFlBQVksU0FBUyxJQUFJO0FBQzlDLE1BQU0sTUFBTSxLQUFLLE1BQU0sbUJBQW1CO0FBQzFDLE1BQU0sU0FBUyxXQUFXO0FBQzFCLElBQUksQ0FBQyxVQUFVLFlBQVk7QUFDekIsUUFBTSxJQUFJO0FBQUEsSUFDUjtBQUFBLEVBQ0Y7QUFDRixNQUFNLGVBQWUsb0JBQW9CO0FBQ3pDLGVBQWUsSUFBSSxTQUFpQixNQUFnQixNQUFNLE1BQU07QUFDOUQsUUFBTSxRQUFRLENBQUMsVUFBVSxLQUFLLENBQUMsTUFBTSxXQUFXLEtBQUssQ0FBQyxNQUFNO0FBQzVELE1BQUksT0FBTyxPQUFPLE1BQU0sQ0FBQyxHQUN2QixRQUFRO0FBQ1YsTUFBSSxNQUFPLFNBQVEsSUFBSSxvQ0FBb0MsS0FBSyxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUcsQ0FBQyxNQUFNO0FBQ3hGLFFBQU0sVUFBVSxNQUFNLGNB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
