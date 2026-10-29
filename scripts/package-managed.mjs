// Generated from package-managed.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import { capturedText, record, required } from "./values.mjs";
import { guixChannelFile } from "./managed-contract.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builderCPUArguments, cpuBudget } from "./cpu-budget.mjs";
function prepareManagedPackage(builder, nixImage, output = process.env.WORKBENCH_RELEASE_OUTPUT, source = resolve(".")) {
  if (!output || !["nix", "guix"].includes(builder)) throw new Error("Use a configured Nix or Guix release profile");
  mkdirSync(output, { recursive: true });
  const cpus = cpuBudget();
  const env = { ...process.env };
  delete env.GUIX_BUILD_OPTIONS;
  function run(command, args, stdout = "inherit") {
    const options = {
      env,
      cwd: source,
      stdio: [stdout === "pipe" ? "ignore" : "inherit", stdout, "inherit"],
      encoding: "utf8",
      shell: false
    };
    const child = spawnSync(command, args, options);
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
      run("guix", [...arguments_, "build", ...builderCPUArguments("guix", cpus), "-f", "package.scm"], "pipe"),
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
        "pipe"
      ),
      "gnu"
    );
    copyFileSync(pack, join(output, "package.tar.gz"));
  } else {
    if (!nixImage || !/@sha256:[a-f0-9]{64}$/.test(nixImage))
      throw new Error("Nix execution requires a digest-pinned builder image");
    if ([source, output].some((path) => path.includes(","))) throw new Error("Docker mounts cannot contain commas");
    const hostNix = spawnSync("nix", ["--version"], { env, stdio: "ignore" }).status === 0;
    const execute = (command, args, stdout) => hostNix ? run(command, args, stdout) : run(
      "docker",
      [
        "run",
        "--rm",
        "--network=host",
        "--mount",
        `type=bind,src=${source},dst=/source,readonly`,
        "--mount",
        `type=volume,src=workbench-nix-${required(nixImage.split("@sha256:")[1], "Missing Nix image digest").slice(0, 16)},dst=/nix`,
        nixImage,
        command,
        ...args
      ],
      stdout
    );
    packagePath = storePath(
      execute(
        "nix",
        [
          ...builderCPUArguments("nix", cpus),
          "--extra-experimental-features",
          "nix-command flakes",
          "build",
          "--no-update-lock-file",
          "--no-link",
          "--print-out-paths",
          `path:${hostNix ? pathToFileURL(source).pathname : "/source"}#default`
        ],
        "pipe"
      ),
      "nix"
    );
    const paths = execute("nix-store", ["--query", "--requisites", packagePath], "pipe").split(/\r?\n/).map((path) => storePath(path, "nix"));
    if (!paths.includes(packagePath)) throw new Error("Nix closure does not contain the selected package");
    const archive = openSync(join(output, "closure.nar"), "w");
    try {
      execute("nix-store", ["--export", ...paths], archive);
    } finally {
      closeSync(archive);
    }
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "managed-release.json"),
    JSON.stringify({ version: 1, builder, package: packagePath, check }, null, 2) + "\n"
  );
  console.log(`Prepared ${builder} package ${basename(packagePath)}`);
}
if (isMainScript(import.meta.url))
  prepareManagedPackage(
    required(process.argv[2], "Missing managed builder"),
    process.argv[3],
    process.argv[4],
    process.argv[5]
  );
