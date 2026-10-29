// Generated from package-managed.mts; edit the TypeScript source.
import { capturedText, record, required } from "./values.mjs";
import { guixChannelFile } from "./managed-contract.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { builderCPUArguments, cpuBudget } from "./cpu-budget.mjs";
function prepareManagedPackage(builder, nixImage, output = process.env.WORKBENCH_RELEASE_OUTPUT, source = resolve(".")) {
  if (!output || !["nix", "guix"].includes(builder)) throw new Error("Use a configured Nix or Guix release profile");
  mkdirSync(output, { recursive: true });
  const cpus = cpuBudget();
  const env = { ...process.env };
  delete env.GUIX_BUILD_OPTIONS;
  function run(command, args, capture = false, options = {}) {
    const child = spawnSync(command, args, {
      env,
      cwd: source,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
      ...options
    });
    if (child.error || child.status !== 0)
      throw new Error(`${command} failed: ${String(child.error ?? (child.stderr || child.status))}`);
    return capturedText(child.stdout).trim();
  }
  function storePath(value, prefix) {
    if (!new RegExp(`^/${prefix}/store/[a-z0-9]{32}-[A-Za-z0-9+._-]+$`).test(value))
      throw new Error(`Expected one immutable ${prefix} package output: ${value}`);
    return value;
  }
  const check = record(
    JSON.parse(readFileSync(join(source, "managed-release-check.json"), "utf8")),
    "Invalid managed release check"
  );
  let packagePath;
  if (builder === "guix") {
    const arguments_ = [
      "time-machine",
      "-C",
      guixChannelFile(process.env.WORKBENCH_PROJECT_ROOT ?? source, source),
      ...builderCPUArguments("guix", cpus),
      "--"
    ];
    packagePath = storePath(
      run("guix", [...arguments_, "build", ...builderCPUArguments("guix", cpus), "-f", "package.scm"], true),
      "gnu"
    );
    const pack = storePath(
      run(
        "guix",
        [
          ...arguments_,
          "pack",
          ...builderCPUArguments("guix", cpus),
          "-RR",
          "--compression=gzip",
          ...check.site ? [] : ["-S", "/bin=bin"],
          "-m",
          "release-manifest.scm"
        ],
        true
      ),
      "gnu"
    );
    copyFileSync(pack, join(output, "package.tar.gz"));
  } else {
    if (!nixImage || !/@sha256:[a-f0-9]{64}$/.test(nixImage))
      throw new Error("Nix execution requires a digest-pinned builder image");
    if ([source, output].some((path) => path.includes(","))) throw new Error("Docker mounts cannot contain commas");
    const script = [
      `result=$(nix ${builderCPUArguments("nix", cpus).join(" ")} --extra-experimental-features "nix-command flakes" build --no-update-lock-file --no-link --print-out-paths "$1#default")`,
      'printf "%s" "$result" > "$2/package-path.txt"',
      'nix-store --query --requisites "$result" > "$2/store-paths.txt"',
      'xargs nix-store --export < "$2/store-paths.txt" > "$2/closure.nar"',
      'chown -R "$3" "$2"'
    ].join("\n");
    if (spawnSync("nix", ["--version"], { env, stdio: "ignore" }).status === 0) {
      run("sh", [
        "-eu",
        "-c",
        script,
        "workbench-package",
        `path:${source}`,
        resolve(output),
        `${String(required(process.getuid, "Managed packaging requires a POSIX uid")())}:${String(required(process.getgid, "Managed packaging requires a POSIX gid")())}`
      ]);
    } else
      run(process.env.WORKBENCH_CI_DOCKER ?? "docker", [
        "run",
        "--rm",
        "--network=host",
        "--mount",
        `type=bind,src=${source},dst=/source,readonly`,
        "--mount",
        `type=bind,src=${resolve(output)},dst=/output`,
        "--mount",
        `type=volume,src=workbench-nix-${required(nixImage.split("@sha256:")[1], "Missing Nix image digest").slice(0, 16)},dst=/nix`,
        nixImage,
        "sh",
        "-eu",
        "-c",
        script,
        "workbench-package",
        "path:/source",
        "/output",
        `${String(required(process.getuid, "Managed packaging requires a POSIX uid")())}:${String(required(process.getgid, "Managed packaging requires a POSIX gid")())}`
      ]);
    packagePath = storePath(readFileSync(join(output, "package-path.txt"), "utf8"), "nix");
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "managed-release.json"),
    JSON.stringify({ version: 1, builder, package: packagePath, check }, null, 2) + "\n"
  );
  if (builder === "nix") rmSync(join(output, "package-path.txt"));
  console.log(`Prepared ${builder} package ${basename(packagePath)}`);
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  prepareManagedPackage(
    required(process.argv[2], "Missing managed builder"),
    process.argv[3],
    process.argv[4],
    process.argv[5]
  );
