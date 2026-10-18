// Generated from prepare-development.mts; edit the TypeScript source.
import { record, string } from "./values.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { openSync, closeSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
function run(command, args, cwd = root) {
  const quiet = !verify && args[1] === "tools" && args[2] === "install";
  const logs = quiet ? mkdtempSync(join(tmpdir(), "workbench-tool-install-")) : void 0;
  const log = logs ? join(logs, "install.log") : void 0;
  let output;
  if (quiet) console.log(`Preparing verified native tools (${args.slice(3).join(" ")})...`);
  try {
    output = log ? openSync(log, "w") : void 0;
    const child = spawnSync(command, args, {
      cwd,
      stdio: output === void 0 ? "inherit" : ["ignore", output, output],
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: root }
    });
    if (child.error || child.status !== 0) {
      if (log) console.error(readFileSync(log, "utf8").trimEnd().split(/\r?\n/).slice(-100).join("\n"));
      throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
    }
  } finally {
    if (output !== void 0) closeSync(output);
    if (logs) rmSync(logs, { recursive: true, force: true });
  }
}
const matrix = record(
  JSON.parse(execFileSync(process.execPath, [cli, "check", "matrix"], { cwd: root, encoding: "utf8" })),
  "Invalid check matrix"
);
const include = record(matrix.native, "Missing native matrix").include;
if (!Array.isArray(include)) throw new Error("Missing native matrix entries");
const entries = include.map((value) => record(value, "Invalid matrix entry"));
const paths = [...new Set(entries.map((entry) => string(entry.path, "Missing matrix path")))];
if (!verify && builder === "native") {
  run(process.execPath, [cli, "tools", "install", "--exclude-tool", "miri"]);
  for (const name of [
    ...new Set(entries.flatMap((entry) => entry.toolchain ? [string(entry.toolchain, "Invalid toolchain")] : []))
  ])
    run(process.execPath, [cli, "tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
}
for (const path of paths) {
  console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
  const selection = ["check", "--path", path, "--environment", builder, "--no-cache"];
  run(process.execPath, [cli, ...selection, "--role", "build"]);
  if (builder === "native") {
    const plan = record(
      JSON.parse(
        execFileSync(process.execPath, [cli, ...selection, "--stage", "ci", "--json"], {
          cwd: root,
          encoding: "utf8"
        })
      ),
      "Invalid check plan"
    );
    if (!Array.isArray(plan.selected)) throw new Error("Missing selected checks");
    const roles = [
      ...new Set(
        plan.selected.map((check) => string(record(check, "Invalid check").role, "Missing check role"))
      )
    ].filter((role) => !["setup", "build", "advisory"].includes(role));
    if (roles.length)
      run(process.execPath, [cli, ...selection, "--stage", "ci", ...roles.flatMap((role) => ["--role", role])]);
  } else run(process.execPath, [cli, ...selection, "--role", "test"]);
  console.log("::endgroup::");
}
if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
  const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
  retainPnpmMetadata(root, cli, paths);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZGV2ZWxvcG1lbnQubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jLCBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBvcGVuU3luYywgY2xvc2VTeW5jLCBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbi8vIFByb2plY3Qtb3duZWQgcmVjaXBlOiByZXRhaW4gbmF0aXZlIGNoZWNrIGlucHV0cywgdGhlbiBwcm92ZSBmcmVzaCBvZmZsaW5lIGV4ZWN1dGlvbi5cbmNvbnN0IFtidWlsZGVyLCBvcHRpb25dID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpO1xuaWYgKChidWlsZGVyICE9PSBcIm5hdGl2ZVwiICYmIGJ1aWxkZXIgIT09IFwibml4XCIgJiYgYnVpbGRlciAhPT0gXCJndWl4XCIpIHx8IChvcHRpb24gJiYgb3B0aW9uICE9PSBcIi0tdmVyaWZ5XCIpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJVc2UgcHJlcGFyZS1kZXZlbG9wbWVudC5tanMgbmF0aXZlfG5peHxndWl4IFstLXZlcmlmeV1cIik7XG5jb25zdCByb290ID0gcmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpO1xuY29uc3QgY2xpID0gam9pbihyb290LCBcImJpbi93b3JrYmVuY2gubWpzXCIpO1xuY29uc3QgdmVyaWZ5ID0gb3B0aW9uID09PSBcIi0tdmVyaWZ5XCI7XG5pZiAoIXZlcmlmeSAmJiBidWlsZGVyICE9PSBcIm5hdGl2ZVwiKVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgXCJNYW5hZ2VkIGltYWdlcyBhcmUgYXNzZW1ibGVkIGJ5IHNjcmlwdHMvcHJlcGFyZS1tYW5hZ2VkLWRldmVsb3BtZW50Lm1qcyBmcm9tIHRoZWlyIGRlY2xhcmVkIGNsb3N1cmVzXCIsXG4gICk7XG5mdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgY3dkID0gcm9vdCkge1xuICBjb25zdCBxdWlldCA9ICF2ZXJpZnkgJiYgYXJnc1sxXSA9PT0gXCJ0b29sc1wiICYmIGFyZ3NbMl0gPT09IFwiaW5zdGFsbFwiO1xuICBjb25zdCBsb2dzID0gcXVpZXQgPyBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC10b29sLWluc3RhbGwtXCIpKSA6IHVuZGVmaW5lZDtcbiAgY29uc3QgbG9nID0gbG9ncyA/IGpvaW4obG9ncywgXCJpbnN0YWxsLmxvZ1wiKSA6IHVuZGVmaW5lZDtcbiAgbGV0IG91dHB1dDtcbiAgaWYgKHF1aWV0KSBjb25zb2xlLmxvZyhgUHJlcGFyaW5nIHZlcmlmaWVkIG5hdGl2ZSB0b29scyAoJHthcmdzLnNsaWNlKDMpLmpvaW4oXCIgXCIpfSkuLi5gKTtcbiAgdHJ5IHtcbiAgICBvdXRwdXQgPSBsb2cgPyBvcGVuU3luYyhsb2csIFwid1wiKSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduU3luYyhjb21tYW5kLCBhcmdzLCB7XG4gICAgICBjd2QsXG4gICAgICBzdGRpbzogb3V0cHV0ID09PSB1bmRlZmluZWQgPyBcImluaGVyaXRcIiA6IFtcImlnbm9yZVwiLCBvdXRwdXQsIG91dHB1dF0sXG4gICAgICBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIFdPUktCRU5DSF9QUk9KRUNUX1JPT1Q6IHJvb3QsIFdPUktCRU5DSF9ESVNUUklCVVRJT05fUk9PVDogcm9vdCB9LFxuICAgIH0pO1xuICAgIGlmIChjaGlsZC5lcnJvciB8fCBjaGlsZC5zdGF0dXMgIT09IDApIHtcbiAgICAgIGlmIChsb2cpIGNvbnNvbGUuZXJyb3IocmVhZEZpbGVTeW5jKGxvZywgXCJ1dGY4XCIpLnRyaW1FbmQoKS5zcGxpdCgvXFxyP1xcbi8pLnNsaWNlKC0xMDApLmpvaW4oXCJcXG5cIikpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2NvbW1hbmR9IGZhaWxlZDogJHtTdHJpbmcoY2hpbGQuZXJyb3IgPz8gY2hpbGQuc3RhdHVzKX1gKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKG91dHB1dCAhPT0gdW5kZWZpbmVkKSBjbG9zZVN5bmMob3V0cHV0KTtcbiAgICBpZiAobG9ncykgcm1TeW5jKGxvZ3MsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufVxuY29uc3QgbWF0cml4ID0gcmVjb3JkKFxuICBKU09OLnBhcnNlKGV4ZWNGaWxlU3luYyhwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCBcImNoZWNrXCIsIFwibWF0cml4XCJdLCB7IGN3ZDogcm9vdCwgZW5jb2Rpbmc6IFwidXRmOFwiIH0pKSxcbiAgXCJJbnZhbGlkIGNoZWNrIG1hdHJpeFwiLFxuKTtcbmNvbnN0IGluY2x1ZGUgPSByZWNvcmQobWF0cml4Lm5hdGl2ZSwgXCJNaXNzaW5nIG5hdGl2ZSBtYXRyaXhcIikuaW5jbHVkZTtcbmlmICghQXJyYXkuaXNBcnJheShpbmNsdWRlKSkgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBuYXRpdmUgbWF0cml4IGVudHJpZXNcIik7XG5jb25zdCBlbnRyaWVzID0gaW5jbHVkZS5tYXAoKHZhbHVlOiB1bmtub3duKSA9PiByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBtYXRyaXggZW50cnlcIikpO1xuY29uc3QgcGF0aHMgPSBbLi4ubmV3IFNldChlbnRyaWVzLm1hcCgoZW50cnkpID0+IHN0cmluZyhlbnRyeS5wYXRoLCBcIk1pc3NpbmcgbWF0cml4IHBhdGhcIikpKV07XG5pZiAoIXZlcmlmeSAmJiBidWlsZGVyID09PSBcIm5hdGl2ZVwiKSB7XG4gIHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCBcInRvb2xzXCIsIFwiaW5zdGFsbFwiLCBcIi0tZXhjbHVkZS10b29sXCIsIFwibWlyaVwiXSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXG4gICAgLi4ubmV3IFNldChlbnRyaWVzLmZsYXRNYXAoKGVudHJ5KSA9PiAoZW50cnkudG9vbGNoYWluID8gW3N0cmluZyhlbnRyeS50b29sY2hhaW4sIFwiSW52YWxpZCB0b29sY2hhaW5cIildIDogW10pKSksXG4gIF0pXG4gICAgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtjbGksIFwidG9vbHNcIiwgXCJpbnN0YWxsXCIsIFwiLS10b29sY2hhaW5cIiwgbmFtZSwgXCItLWV4Y2x1ZGUtdG9vbFwiLCBcIm1pcmlcIl0pO1xufVxuZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7XG4gIGNvbnNvbGUubG9nKGA6Omdyb3VwOjoke3ZlcmlmeSA/IFwiT2ZmbGluZSB2ZXJpZmljYXRpb25cIiA6IFwiUHJlcGFyZVwifTogJHtidWlsZGVyfSAke3BhdGh9YCk7XG4gIGNvbnN0IHNlbGVjdGlvbiA9IFtcImNoZWNrXCIsIFwiLS1wYXRoXCIsIHBhdGgsIFwiLS1lbnZpcm9ubWVudFwiLCBidWlsZGVyLCBcIi0tbm8tY2FjaGVcIl07XG4gIHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCAuLi5zZWxlY3Rpb24sIFwiLS1yb2xlXCIsIFwiYnVpbGRcIl0pO1xuICBpZiAoYnVpbGRlciA9PT0gXCJuYXRpdmVcIikge1xuICAgIGNvbnN0IHBsYW4gPSByZWNvcmQoXG4gICAgICBKU09OLnBhcnNlKFxuICAgICAgICBleGVjRmlsZVN5bmMocHJvY2Vzcy5leGVjUGF0aCwgW2NsaSwgLi4uc2VsZWN0aW9uLCBcIi0tc3RhZ2VcIiwgXCJjaVwiLCBcIi0tanNvblwiXSwge1xuICAgICAgICAgIGN3ZDogcm9vdCxcbiAgICAgICAgICBlbmNvZGluZzogXCJ1dGY4XCIsXG4gICAgICAgIH0pLFxuICAgICAgKSxcbiAgICAgIFwiSW52YWxpZCBjaGVjayBwbGFuXCIsXG4gICAgKTtcbiAgICAvLyBSZXNvbHZlIHRoZSBjb25maWd1cmVkIENJIHZhcmlhbnRzLCBpbmNsdWRpbmcgY292ZXJhZ2UgYW5kIGFuYWx5c2lzIHRvb2xzIG1pc3NlZCBieSBvcmRpbmFyeSBidWlsZC90ZXN0LlxuICAgIC8vIEFkdmlzb3J5IGRhdGFiYXNlcyBhcmUgbGl2ZSBpbnB1dHMsIHNvIHF1ZXJ5IHRoZW0gaW4gQ0kgcmF0aGVyIHRoYW4gZnJlZXppbmcgdGhlbSBpbnRvIHRoZSBpbWFnZS5cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocGxhbi5zZWxlY3RlZCkpIHRocm93IG5ldyBFcnJvcihcIk1pc3Npbmcgc2VsZWN0ZWQgY2hlY2tzXCIpO1xuICAgIGNvbnN0IHJvbGVzID0gW1xuICAgICAgLi4ubmV3IFNldChcbiAgICAgICAgcGxhbi5zZWxlY3RlZC5tYXAoKGNoZWNrOiB1bmtub3duKSA9PiBzdHJpbmcocmVjb3JkKGNoZWNrLCBcIkludmFsaWQgY2hlY2tcIikucm9sZSwgXCJNaXNzaW5nIGNoZWNrIHJvbGVcIikpLFxuICAgICAgKSxcbiAgICBdLmZpbHRlcigocm9sZSkgPT4gIVtcInNldHVwXCIsIFwiYnVpbGRcIiwgXCJhZHZpc29yeVwiXS5pbmNsdWRlcyhyb2xlKSk7XG4gICAgaWYgKHJvbGVzLmxlbmd0aClcbiAgICAgIHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCAuLi5zZWxlY3Rpb24sIFwiLS1zdGFnZVwiLCBcImNpXCIsIC4uLnJvbGVzLmZsYXRNYXAoKHJvbGUpID0+IFtcIi0tcm9sZVwiLCByb2xlXSldKTtcbiAgfSBlbHNlIHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCAuLi5zZWxlY3Rpb24sIFwiLS1yb2xlXCIsIFwidGVzdFwiXSk7XG4gIGNvbnNvbGUubG9nKFwiOjplbmRncm91cDo6XCIpO1xufVxuXG5pZiAoYnVpbGRlciA9PT0gXCJuYXRpdmVcIiAmJiAhdmVyaWZ5ICYmIHBhdGhzLnNvbWUoKHBhdGgpID0+IGV4aXN0c1N5bmMoam9pbihyb290LCBwYXRoLCBcInBucG0tbG9jay55YW1sXCIpKSkpIHtcbiAgY29uc3QgeyByZXRhaW5QbnBtTWV0YWRhdGEgfSA9IGF3YWl0IGltcG9ydChcIi4vcG5wbS1tZXRhZGF0YS5tanNcIik7XG4gIHJldGFpblBucG1NZXRhZGF0YShyb290LCBjbGksIHBhdGhzKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsUUFBUSxjQUFjO0FBQy9CLFNBQVMsV0FBVyxvQkFBb0I7QUFDeEMsU0FBUyxVQUFVLFdBQVcsWUFBWSxhQUFhLGNBQWMsY0FBYztBQUNuRixTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLGNBQWM7QUFHdkIsTUFBTSxDQUFDLFNBQVMsTUFBTSxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDOUMsSUFBSyxZQUFZLFlBQVksWUFBWSxTQUFTLFlBQVksVUFBWSxVQUFVLFdBQVc7QUFDN0YsUUFBTSxJQUFJLE1BQU0sd0RBQXdEO0FBQzFFLE1BQU0sT0FBTyxRQUFRLFlBQVksU0FBUyxJQUFJO0FBQzlDLE1BQU0sTUFBTSxLQUFLLE1BQU0sbUJBQW1CO0FBQzFDLE1BQU0sU0FBUyxXQUFXO0FBQzFCLElBQUksQ0FBQyxVQUFVLFlBQVk7QUFDekIsUUFBTSxJQUFJO0FBQUEsSUFDUjtBQUFBLEVBQ0Y7QUFDRixTQUFTLElBQUksU0FBaUIsTUFBZ0IsTUFBTSxNQUFNO0FBQ3hELFFBQU0sUUFBUSxDQUFDLFVBQVUsS0FBSyxDQUFDLE1BQU0sV0FBVyxLQUFLLENBQUMsTUFBTTtBQUM1RCxRQUFNLE9BQU8sUUFBUSxZQUFZLEtBQUssT0FBTyxHQUFHLHlCQUF5QixDQUFDLElBQUk7QUFDOUUsUUFBTSxNQUFNLE9BQU8sS0FBSyxNQUFNLGFBQWEsSUFBSTtBQUMvQyxNQUFJO0FBQ0osTUFBSSxNQUFPLFNBQVEsSUFBSSxvQ0FBb0MsS0FBSyxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUcsQ0FBQyxNQUFNO0FBQ3hGLE1BQUk7QUFDRixhQUFTLE1BQU0sU0FBUyxLQUFLLEdBQUcs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U0FBUyxVQUFVLEVBQUUsU0FBUyxJQUFJLENBQUM7QUFDakUsUUFBSSxNQUFNO0FBQ1IsVUFBSSxRQUFRLFVBQVUsQ0FBQyxLQUFLLEdBQUcsV0FBVyxXQUFXLE1BQU0sR0FBRyxNQUFNLFFBQVEsQ0FBQyxTQUFTLENBQUMsVUFBVSxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQUEsRUFDNUcsTUFBTyxLQUFJLFFBQVEsVUFBVSxDQUFDLEtBQUssR0FBRyxXQUFXLFVBQVUsTUFBTSxDQUFDO0FBQ2xFLFVBQVEsSUFBSSxjQUFjO0FBQzVCO0FBRUEsSUFBSSxZQUFZLFlBQVksQ0FBQyxVQUFVLE1BQU0sS0FBSyxDQUFDLFNBQVMsV0FBVyxLQUFLLE1BQU0sTUFBTSxnQkFBZ0IsQ0FBQyxDQUFDLEdBQUc7QUFDM0csUUFBTSxFQUFFLG1CQUFtQixJQUFJLE1BQU0sT0FBTyxxQkFBcUI7QUFDakUscUJBQW1CLE1BQU0sS0FBSyxLQUFLO0FBQ3JDOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcHJlcGFyZS1kZXZlbG9wbWVudC5tanMifQ==
