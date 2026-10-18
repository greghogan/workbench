// Generated from package-managed.mts; edit the TypeScript source.
import { capturedText } from "./values.mjs";
import { record, required } from "./values.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBhY2thZ2UtbWFuYWdlZC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY2FwdHVyZWRUZXh0IH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgcmVjb3JkLCByZXF1aXJlZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGd1aXhDaGFubmVsRmlsZSB9IGZyb20gXCIuL21hbmFnZWQtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBjb3B5RmlsZVN5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBidWlsZGVyQ1BVQXJndW1lbnRzLCBjcHVCdWRnZXQgfSBmcm9tIFwiLi9jcHUtYnVkZ2V0Lm1qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcHJlcGFyZU1hbmFnZWRQYWNrYWdlKFxuICBidWlsZGVyOiBzdHJpbmcsXG4gIG5peEltYWdlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG91dHB1dCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9SRUxFQVNFX09VVFBVVCxcbiAgc291cmNlID0gcmVzb2x2ZShcIi5cIiksXG4pIHtcbiAgaWYgKCFvdXRwdXQgfHwgIVtcIm5peFwiLCBcImd1aXhcIl0uaW5jbHVkZXMoYnVpbGRlcikpIHRocm93IG5ldyBFcnJvcihcIlVzZSBhIGNvbmZpZ3VyZWQgTml4IG9yIEd1aXggcmVsZWFzZSBwcm9maWxlXCIpO1xuICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgY3B1cyA9IGNwdUJ1ZGdldCgpO1xuICBjb25zdCBlbnYgPSB7IC4uLnByb2Nlc3MuZW52IH07XG4gIGRlbGV0ZSBlbnYuR1VJWF9CVUlMRF9PUFRJT05TO1xuICBmdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSwgY2FwdHVyZSA9IGZhbHNlLCBvcHRpb25zID0ge30pIHtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduU3luYyhjb21tYW5kLCBhcmdzLCB7XG4gICAgICBlbnYsXG4gICAgICBjd2Q6IHNvdXJjZSxcbiAgICAgIHN0ZGlvOiBjYXB0dXJlID8gW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImluaGVyaXRcIl0gOiBcImluaGVyaXRcIixcbiAgICAgIGVuY29kaW5nOiBcInV0ZjhcIixcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgfSk7XG4gICAgaWYgKGNoaWxkLmVycm9yIHx8IGNoaWxkLnN0YXR1cyAhPT0gMClcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtjb21tYW5kfSBmYWlsZWQ6ICR7U3RyaW5nKGNoaWxkLmVycm9yID8/IChjaGlsZC5zdGRlcnIgfHwgY2hpbGQuc3RhdHVzKSl9YCk7XG4gICAgcmV0dXJuIGNhcHR1cmVkVGV4dChjaGlsZC5zdGRvdXQpLnRyaW0oKTtcbiAgfVxuICBmdW5jdGlvbiBzdG9yZVBhdGgodmFsdWU6IHN0cmluZywgcHJlZml4OiBzdHJpbmcpIHtcbiAgICBpZiAoIW5ldyBSZWdFeHAoYF4vJHtwcmVmaXh9L3N0b3JlL1thLXowLTldezMyfS1bQS1aYS16MC05Ky5fLV0rJGApLnRlc3QodmFsdWUpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBFeHBlY3RlZCBvbmUgaW1tdXRhYmxlICR7cHJlZml4fSBwYWNrYWdlIG91dHB1dDogJHt2YWx1ZX1gKTtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgY29uc3QgY2hlY2sgPSByZWNvcmQoXG4gICAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihzb3VyY2UsIFwibWFuYWdlZC1yZWxlYXNlLWNoZWNrLmpzb25cIiksIFwidXRmOFwiKSksXG4gICAgXCJJbnZhbGlkIG1hbmFnZWQgcmVsZWFzZSBjaGVja1wiLFxuICApO1xuICBsZXQgcGFja2FnZVBhdGg7XG4gIGlmIChidWlsZGVyID09PSBcImd1aXhcIikge1xuICAgIGNvbnN0IGFyZ3VtZW50c18gPSBbXG4gICAgICBcInRpbWUtbWFjaGluZVwiLFxuICAgICAgXCItQ1wiLFxuICAgICAgZ3VpeENoYW5uZWxGaWxlKHByb2Nlc3MuZW52LldPUktCRU5DSF9QUk9KRUNUX1JPT1QgPz8gc291cmNlLCBzb3VyY2UpLFxuICAgICAgLi4uYnVpbGRlckNQVUFyZ3VtZW50cyhcImd1aXhcIiwgY3B1cyksXG4gICAgICBcIi0tXCIsXG4gICAgXTtcbiAgICBwYWNrYWdlUGF0aCA9IHN0b3JlUGF0aChcbiAgICAgIHJ1bihcImd1aXhcIiwgWy4uLmFyZ3VtZW50c18sIFwiYnVpbGRcIiwgLi4uYnVpbGRlckNQVUFyZ3VtZW50cyhcImd1aXhcIiwgY3B1cyksIFwiLWZcIiwgXCJwYWNrYWdlLnNjbVwiXSwgdHJ1ZSksXG4gICAgICBcImdudVwiLFxuICAgICk7XG4gICAgY29uc3QgcGFjayA9IHN0b3JlUGF0aChcbiAgICAgIHJ1bihcbiAgICAgICAgXCJndWl4XCIsXG4gICAgICAgIFtcbiAgICAgICAgICAuLi5hcmd1bWVudHNfLFxuICAgICAgICAgIFwicGFja1wiLFxuICAgICAgICAgIC4uLmJ1aWxkZXJDUFVBcmd1bWVudHMoXCJndWl4XCIsIGNwdXMpLFxuICAgICAgICAgIFwiLVJSXCIsXG4gICAgICAgICAgXCItLWNvbXByZXNzaW9uPWd6aXBcIixcbiAgICAgICAgICAuLi4oY2hlY2suc2l0ZSA/IFtdIDogW1wiLVNcIiwgXCIvYmluPWJpblwiXSksXG4gICAgICAgICAgXCItbVwiLFxuICAgICAgICAgIFwicmVsZWFzZS1tYW5pZmVzdC5zY21cIixcbiAgICAgICAgXSxcbiAgICAgICAgdHJ1ZSxcbiAgICAgICksXG4gICAgICBcImdudVwiLFxuICAgICk7XG4gICAgY29weUZpbGVTeW5jKHBhY2ssIGpvaW4ob3V0cHV0LCBcInBhY2thZ2UudGFyLmd6XCIpKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAoIW5peEltYWdlIHx8ICEvQHNoYTI1NjpbYS1mMC05XXs2NH0kLy50ZXN0KG5peEltYWdlKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5peCBleGVjdXRpb24gcmVxdWlyZXMgYSBkaWdlc3QtcGlubmVkIGJ1aWxkZXIgaW1hZ2VcIik7XG4gICAgaWYgKFtzb3VyY2UsIG91dHB1dF0uc29tZSgocGF0aCkgPT4gcGF0aC5pbmNsdWRlcyhcIixcIikpKSB0aHJvdyBuZXcgRXJyb3IoXCJEb2NrZXIgbW91bnRzIGNhbm5vdCBjb250YWluIGNvbW1hc1wiKTtcbiAgICBjb25zdCBzY3JpcHQgPSBbXG4gICAgICBgcmVzdWx0PSQobml4ICR7YnVpbGRlckNQVUFyZ3VtZW50cyhcIm5peFwiLCBjcHVzKS5qb2luKFwiIFwiKX0gLS1leHRyYS1leHBlcmltZW50YWwtZmVhdHVyZXMgXCJuaXgtY29tbWFuZCBmbGFrZXNcIiBidWlsZCAtLW5vLXVwZGF0ZS1sb2NrLWZpbGUgLS1uby1saW5rIC0tcHJpbnQtb3V0LXBhdGhzIFwiJDEjZGVmYXVsdFwiKWAsXG4gICAgICAncHJpbnRmIFwiJXNcIiBcIiRyZXN1bHRcIiA+IFwiJDIvcGFja2FnZS1wYXRoLnR4dFwiJyxcbiAgICAgICduaXgtc3RvcmUgLS1xdWVyeSAtLXJlcXVpc2l0ZXMgXCIkcmVzdWx0XCIgPiBcIiQyL3N0b3JlLXBhdGhzLnR4dFwiJyxcbiAgICAgICd4YXJncyBuaXgtc3RvcmUgLS1leHBvcnQgPCBcIiQyL3N0b3JlLXBhdGhzLnR4dFwiID4gXCIkMi9jbG9zdXJlLm5hclwiJyxcbiAgICAgICdjaG93biAtUiBcIiQzXCIgXCIkMlwiJyxcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgaWYgKHNwYXduU3luYyhcIm5peFwiLCBbXCItLXZlcnNpb25cIl0sIHsgZW52LCBzdGRpbzogXCJpZ25vcmVcIiB9KS5zdGF0dXMgPT09IDApIHtcbiAgICAgIHJ1bihcInNoXCIsIFtcbiAgICAgICAgXCItZXVcIixcbiAgICAgICAgXCItY1wiLFxuICAgICAgICBzY3JpcHQsXG4gICAgICAgIFwid29ya2JlbmNoLXBhY2thZ2VcIixcbiAgICAgICAgYHBhdGg6JHtzb3VyY2V9YCxcbiAgICAgICAgcmVzb2x2ZShvdXRwdXQpLFxuICAgICAgICBgJHtTdHJpbmcocmVxdWlyZWQocHJvY2Vzcy5nZXR1aWQsIFwiTWFuYWdlZCBwYWNrYWdpbmcgcmVxdWlyZXMgYSBQT1NJWCB1aWRcIikoKSl9OiR7U3RyaW5nKHJlcXVpcmVkKHByb2Nlc3MuZ2V0Z2lkLCBcIk1hbmFnZWQgcGFja2FnaW5nIHJlcXVpcmVzIGEgUE9TSVggZ2lkXCIpKCkpfWAsXG4gICAgICBdKTtcbiAgICB9IGVsc2VcbiAgICAgIHJ1bihwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0lfRE9DS0VSID8/IFwiZG9ja2VyXCIsIFtcbiAgICAgICAgXCJydW5cIixcbiAgICAgICAgXCItLXJtXCIsXG4gICAgICAgIFwiLS1uZXR3b3JrPWhvc3RcIixcbiAgICAgICAgXCItLW1vdW50XCIsXG4gICAgICAgIGB0eXBlPWJpbmQsc3JjPSR7c291cmNlfSxkc3Q9L3NvdXJjZSxyZWFkb25seWAsXG4gICAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgICBgdHlwZT1iaW5kLHNyYz0ke3Jlc29sdmUob3V0cHV0KX0sZHN0PS9vdXRwdXRgLFxuICAgICAgICBcIi0tbW91bnRcIixcbiAgICAgICAgYHR5cGU9dm9sdW1lLHNyYz13b3JrYmVuY2gtbml4LSR7cmVxdWlyZWQobml4SW1hZ2Uuc3BsaXQoXCJAc2hhMjU2OlwiKVsxXSwgXCJNaXNzaW5nIE5peCBpbWFnZSBkaWdlc3RcIikuc2xpY2UoMCwgMTYpfSxkc3Q9L25peGAsXG4gICAgICAgIG5peEltYWdlLFxuICAgICAgICBcInNoXCIsXG4gICAgICAgIFwiLWV1XCIsXG4gICAgICAgIFwiLWNcIixcbiAgICAgICAgc2NyaXB0LFxuICAgICAgICBcIndvcmtiZW5jaC1wYWNrYWdlXCIsXG4gICAgICAgIFwicGF0aDovc291cmNlXCIsXG4gICAgICAgIFwiL291dHB1dFwiLFxuICAgICAgICBgJHtTdHJpbmcocmVxdWlyZWQocHJvY2Vzcy5nZXR1aWQsIFwiTWFuYWdlZCBwYWNrYWdpbmcgcmVxdWlyZXMgYSBQT1NJWCB1aWRcIikoKSl9OiR7U3RyaW5nKHJlcXVpcmVkKHByb2Nlc3MuZ2V0Z2lkLCBcIk1hbmFnZWQgcGFja2FnaW5nIHJlcXVpcmVzIGEgUE9TSVggZ2lkXCIpKCkpfWAsXG4gICAgICBdKTtcbiAgICBwYWNrYWdlUGF0aCA9IHN0b3JlUGF0aChyZWFkRmlsZVN5bmMoam9pbihvdXRwdXQsIFwicGFja2FnZS1wYXRoLnR4dFwiKSwgXCJ1dGY4XCIpLCBcIm5peFwiKTtcbiAgfVxuICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG91dHB1dCwgXCJtYW5hZ2VkLXJlbGVhc2UuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IDEsIGJ1aWxkZXIsIHBhY2thZ2U6IHBhY2thZ2VQYXRoLCBjaGVjayB9LCBudWxsLCAyKSArIFwiXFxuXCIsXG4gICk7XG4gIGlmIChidWlsZGVyID09PSBcIm5peFwiKSBybVN5bmMoam9pbihvdXRwdXQsIFwicGFja2FnZS1wYXRoLnR4dFwiKSk7XG4gIGNvbnNvbGUubG9nKGBQcmVwYXJlZCAke2J1aWxkZXJ9IHBhY2thZ2UgJHtiYXNlbmFtZShwYWNrYWdlUGF0aCl9YCk7XG59XG5cbmlmIChwcm9jZXNzLmFyZ3ZbMV0gJiYgcmVzb2x2ZShwcm9jZXNzLmFyZ3ZbMV0pID09PSBpbXBvcnQubWV0YS5maWxlbmFtZSlcbiAgcHJlcGFyZU1hbmFnZWRQYWNrYWdlKFxuICAgIHJlcXVpcmVkKHByb2Nlc3MuYXJndlsyXSwgXCJNaXNzaW5nIG1hbmFnZWQgYnVpbGRlclwiKSxcbiAgICBwcm9jZXNzLmFy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QUFDO0FBQUEsTUFDakssQ0FBQztBQUNILGtCQUFjLFVBQVUsYUFBYSxLQUFLLFFBQVEsa0JBQWtCLEdBQUcsTUFBTSxHQUFHLEtBQUs7QUFBQSxFQUN2RjtBQUNBLFlBQVUsUUFBUSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3JDO0FBQUEsSUFDRSxLQUFLLFFBQVEsc0JBQXNCO0FBQUEsSUFDbkMsS0FBSyxVQUFVLEVBQUUsU0FBUyxHQUFHLFNBQVMsU0FBUyxhQUFhLE1BQU0sR0FBRyxNQUFNLENBQUMsSUFBSTtBQUFBLEVBQ2xGO0FBQ0EsTUFBSSxZQUFZLE1BQU8sUUFBTyxLQUFLLFFBQVEsa0JBQWtCLENBQUM7QUFDOUQsVUFBUSxJQUFJLFlBQVksT0FBTyxZQUFZLFNBQVMsV0FBVyxDQUFDLEVBQUU7QUFDcEU7QUFFQSxJQUFJLFFBQVEsS0FBSyxDQUFDLEtBQUssUUFBUSxRQUFRLEtBQUssQ0FBQyxDQUFDLE1BQU0sWUFBWTtBQUM5RDtBQUFBLElBQ0UsU0FBUyxRQUFRLEtBQUssQ0FBQyxHQUFHLHlCQUF5QjtBQUFBLElBQ25ELFFBQVEsS0FBSyxDQUFDO0FBQUEsSUFDZCxRQUFRLEtBQUssQ0FBQztBQUFBLElBQ2QsUUFBUSxLQUFLLENBQUM7QUFBQSxFQUNoQjsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3BhY2thZ2UtbWFuYWdlZC5tanMifQ==