export {
  prepareManagedPackage
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBhY2thZ2UtbWFuYWdlZC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY2FwdHVyZWRUZXh0LCByZWNvcmQsIHJlcXVpcmVkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5pbXBvcnQgeyBndWl4Q2hhbm5lbEZpbGUgfSBmcm9tIFwiLi9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgY29weUZpbGVTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgYnVpbGRlckNQVUFyZ3VtZW50cywgY3B1QnVkZ2V0IH0gZnJvbSBcIi4vY3B1LWJ1ZGdldC5tanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVNYW5hZ2VkUGFja2FnZShcbiAgYnVpbGRlcjogc3RyaW5nLFxuICBuaXhJbWFnZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBvdXRwdXQgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVMRUFTRV9PVVRQVVQsXG4gIHNvdXJjZSA9IHJlc29sdmUoXCIuXCIpLFxuKSB7XG4gIGlmICghb3V0cHV0IHx8ICFbXCJuaXhcIiwgXCJndWl4XCJdLmluY2x1ZGVzKGJ1aWxkZXIpKSB0aHJvdyBuZXcgRXJyb3IoXCJVc2UgYSBjb25maWd1cmVkIE5peCBvciBHdWl4IHJlbGVhc2UgcHJvZmlsZVwiKTtcbiAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNwdXMgPSBjcHVCdWRnZXQoKTtcbiAgY29uc3QgZW52ID0geyAuLi5wcm9jZXNzLmVudiB9O1xuICBkZWxldGUgZW52LkdVSVhfQlVJTERfT1BUSU9OUztcbiAgZnVuY3Rpb24gcnVuKGNvbW1hbmQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIGNhcHR1cmUgPSBmYWxzZSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgICAgZW52LFxuICAgICAgY3dkOiBzb3VyY2UsXG4gICAgICBzdGRpbzogY2FwdHVyZSA/IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpbmhlcml0XCJdIDogXCJpbmhlcml0XCIsXG4gICAgICBlbmNvZGluZzogXCJ1dGY4XCIsXG4gICAgICAuLi5vcHRpb25zLFxuICAgIH0pO1xuICAgIGlmIChjaGlsZC5lcnJvciB8fCBjaGlsZC5zdGF0dXMgIT09IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhjaGlsZC5lcnJvciA/PyAoY2hpbGQuc3RkZXJyIHx8IGNoaWxkLnN0YXR1cykpfWApO1xuICAgIHJldHVybiBjYXB0dXJlZFRleHQoY2hpbGQuc3Rkb3V0KS50cmltKCk7XG4gIH1cbiAgZnVuY3Rpb24gc3RvcmVQYXRoKHZhbHVlOiBzdHJpbmcsIHByZWZpeDogc3RyaW5nKSB7XG4gICAgaWYgKCFuZXcgUmVnRXhwKGBeLyR7cHJlZml4fS9zdG9yZS9bYS16MC05XXszMn0tW0EtWmEtejAtOSsuXy1dKyRgKS50ZXN0KHZhbHVlKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRXhwZWN0ZWQgb25lIGltbXV0YWJsZSAke3ByZWZpeH0gcGFja2FnZSBvdXRwdXQ6ICR7dmFsdWV9YCk7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGNvbnN0IGNoZWNrID0gcmVjb3JkKFxuICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oc291cmNlLCBcIm1hbmFnZWQtcmVsZWFzZS1jaGVjay5qc29uXCIpLCBcInV0ZjhcIikpLFxuICAgIFwiSW52YWxpZCBtYW5hZ2VkIHJlbGVhc2UgY2hlY2tcIixcbiAgKTtcbiAgbGV0IHBhY2thZ2VQYXRoO1xuICBpZiAoYnVpbGRlciA9PT0gXCJndWl4XCIpIHtcbiAgICBjb25zdCBhcmd1bWVudHNfID0gW1xuICAgICAgXCJ0aW1lLW1hY2hpbmVcIixcbiAgICAgIFwiLUNcIixcbiAgICAgIGd1aXhDaGFubmVsRmlsZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJPSkVDVF9ST09UID8/IHNvdXJjZSwgc291cmNlKSxcbiAgICAgIC4uLmJ1aWxkZXJDUFVBcmd1bWVudHMoXCJndWl4XCIsIGNwdXMpLFxuICAgICAgXCItLVwiLFxuICAgIF07XG4gICAgcGFja2FnZVBhdGggPSBzdG9yZVBhdGgoXG4gICAgICBydW4oXCJndWl4XCIsIFsuLi5hcmd1bWVudHNfLCBcImJ1aWxkXCIsIC4uLmJ1aWxkZXJDUFVBcmd1bWVudHMoXCJndWl4XCIsIGNwdXMpLCBcIi1mXCIsIFwicGFja2FnZS5zY21cIl0sIHRydWUpLFxuICAgICAgXCJnbnVcIixcbiAgICApO1xuICAgIGNvbnN0IHBhY2sgPSBzdG9yZVBhdGgoXG4gICAgICBydW4oXG4gICAgICAgIFwiZ3VpeFwiLFxuICAgICAgICBbXG4gICAgICAgICAgLi4uYXJndW1lbnRzXyxcbiAgICAgICAgICBcInBhY2tcIixcbiAgICAgICAgICAuLi5idWlsZGVyQ1BVQXJndW1lbnRzKFwiZ3VpeFwiLCBjcHVzKSxcbiAgICAgICAgICBcIi1SUlwiLFxuICAgICAgICAgIFwiLS1jb21wcmVzc2lvbj1nemlwXCIsXG4gICAgICAgICAgLi4uKGNoZWNrLnNpdGUgPyBbXSA6IFtcIi1TXCIsIFwiL2Jpbj1iaW5cIl0pLFxuICAgICAgICAgIFwiLW1cIixcbiAgICAgICAgICBcInJlbGVhc2UtbWFuaWZlc3Quc2NtXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHRydWUsXG4gICAgICApLFxuICAgICAgXCJnbnVcIixcbiAgICApO1xuICAgIGNvcHlGaWxlU3luYyhwYWNrLCBqb2luKG91dHB1dCwgXCJwYWNrYWdlLnRhci5nelwiKSk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKCFuaXhJbWFnZSB8fCAhL0BzaGEyNTY6W2EtZjAtOV17NjR9JC8udGVzdChuaXhJbWFnZSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJOaXggZXhlY3V0aW9uIHJlcXVpcmVzIGEgZGlnZXN0LXBpbm5lZCBidWlsZGVyIGltYWdlXCIpO1xuICAgIGlmIChbc291cmNlLCBvdXRwdXRdLnNvbWUoKHBhdGgpID0+IHBhdGguaW5jbHVkZXMoXCIsXCIpKSkgdGhyb3cgbmV3IEVycm9yKFwiRG9ja2VyIG1vdW50cyBjYW5ub3QgY29udGFpbiBjb21tYXNcIik7XG4gICAgY29uc3Qgc2NyaXB0ID0gW1xuICAgICAgYHJlc3VsdD0kKG5peCAke2J1aWxkZXJDUFVBcmd1bWVudHMoXCJuaXhcIiwgY3B1cykuam9pbihcIiBcIil9IC0tZXh0cmEtZXhwZXJpbWVudGFsLWZlYXR1cmVzIFwibml4LWNvbW1hbmQgZmxha2VzXCIgYnVpbGQgLS1uby11cGRhdGUtbG9jay1maWxlIC0tbm8tbGluayAtLXByaW50LW91dC1wYXRocyBcIiQxI2RlZmF1bHRcIilgLFxuICAgICAgJ3ByaW50ZiBcIiVzXCIgXCIkcmVzdWx0XCIgPiBcIiQyL3BhY2thZ2UtcGF0aC50eHRcIicsXG4gICAgICAnbml4LXN0b3JlIC0tcXVlcnkgLS1yZXF1aXNpdGVzIFwiJHJlc3VsdFwiID4gXCIkMi9zdG9yZS1wYXRocy50eHRcIicsXG4gICAgICAneGFyZ3Mgbml4LXN0b3JlIC0tZXhwb3J0IDwgXCIkMi9zdG9yZS1wYXRocy50eHRcIiA+IFwiJDIvY2xvc3VyZS5uYXJcIicsXG4gICAgICAnY2hvd24gLVIgXCIkM1wiIFwiJDJcIicsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIGlmIChzcGF3blN5bmMoXCJuaXhcIiwgW1wiLS12ZXJzaW9uXCJdLCB7IGVudiwgc3RkaW86IFwiaWdub3JlXCIgfSkuc3RhdHVzID09PSAwKSB7XG4gICAgICBydW4oXCJzaFwiLCBbXG4gICAgICAgIFwiLWV1XCIsXG4gICAgICAgIFwiLWNcIixcbiAgICAgICAgc2NyaXB0LFxuICAgICAgICBcIndvcmtiZW5jaC1wYWNrYWdlXCIsXG4gICAgICAgIGBwYXRoOiR7c291cmNlfWAsXG4gICAgICAgIHJlc29sdmUob3V0cHV0KSxcbiAgICAgICAgYCR7U3RyaW5nKHJlcXVpcmVkKHByb2Nlc3MuZ2V0dWlkLCBcIk1hbmFnZWQgcGFja2FnaW5nIHJlcXVpcmVzIGEgUE9TSVggdWlkXCIpKCkpfToke1N0cmluZyhyZXF1aXJlZChwcm9jZXNzLmdldGdpZCwgXCJNYW5hZ2VkIHBhY2thZ2luZyByZXF1aXJlcyBhIFBPU0lYIGdpZFwiKSgpKX1gLFxuICAgICAgXSk7XG4gICAgfSBlbHNlXG4gICAgICBydW4ocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NJX0RPQ0tFUiA/PyBcImRvY2tlclwiLCBbXG4gICAgICAgIFwicnVuXCIsXG4gICAgICAgIFwiLS1ybVwiLFxuICAgICAgICBcIi0tbmV0d29yaz1ob3N0XCIsXG4gICAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgICBgdHlwZT1iaW5kLHNyYz0ke3NvdXJjZX0sZHN0PS9zb3VyY2UscmVhZG9ubHlgLFxuICAgICAgICBcIi0tbW91bnRcIixcbiAgICAgICAgYHR5cGU9YmluZCxzcmM9JHtyZXNvbHZlKG91dHB1dCl9LGRzdD0vb3V0cHV0YCxcbiAgICAgICAgXCItLW1vdW50XCIsXG4gICAgICAgIGB0eXBlPXZvbHVtZSxzcmM9d29ya2JlbmNoLW5peC0ke3JlcXVpcmVkKG5peEltYWdlLnNwbGl0KFwiQHNoYTI1NjpcIilbMV0sIFwiTWlzc2luZyBOaXggaW1hZ2UgZGlnZXN0XCIpLnNsaWNlKDAsIDE2KX0sZHN0PS9uaXhgLFxuICAgICAgICBuaXhJbWFnZSxcbiAgICAgICAgXCJzaFwiLFxuICAgICAgICBcIi1ldVwiLFxuICAgICAgICBcIi1jXCIsXG4gICAgICAgIHNjcmlwdCxcbiAgICAgICAgXCJ3b3JrYmVuY2gtcGFja2FnZVwiLFxuICAgICAgICBcInBhdGg6L3NvdXJjZVwiLFxuICAgICAgICBcIi9vdXRwdXRcIixcbiAgICAgICAgYCR7U3RyaW5nKHJlcXVpcmVkKHByb2Nlc3MuZ2V0dWlkLCBcIk1hbmFnZWQgcGFja2FnaW5nIHJlcXVpcmVzIGEgUE9TSVggdWlkXCIpKCkpfToke1N0cmluZyhyZXF1aXJlZChwcm9jZXNzLmdldGdpZCwgXCJNYW5hZ2VkIHBhY2thZ2luZyByZXF1aXJlcyBhIFBPU0lYIGdpZFwiKSgpKX1gLFxuICAgICAgXSk7XG4gICAgcGFja2FnZVBhdGggPSBzdG9yZVBhdGgocmVhZEZpbGVTeW5jKGpvaW4ob3V0cHV0LCBcInBhY2thZ2UtcGF0aC50eHRcIiksIFwidXRmOFwiKSwgXCJuaXhcIik7XG4gIH1cbiAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihvdXRwdXQsIFwibWFuYWdlZC1yZWxlYXNlLmpzb25cIiksXG4gICAgSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiAxLCBidWlsZGVyLCBwYWNrYWdlOiBwYWNrYWdlUGF0aCwgY2hlY2sgfSwgbnVsbCwgMikgKyBcIlxcblwiLFxuICApO1xuICBpZiAoYnVpbGRlciA9PT0gXCJuaXhcIikgcm1TeW5jKGpvaW4ob3V0cHV0LCBcInBhY2thZ2UtcGF0aC50eHRcIikpO1xuICBjb25zb2xlLmxvZyhgUHJlcGFyZWQgJHtidWlsZGVyfSBwYWNrYWdlICR7YmFzZW5hbWUocGFja2FnZVBhdGgpfWApO1xufVxuXG5pZiAocHJvY2Vzcy5hcmd2WzFdICYmIHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSA9PT0gaW1wb3J0Lm1ldGEuZmlsZW5hbWUpXG4gIHByZXBhcmVNYW5hZ2VkUGFja2FnZShcbiAgICByZXF1aXJlZChwcm9jZXNzLmFyZ3ZbMl0sIFwiTWlzc2luZyBtYW5hZ2VkIGJ1aWxkZXJcIiksXG4gICAgcHJvY2Vzcy5hcmd2WzNdLFxuICAgIHByb2Nlc3MuYXJndls0XSxcbiAg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LFFBQVEsa0JBQWtCLEdBQUcsTUFBTSxHQUFHLEtBQUs7QUFBQSxFQUN2RjtBQUNBLFlBQVUsUUFBUSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3JDO0FBQUEsSUFDRSxLQUFLLFFBQVEsc0JBQXNCO0FBQUEsSUFDbkMsS0FBSyxVQUFVLEVBQUUsU0FBUyxHQUFHLFNBQVMsU0FBUyxhQUFhLE1BQU0sR0FBRyxNQUFNLENBQUMsSUFBSTtBQUFBLEVBQ2xGO0FBQ0EsTUFBSSxZQUFZLE1BQU8sUUFBTyxLQUFLLFFBQVEsa0JBQWtCLENBQUM7QUFDOUQsVUFBUSxJQUFJLFlBQVksT0FBTyxZQUFZLFNBQVMsV0FBVyxDQUFDLEVBQUU7QUFDcEU7QUFFQSxJQUFJLFFBQVEsS0FBSyxDQUFDLEtBQUssUUFBUSxRQUFRLEtBQUssQ0FBQyxDQUFDLE1BQU0sWUFBWTtBQUM5RDtBQUFBLElBQ0UsU0FBUyxRQUFRLEtBQUssQ0FBQyxHQUFHLHlCQUF5QjtBQUFBLElBQ25ELFFBQVEsS0FBSyxDQUFDO0FBQUEsSUFDZCxRQUFRLEtBQUssQ0FBQztBQUFBLElBQ2QsUUFBUSxLQUFLLENBQUM7QUFBQSxFQUNoQjsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3BhY2thZ2UtbWFuYWdlZC5tanMifQ==
