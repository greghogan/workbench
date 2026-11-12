// Generated from package-managed.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import { capturedText, record, required } from "../app/src/core/runtime/values.mjs";
import { guixChannelFile } from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builderCPUArguments, cpuBudget } from "../app/src/core/execution/checks/cpu-budget.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBhY2thZ2UtbWFuYWdlZC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaXNNYWluU2NyaXB0IH0gZnJvbSBcIi4vc2NyaXB0LWVudHJ5Lm1qc1wiO1xuaW1wb3J0IHsgY2FwdHVyZWRUZXh0LCByZWNvcmQsIHJlcXVpcmVkIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcblxuaW1wb3J0IHsgZ3VpeENoYW5uZWxGaWxlIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vZW52aXJvbm1lbnRzL21hbmFnZWQvbWFuYWdlZC1jb250cmFjdC5tanNcIjtcbmltcG9ydCB7IHNwYXduU3luYywgdHlwZSBTcGF3blN5bmNPcHRpb25zV2l0aFN0cmluZ0VuY29kaW5nIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgY29weUZpbGVTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYywgb3BlblN5bmMsIGNsb3NlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IGJ1aWxkZXJDUFVBcmd1bWVudHMsIGNwdUJ1ZGdldCB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2NoZWNrcy9jcHUtYnVkZ2V0Lm1qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcHJlcGFyZU1hbmFnZWRQYWNrYWdlKFxuICBidWlsZGVyOiBzdHJpbmcsXG4gIG5peEltYWdlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG91dHB1dCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9SRUxFQVNFX09VVFBVVCxcbiAgc291cmNlID0gcmVzb2x2ZShcIi5cIiksXG4pIHtcbiAgaWYgKCFvdXRwdXQgfHwgIVtcIm5peFwiLCBcImd1aXhcIl0uaW5jbHVkZXMoYnVpbGRlcikpIHRocm93IG5ldyBFcnJvcihcIlVzZSBhIGNvbmZpZ3VyZWQgTml4IG9yIEd1aXggcmVsZWFzZSBwcm9maWxlXCIpO1xuICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgY3B1cyA9IGNwdUJ1ZGdldCgpO1xuICBjb25zdCBlbnYgPSB7IC4uLnByb2Nlc3MuZW52IH07XG4gIGRlbGV0ZSBlbnYuR1VJWF9CVUlMRF9PUFRJT05TO1xuICBmdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSwgc3Rkb3V0OiBcInBpcGVcIiB8IFwiaW5oZXJpdFwiIHwgbnVtYmVyID0gXCJpbmhlcml0XCIpIHtcbiAgICBjb25zdCBvcHRpb25zID0ge1xuICAgICAgZW52LFxuICAgICAgY3dkOiBzb3VyY2UsXG4gICAgICBzdGRpbzogW3N0ZG91dCA9PT0gXCJwaXBlXCIgPyBcImlnbm9yZVwiIDogXCJpbmhlcml0XCIsIHN0ZG91dCwgXCJpbmhlcml0XCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgc2hlbGw6IGZhbHNlLFxuICAgIH0gc2F0aXNmaWVzIFNwYXduU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2Rpbmc7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywgb3B0aW9ucyk7XG4gICAgaWYgKGNoaWxkLmVycm9yIHx8IGNoaWxkLnN0YXR1cyAhPT0gMClcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtjb21tYW5kfSBmYWlsZWQ6ICR7U3RyaW5nKGNoaWxkLmVycm9yID8/IChjaGlsZC5zdGRlcnIgfHwgY2hpbGQuc3RhdHVzKSl9YCk7XG4gICAgcmV0dXJuIGNhcHR1cmVkVGV4dChjaGlsZC5zdGRvdXQpLnRyaW0oKTtcbiAgfVxuICBmdW5jdGlvbiBzdG9yZVBhdGgodmFsdWU6IHN0cmluZywgcHJlZml4OiBzdHJpbmcpIHtcbiAgICBpZiAoIW5ldyBSZWdFeHAoYF4vJHtwcmVmaXh9L3N0b3JlL1thLXowLTldezMyfS1bQS1aYS16MC05Ky5fLV0rJGApLnRlc3QodmFsdWUpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBFeHBlY3RlZCBvbmUgaW1tdXRhYmxlICR7cHJlZml4fSBwYWNrYWdlIG91dHB1dDogJHt2YWx1ZX1gKTtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgY29uc3QgY2hlY2sgPSByZWNvcmQoXG4gICAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihzb3VyY2UsIFwibWFuYWdlZC1yZWxlYXNlLWNoZWNrLmpzb25cIiksIFwidXRmOFwiKSksXG4gICAgXCJJbnZhbGlkIG1hbmFnZWQgcmVsZWFzZSBjaGVja1wiLFxuICApO1xuICBsZXQgcGFja2FnZVBhdGg7XG4gIGlmIChidWlsZGVyID09PSBcImd1aXhcIikge1xuICAgIGNvbnN0IGFyZ3VtZW50c18gPSBbXG4gICAgICBcInRpbWUtbWFjaGluZVwiLFxuICAgICAgXCItQ1wiLFxuICAgICAgZ3VpeENoYW5uZWxGaWxlKHByb2Nlc3MuZW52LldPUktCRU5DSF9QUk9KRUNUX1JPT1QgPz8gc291cmNlLCBzb3VyY2UpLFxuICAgICAgLi4uYnVpbGRlckNQVUFyZ3VtZW50cyhcImd1aXhcIiwgY3B1cyksXG4gICAgICBcIi0tXCIsXG4gICAgXTtcbiAgICBwYWNrYWdlUGF0aCA9IHN0b3JlUGF0aChcbiAgICAgIHJ1bihcImd1aXhcIiwgWy4uLmFyZ3VtZW50c18sIFwiYnVpbGRcIiwgLi4uYnVpbGRlckNQVUFyZ3VtZW50cyhcImd1aXhcIiwgY3B1cyksIFwiLWZcIiwgXCJwYWNrYWdlLnNjbVwiXSwgXCJwaXBlXCIpLFxuICAgICAgXCJnbnVcIixcbiAgICApO1xuICAgIGNvbnN0IHBhY2sgPSBzdG9yZVBhdGgoXG4gICAgICBydW4oXG4gICAgICAgIFwiZ3VpeFwiLFxuICAgICAgICBbXG4gICAgICAgICAgLi4uYXJndW1lbnRzXyxcbiAgICAgICAgICBcInBhY2tcIixcbiAgICAgICAgICAuLi5idWlsZGVyQ1BVQXJndW1lbnRzKFwiZ3VpeFwiLCBjcHVzKSxcbiAgICAgICAgICBcIi1SUlwiLFxuICAgICAgICAgIFwiLS1jb21wcmVzc2lvbj1nemlwXCIsXG4gICAgICAgICAgLi4uKGNoZWNrLnNpdGUgPyBbXSA6IFtcIi1TXCIsIFwiL2Jpbj1iaW5cIl0pLFxuICAgICAgICAgIFwiLW1cIixcbiAgICAgICAgICBcInJlbGVhc2UtbWFuaWZlc3Quc2NtXCIsXG4gICAgICAgIF0sXG4gICAgICAgIFwicGlwZVwiLFxuICAgICAgKSxcbiAgICAgIFwiZ251XCIsXG4gICAgKTtcbiAgICBjb3B5RmlsZVN5bmMocGFjaywgam9pbihvdXRwdXQsIFwicGFja2FnZS50YXIuZ3pcIikpO1xuICB9IGVsc2Uge1xuICAgIGlmICghbml4SW1hZ2UgfHwgIS9Ac2hhMjU2OlthLWYwLTldezY0fSQvLnRlc3Qobml4SW1hZ2UpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTml4IGV4ZWN1dGlvbiByZXF1aXJlcyBhIGRpZ2VzdC1waW5uZWQgYnVpbGRlciBpbWFnZVwiKTtcbiAgICBpZiAoW3NvdXJjZSwgb3V0cHV0XS5zb21lKChwYXRoKSA9PiBwYXRoLmluY2x1ZGVzKFwiLFwiKSkpIHRocm93IG5ldyBFcnJvcihcIkRvY2tlciBtb3VudHMgY2Fubm90IGNvbnRhaW4gY29tbWFzXCIpO1xuICAgIGNvbnN0IGhvc3ROaXggPSBzcGF3blN5bmMoXCJuaXhcIiwgW1wiLS12ZXJzaW9uXCJdLCB7IGVudiwgc3RkaW86IFwiaWdub3JlXCIgfSkuc3RhdHVzID09PSAwO1xuICAgIGNvbnN0IGV4ZWN1dGUgPSAoY29tbWFuZDogXCJuaXhcIiB8IFwibml4LXN0b3JlXCIsIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLCBzdGRvdXQ6IFwicGlwZVwiIHwgbnVtYmVyKSA9PlxuICAgICAgaG9zdE5peFxuICAgICAgICA/IHJ1bihjb21tYW5kLCBhcmdzLCBzdGRvdXQpXG4gICAgICAgIDogcnVuKFxuICAgICAgICAgICAgXCJkb2NrZXJcIixcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgXCJydW5cIixcbiAgICAgICAgICAgICAgXCItLXJtXCIsXG4gICAgICAgICAgICAgIFwiLS1uZXR3b3JrPWhvc3RcIixcbiAgICAgICAgICAgICAgXCItLW1vdW50XCIsXG4gICAgICAgICAgICAgIGB0eXBlPWJpbmQsc3JjPSR7c291cmNlfSxkc3Q9L3NvdXJjZSxyZWFkb25seWAsXG4gICAgICAgICAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgICAgICAgICBgdHlwZT12b2x1bWUsc3JjPXdvcmtiZW5jaC1uaXgtJHtyZXF1aXJlZChuaXhJbWFnZS5zcGxpdChcIkBzaGEyNTY6XCIpWzFdLCBcIk1pc3NpbmcgTml4IGltYWdlIGRpZ2VzdFwiKS5zbGljZSgwLCAxNil9LGRzdD0vbml4YCxcbiAgICAgICAgICAgICAgbml4SW1hZ2UsXG4gICAgICAgICAgICAgIGNvbW1hbmQsXG4gICAgICAgICAgICAgIC4uLmFyZ3MsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgc3Rkb3V0LFxuICAgICAgICAgICk7XG4gICAgcGFja2FnZVBhdGggPSBzdG9yZVBhdGgoXG4gICAgICBleGVjdXRlKFxuICAgICAgICBcIm5peFwiLFxuICAgICAgICBbXG4gICAgICAgICAgLi4uYnVpbGRlckNQVUFyZ3VtZW50cyhcIm5peFwiLCBjcHVzKSxcbiAgICAgICAgICBcIi0tZXh0cmEtZXhwZXJpbWVudGFsLWZlYXR1cmVzXCIsXG4gICAgICAgICAgXCJuaXgtY29tbWFuZCBmbGFrZXNcIixcbiAgICAgICAgICBcImJ1aWxkXCIsXG4gICAgICAgICAgXCItLW5vLXVwZGF0ZS1sb2NrLWZpbGVcIixcbiAgICAgICAgICBcIi0tbm8tbGlua1wiLFxuICAgICAgICAgIFwiLS1wcmludC1vdXQtcGF0aHNcIixcbiAgICAgICAgICBgcGF0aDoke2hvc3ROaXggPyBwYXRoVG9GaWxlVVJMKHNvdXJjZSkucGF0aG5hbWUgOiBcIi9zb3VyY2VcIn0jZGVmYXVsdGAsXG4gICAgICAgIF0sXG4gICAgICAgIFwicGlwZVwiLFxuICAgICAgKSxcbiAgICAgIFwibml4XCIsXG4gICAgKTtcbiAgICBjb25zdCBwYXRocyA9IGV4ZWN1dGUoXCJuaXgtc3RvcmVcIiwgW1wiLS1xdWVyeVwiLCBcIi0tcmVxdWlzaXRlc1wiLCBwYWNrYWdlUGF0aF0sIFwicGlwZVwiKVxuICAgICAgLnNwbGl0KC9cXHI/XFxuLylcbiAgICAgIC5tYXAoKHBhdGgpID0+IHN0b3JlUGF0aChwYXRoLCBcIm5peFwiKSk7XG4gICAgaWYgKCFwYXRocy5pbmNsdWRlcyhwYWNrYWdlUGF0aCkpIHRocm93IG5ldyBFcnJvcihcIk5peCBjbG9zdXJlIGRvZXMgbm90IGNvbnRhaW4gdGhlIHNlbGVjdGVkIHBhY2thZ2VcIik7XG4gICAgY29uc3QgYXJjaGl2ZSA9IG9wZW5TeW5jKGpvaW4ob3V0cHV0LCBcImNsb3N1cmUubmFyXCIpLCBcIndcIik7XG4gICAgdHJ5IHtcbiAgICAgIGV4ZWN1dGUoXCJuaXgtc3RvcmVcIiwgW1wiLS1leHBvcnRcIiwgLi4ucGF0aHNdLCBhcmNoaXZlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VTeW5jKGFyY2hpdmUpO1xuICAgIH1cbiAgfVxuICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG91dHB1dCwgXCJtYW5hZ2VkLXJlbGVhc2UuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IDEsIGJ1aWxkZXIsIHBhY2thZ2U6IHBhY2thZ2VQYXRoLCBjaGVjayB9LCBudWxsLCAyKSArIFwiXFxuXCIsXG4gICk7XG4gIGNvbnNvbGUubG9nKGBQcmVwYXJlZCAke2J1aWxkZXJ9IHBhY2thZ2UgJHtiYXNlbmFtZShwYWNrYWdlUGF0aCl9YCk7XG59XG5cbmlmIChpc01haW5TY3JpcHQoaW1wb3J0Lm1ldGEudXJsKSlcbiAgcHJlcGFyZU1hbmFnZWRQYWNrYWdlKFxuICAgIHJlcXVpcmVkKHByb2Nlc3MuYXJndlsyXSwgXCJNaXNzaW5nIG1hbmFnZWQgYnVpbGRlclwiKSxcbiAgICBwcm9jZXNzLmFyZ3ZbM10sXG4gICAgcHJvY2Vzcy5hcmd2WzRdLFxuICAgIHByb2Nlc3MuYXJndls1XSxcbiAgKTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsY0FBYyxRQUFRLGdCQUFnQjtBQUUvQyxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGlCQUEwRDtBQUNuRSxTQUFTLGNBQWMsV0FBVyxjQUFjLGVBQWUsVUFBVSxpQkFBaUI7QUFDMUYsU0FBUyxVQUFVLE1BQU0sZUFBZTtBQUN4QyxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLHFCQUFxQixpQkFBaUI7QUFFeEMsU0FBUyxzQkFDZCxTQUNBLFVBQ0EsU0FBUyxRQUFRLElBQUksMEJBQ3JCLFNBQVMsUUFBUSxHQUFHLEdBQ3BCO0FBQ0EsTUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLE9BQU8sTUFBTSxFQUFFLFNBQVMsT0FBTyxFQUFHLE9BQU0sSUFBSSxNQUFNLDhDQUE4QztBQUNqSCxZQUFVLFFBQVEsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNyQyxRQUFNLE9BQU8sVUFBVTtBQUN2QixRQUFNLE1BQU0sRUFBRSxHQUFHLFFBQVEsSUFBSTtBQUM3QixTQUFPLElBQUk7QUFDWCxXQUFTLElBQUksU0FBaUIsTUFBeUIsU0FBc0MsV0FBVztBQUN0RyxVQUFNLFVBQVU7QUFBQSxNQUNkO0FBQUEsTUFDQSxLQUFLO0FBQUEsTUFDTCxPQUFPLENBQUMsV0FBVyxTQUFTLFdBQVcsV0FBVyxRQUFRLFNBQVM7QUFBQSxNQUNuRSxVQUFVO0FBQUEsTUFDVixPQUFPO0FBQUEsSUFDVDtBQUNBLFVBQU0sUUFBUSxVQUFVLFNBQVMsTUFBTSxPQUFPO0FBQzlDLFFBQUksTUFBTSxTQUFTLE1BQU0sV0FBVztBQUNs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