export {
  prepareManagedPackage
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBhY2thZ2UtbWFuYWdlZC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNNYWluU2NyaXB0IH0gZnJvbSBcIi4vc2NyaXB0LWVudHJ5Lm1qc1wiO1xuaW1wb3J0IHsgY2FwdHVyZWRUZXh0LCByZWNvcmQsIHJlcXVpcmVkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5pbXBvcnQgeyBndWl4Q2hhbm5lbEZpbGUgfSBmcm9tIFwiLi9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jLCB0eXBlIFNwYXduU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2RpbmcgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBjb3B5RmlsZVN5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCBvcGVuU3luYywgY2xvc2VTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgYnVpbGRlckNQVUFyZ3VtZW50cywgY3B1QnVkZ2V0IH0gZnJvbSBcIi4vY3B1LWJ1ZGdldC5tanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVNYW5hZ2VkUGFja2FnZShcbiAgYnVpbGRlcjogc3RyaW5nLFxuICBuaXhJbWFnZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBvdXRwdXQgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVMRUFTRV9PVVRQVVQsXG4gIHNvdXJjZSA9IHJlc29sdmUoXCIuXCIpLFxuKSB7XG4gIGlmICghb3V0cHV0IHx8ICFbXCJuaXhcIiwgXCJndWl4XCJdLmluY2x1ZGVzKGJ1aWxkZXIpKSB0aHJvdyBuZXcgRXJyb3IoXCJVc2UgYSBjb25maWd1cmVkIE5peCBvciBHdWl4IHJlbGVhc2UgcHJvZmlsZVwiKTtcbiAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNwdXMgPSBjcHVCdWRnZXQoKTtcbiAgY29uc3QgZW52ID0geyAuLi5wcm9jZXNzLmVudiB9O1xuICBkZWxldGUgZW52LkdVSVhfQlVJTERfT1BUSU9OUztcbiAgZnVuY3Rpb24gcnVuKGNvbW1hbmQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIHN0ZG91dDogXCJwaXBlXCIgfCBcImluaGVyaXRcIiB8IG51bWJlciA9IFwiaW5oZXJpdFwiKSB7XG4gICAgY29uc3Qgb3B0aW9ucyA9IHtcbiAgICAgIGVudixcbiAgICAgIGN3ZDogc291cmNlLFxuICAgICAgc3RkaW86IFtzdGRvdXQgPT09IFwicGlwZVwiID8gXCJpZ25vcmVcIiA6IFwiaW5oZXJpdFwiLCBzdGRvdXQsIFwiaW5oZXJpdFwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0ZjhcIixcbiAgICAgIHNoZWxsOiBmYWxzZSxcbiAgICB9IHNhdGlzZmllcyBTcGF3blN5bmNPcHRpb25zV2l0aFN0cmluZ0VuY29kaW5nO1xuICAgIGNvbnN0IGNoaWxkID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpO1xuICAgIGlmIChjaGlsZC5lcnJvciB8fCBjaGlsZC5zdGF0dXMgIT09IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhjaGlsZC5lcnJvciA/PyAoY2hpbGQuc3RkZXJyIHx8IGNoaWxkLnN0YXR1cykpfWApO1xuICAgIHJldHVybiBjYXB0dXJlZFRleHQoY2hpbGQuc3Rkb3V0KS50cmltKCk7XG4gIH1cbiAgZnVuY3Rpb24gc3RvcmVQYXRoKHZhbHVlOiBzdHJpbmcsIHByZWZpeDogc3RyaW5nKSB7XG4gICAgaWYgKCFuZXcgUmVnRXhwKGBeLyR7cHJlZml4fS9zdG9yZS9bYS16MC05XXszMn0tW0EtWmEtejAtOSsuXy1dKyRgKS50ZXN0KHZhbHVlKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRXhwZWN0ZWQgb25lIGltbXV0YWJsZSAke3ByZWZpeH0gcGFja2FnZSBvdXRwdXQ6ICR7dmFsdWV9YCk7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGNvbnN0IGNoZWNrID0gcmVjb3JkKFxuICAgIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oc291cmNlLCBcIm1hbmFnZWQtcmVsZWFzZS1jaGVjay5qc29uXCIpLCBcInV0ZjhcIikpLFxuICAgIFwiSW52YWxpZCBtYW5hZ2VkIHJlbGVhc2UgY2hlY2tcIixcbiAgKTtcbiAgbGV0IHBhY2thZ2VQYXRoO1xuICBpZiAoYnVpbGRlciA9PT0gXCJndWl4XCIpIHtcbiAgICBjb25zdCBhcmd1bWVudHNfID0gW1xuICAgICAgXCJ0aW1lLW1hY2hpbmVcIixcbiAgICAgIFwiLUNcIixcbiAgICAgIGd1aXhDaGFubmVsRmlsZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJPSkVDVF9ST09UID8/IHNvdXJjZSwgc291cmNlKSxcbiAgICAgIC4uLmJ1aWxkZXJDUFVBcmd1bWVudHMoXCJndWl4XCIsIGNwdXMpLFxuICAgICAgXCItLVwiLFxuICAgIF07XG4gICAgcGFja2FnZVBhdGggPSBzdG9yZVBhdGgoXG4gICAgICBydW4oXCJndWl4XCIsIFsuLi5hcmd1bWVudHNfLCBcImJ1aWxkXCIsIC4uLmJ1aWxkZXJDUFVBcmd1bWVudHMoXCJndWl4XCIsIGNwdXMpLCBcIi1mXCIsIFwicGFja2FnZS5zY21cIl0sIFwicGlwZVwiKSxcbiAgICAgIFwiZ251XCIsXG4gICAgKTtcbiAgICBjb25zdCBwYWNrID0gc3RvcmVQYXRoKFxuICAgICAgcnVuKFxuICAgICAgICBcImd1aXhcIixcbiAgICAgICAgW1xuICAgICAgICAgIC4uLmFyZ3VtZW50c18sXG4gICAgICAgICAgXCJwYWNrXCIsXG4gICAgICAgICAgLi4uYnVpbGRlckNQVUFyZ3VtZW50cyhcImd1aXhcIiwgY3B1cyksXG4gICAgICAgICAgXCItUlJcIixcbiAgICAgICAgICBcIi0tY29tcHJlc3Npb249Z3ppcFwiLFxuICAgICAgICAgIC4uLihjaGVjay5zaXRlID8gW10gOiBbXCItU1wiLCBcIi9iaW49YmluXCJdKSxcbiAgICAgICAgICBcIi1tXCIsXG4gICAgICAgICAgXCJyZWxlYXNlLW1hbmlmZXN0LnNjbVwiLFxuICAgICAgICBdLFxuICAgICAgICBcInBpcGVcIixcbiAgICAgICksXG4gICAgICBcImdudVwiLFxuICAgICk7XG4gICAgY29weUZpbGVTeW5jKHBhY2ssIGpvaW4ob3V0cHV0LCBcInBhY2thZ2UudGFyLmd6XCIpKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAoIW5peEltYWdlIHx8ICEvQHNoYTI1NjpbYS1mMC05XXs2NH0kLy50ZXN0KG5peEltYWdlKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5peCBleGVjdXRpb24gcmVxdWlyZXMgYSBkaWdlc3QtcGlubmVkIGJ1aWxkZXIgaW1hZ2VcIik7XG4gICAgaWYgKFtzb3VyY2UsIG91dHB1dF0uc29tZSgocGF0aCkgPT4gcGF0aC5pbmNsdWRlcyhcIixcIikpKSB0aHJvdyBuZXcgRXJyb3IoXCJEb2NrZXIgbW91bnRzIGNhbm5vdCBjb250YWluIGNvbW1hc1wiKTtcbiAgICBjb25zdCBob3N0Tml4ID0gc3Bhd25TeW5jKFwibml4XCIsIFtcIi0tdmVyc2lvblwiXSwgeyBlbnYsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnN0YXR1cyA9PT0gMDtcbiAgICBjb25zdCBleGVjdXRlID0gKGNvbW1hbmQ6IFwibml4XCIgfCBcIm5peC1zdG9yZVwiLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSwgc3Rkb3V0OiBcInBpcGVcIiB8IG51bWJlcikgPT5cbiAgICAgIGhvc3ROaXhcbiAgICAgICAgPyBydW4oY29tbWFuZCwgYXJncywgc3Rkb3V0KVxuICAgICAgICA6IHJ1bihcbiAgICAgICAgICAgIFwiZG9ja2VyXCIsXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgIFwicnVuXCIsXG4gICAgICAgICAgICAgIFwiLS1ybVwiLFxuICAgICAgICAgICAgICBcIi0tbmV0d29yaz1ob3N0XCIsXG4gICAgICAgICAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgICAgICAgICBgdHlwZT1iaW5kLHNyYz0ke3NvdXJjZX0sZHN0PS9zb3VyY2UscmVhZG9ubHlgLFxuICAgICAgICAgICAgICBcIi0tbW91bnRcIixcbiAgICAgICAgICAgICAgYHR5cGU9dm9sdW1lLHNyYz13b3JrYmVuY2gtbml4LSR7cmVxdWlyZWQobml4SW1hZ2Uuc3BsaXQoXCJAc2hhMjU2OlwiKVsxXSwgXCJNaXNzaW5nIE5peCBpbWFnZSBkaWdlc3RcIikuc2xpY2UoMCwgMTYpfSxkc3Q9L25peGAsXG4gICAgICAgICAgICAgIG5peEltYWdlLFxuICAgICAgICAgICAgICBjb21tYW5kLFxuICAgICAgICAgICAgICAuLi5hcmdzLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHN0ZG91dCxcbiAgICAgICAgICApO1xuICAgIHBhY2thZ2VQYXRoID0gc3RvcmVQYXRoKFxuICAgICAgZXhlY3V0ZShcbiAgICAgICAgXCJuaXhcIixcbiAgICAgICAgW1xuICAgICAgICAgIC4uLmJ1aWxkZXJDUFVBcmd1bWVudHMoXCJuaXhcIiwgY3B1cyksXG4gICAgICAgICAgXCItLWV4dHJhLWV4cGVyaW1lbnRhbC1mZWF0dXJlc1wiLFxuICAgICAgICAgIFwibml4LWNvbW1hbmQgZmxha2VzXCIsXG4gICAgICAgICAgXCJidWlsZFwiLFxuICAgICAgICAgIFwiLS1uby11cGRhdGUtbG9jay1maWxlXCIsXG4gICAgICAgICAgXCItLW5vLWxpbmtcIixcbiAgICAgICAgICBcIi0tcHJpbnQtb3V0LXBhdGhzXCIsXG4gICAgICAgICAgYHBhdGg6JHtob3N0Tml4ID8gcGF0aFRvRmlsZVVSTChzb3VyY2UpLnBhdGhuYW1lIDogXCIvc291cmNlXCJ9I2RlZmF1bHRgLFxuICAgICAgICBdLFxuICAgICAgICBcInBpcGVcIixcbiAgICAgICksXG4gICAgICBcIm5peFwiLFxuICAgICk7XG4gICAgY29uc3QgcGF0aHMgPSBleGVjdXRlKFwibml4LXN0b3JlXCIsIFtcIi0tcXVlcnlcIiwgXCItLXJlcXVpc2l0ZXNcIiwgcGFja2FnZVBhdGhdLCBcInBpcGVcIilcbiAgICAgIC5zcGxpdCgvXFxyP1xcbi8pXG4gICAgICAubWFwKChwYXRoKSA9PiBzdG9yZVBhdGgocGF0aCwgXCJuaXhcIikpO1xuICAgIGlmICghcGF0aHMuaW5jbHVkZXMocGFja2FnZVBhdGgpKSB0aHJvdyBuZXcgRXJyb3IoXCJOaXggY2xvc3VyZSBkb2VzIG5vdCBjb250YWluIHRoZSBzZWxlY3RlZCBwYWNrYWdlXCIpO1xuICAgIGNvbnN0IGFyY2hpdmUgPSBvcGVuU3luYyhqb2luKG91dHB1dCwgXCJjbG9zdXJlLm5hclwiKSwgXCJ3XCIpO1xuICAgIHRyeSB7XG4gICAgICBleGVjdXRlKFwibml4LXN0b3JlXCIsIFtcIi0tZXhwb3J0XCIsIC4uLnBhdGhzXSwgYXJjaGl2ZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlU3luYyhhcmNoaXZlKTtcbiAgICB9XG4gIH1cbiAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihvdXRwdXQsIFwibWFuYWdlZC1yZWxlYXNlLmpzb25cIiksXG4gICAgSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiAxLCBidWlsZGVyLCBwYWNrYWdlOiBwYWNrYWdlUGF0aCwgY2hlY2sgfSwgbnVsbCwgMikgKyBcIlxcblwiLFxuICApO1xuICBjb25zb2xlLmxvZyhgUHJlcGFyZWQgJHtidWlsZGVyfSBwYWNrYWdlICR7YmFzZW5hbWUocGFja2FnZVBhdGgpfWApO1xufVxuXG5pZiAoaXNNYWluU2NyaXB0KGltcG9ydC5tZXRhLnVybCkpXG4gIHByZXBhcmVNYW5hZ2VkUGFja2FnZShcbiAgICByZXF1aXJlZChwcm9jZXNzLmFyZ3ZbMl0sIFwiTWlzc2luZyBtYW5hZ2VkIGJ1aWxkZXJcIiksXG4gICAgcHJvY2Vzcy5hcmd2WzNdLFxuICAgIHByb2Nlc3MuYXJndls0XSxcbiAgICBwcm9jZXNzLmFyZ3ZbNV0sXG4gICk7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGNBQWMsUUFBUSxnQkFBZ0I7QUFFL0MsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxpQkFBMEQ7QUFDbkUsU0FBUyxjQUFjLFdBQVcsY0FBYyxlQUFlLFVBQVUsaUJBQWlCO0FBQzFGLFNBQVMsVUFBVSxNQUFNLGVBQWU7QUFDeEMsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxxQkFBcUIsaUJBQWlCO0FBRXhDLFNBQVMsc0JBQ2QsU0FDQSxVQUNBLFNBQVMsUUFBUSxJQUFJLDBCQUNyQixTQUFTLFFBQVEsR0FBRyxHQUNwQjtBQUNBLE1BQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxPQUFPLE1BQU0sRUFBRSxTQUFTLE9BQU8sRUFBRyxPQUFNLElBQUksTUFBTSw4Q0FBOEM7QUFDakgsWUFBVSxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckMsUUFBTSxPQUFPLFVBQVU7QUFDdkIsUUFBTSxNQUFNLEVBQUUsR0FBRyxRQUFRLElBQUk7QUFDN0IsU0FBTyxJQUFJO0FBQ1gsV0FBUyxJQUFJLFNBQWlCLE1BQXlCLFNBQXNDLFdBQVc7QUFDdEcsVUFBTSxVQUFVO0FBQUEsTUFDZDtBQUFBLE1BQ0EsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFdBQVcsU0FBUyxXQUFXLFdBQVcsUUFBUSxTQUFTO0FBQUEsTUFDbkUsVUFBVTtBQUFBLE1BQ1YsT0FBTztBQUFBLElBQ1Q7QUFDQSxVQUFNLFFBQVEsVUFBVSxTQUFTLE1BQU0sT0FBTztBQUM5QyxRQUFJLE1BQU0sU0FBUyxNQUFNLFdBQVc7QUFDbEMsWUFBTSxJQUFJLE1BQU0sR0FBRyxPQUFPLFlBQVksT0FBTyxNQUFNLFVBQVUsTUFBTSxVQUFVLE1BQU0sT0FBTyxDQUFDLEVBQUU7QUFDL0YsV0FBTyxhQUFhLE1BQU0s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TSxtREFBbUQ7QUFDckcsVUFBTSxVQUFVLFNBQVMsS0FBSyxRQUFRLGFBQWEsR0FBRyxHQUFHO0FBQ3pELFFBQUk7QUFDRixjQUFRLGFBQWEsQ0FBQyxZQUFZLEdBQUcsS0FBSyxHQUFHLE9BQU87QUFBQSxJQUN0RCxVQUFFO0FBQ0EsZ0JBQVUsT0FBTztBQUFBLElBQ25CO0FBQUEsRUFDRjtBQUNBLFlBQVUsUUFBUSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3JDO0FBQUEsSUFDRSxLQUFLLFFBQVEsc0JBQXNCO0FBQUEsSUFDbkMsS0FBSyxVQUFVLEVBQUUsU0FBUyxHQUFHLFNBQVMsU0FBUyxhQUFhLE1BQU0sR0FBRyxNQUFNLENBQUMsSUFBSTtBQUFBLEVBQ2xGO0FBQ0EsVUFBUSxJQUFJLFlBQVksT0FBTyxZQUFZLFNBQVMsV0FBVyxDQUFDLEVBQUU7QUFDcEU7QUFFQSxJQUFJLGFBQWEsWUFBWSxHQUFHO0FBQzlCO0FBQUEsSUFDRSxTQUFTLFFBQVEsS0FBSyxDQUFDLEdBQUcseUJBQXlCO0FBQUEsSUFDbkQsUUFBUSxLQUFLLENBQUM7QUFBQSxJQUNkLFFBQVEsS0FBSyxDQUFDO0FBQUEsSUFDZCxRQUFRLEtBQUssQ0FBQztBQUFBLEVBQ2hCOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcGFja2FnZS1tYW5hZ2VkLm1qcyJ9
