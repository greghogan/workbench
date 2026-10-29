// Generated from verify-managed.mts; edit the TypeScript source.
import { record, required, string, isStringArray } from "./values.mjs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openSync, closeSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const [artifact, source, nixImage, builder] = process.argv.slice(2);
const directory = resolve(required(artifact, "Missing release artifact"));
const sourceRoot = resolve(required(source, "Missing release source"));
const metadata = record(
  JSON.parse(readFileSync(join(directory, "managed-release.json"), "utf8")),
  "Invalid managed release metadata"
);
const checkMetadata = record(metadata.check, "Invalid release check contract");
const packagePath = string(metadata.package, "Missing release package");
if (metadata.version !== 1 || builder !== "guix" && builder !== "nix" || metadata.builder !== builder)
  throw new Error("Invalid managed release metadata");
const expected = record(
  JSON.parse(readFileSync(join(sourceRoot, "managed-release-check.json"), "utf8")),
  "Invalid expected release contract"
);
assert.deepEqual(checkMetadata, expected, "Release behavior must match the source-owned verification contract");
const executableRuntime = checkMetadata.runtime === void 0 ? void 0 : string(checkMetadata.runtime, "Invalid runtime name");
if (executableRuntime && !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(executableRuntime))
  throw new Error("Invalid managed runtime executable");
const prefix = metadata.builder === "nix" ? "nix" : "gnu";
if (!new RegExp(`^/${prefix}/store/[a-z0-9]{32}-[A-Za-z0-9+._-]+$`).test(packagePath))
  throw new Error("Invalid package store identity");
const base = metadata.builder === "nix" ? nixImage : string(expected.image, "Missing verification image");
if (!base || !/@sha256:[a-f0-9]{64}$/.test(base)) throw new Error("Verification requires a digest-pinned base image");
const docker = process.env.WORKBENCH_CI_DOCKER ?? "docker";
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? (result.stderr || result.status))}`);
  return result.stdout.trim();
}
function container(args, options = {}) {
  return execute(docker, args, options);
}
const name = `workbench-release-${randomUUID()}`;
const temporary = mkdtempSync(join(tmpdir(), "workbench-managed-verify-"));
let created = false;
try {
  container(["pull", base]);
  container([
    "create",
    "--name",
    name,
    "--network=none",
    "--mount",
    `type=bind,src=${directory},dst=/artifacts,readonly`,
    base,
    "sleep",
    "infinity"
  ]);
  created = true;
  container(["start", name]);
  const bin = metadata.builder === "nix" ? `${packagePath}/bin` : "/tmp/package/bin";
  let runtime = bin;
  if (metadata.builder === "nix") {
    const input = openSync(join(directory, "closure.nar"), "r");
    try {
      container(["exec", "-i", name, "nix-store", "--import"], { stdio: [input, "pipe", "pipe"] });
    } finally {
      closeSync(input);
    }
    container(["exec", name, "test", "-d", packagePath]);
    if (executableRuntime) {
      const propagated = container(["exec", name, "cat", `${packagePath}/nix-support/propagated-build-inputs`]).split(
        /\s+/
      );
      const candidates = propagated.filter(
        (path) => spawnSync(docker, ["exec", name, "test", "-x", `${path}/bin/${executableRuntime}`]).status === 0
      );
      assert.equal(candidates.length, 1, "Expected one selected runtime in the release closure");
      runtime = `${String(candidates[0])}/bin`;
    }
  } else {
    container([
      "exec",
      name,
      "sh",
      "-eu",
      "-c",
      "mkdir /tmp/package; tar -xzf /artifacts/package.tar.gz -C /tmp/package"
    ]);
  }
  if (checkMetadata.site) {
    if (checkMetadata.site !== "share/site") throw new Error("Unsupported static-site output path");
    const path = `${metadata.builder === "guix" ? "/tmp/package" : ""}${packagePath}/${checkMetadata.site}`;
    const site = join(temporary, "site");
    container([
      "exec",
      name,
      "sh",
      "-eu",
      "-c",
      'mkdir /tmp/verified-site; cp -r "$1"/. /tmp/verified-site/; chmod -R u+rwX /tmp/verified-site',
      "verify-site",
      path
    ]);
    container(["cp", `${name}:/tmp/verified-site`, site]);
    execute(process.execPath, [join(sourceRoot, "scripts/check-site.mjs"), site], { cwd: temporary });
  } else {
    if (!Array.isArray(checkMetadata.commands) || !checkMetadata.commands.length)
      throw new Error("Release verification must contain behavioral commands");
    for (const value of checkMetadata.commands) {
      const check = record(value, "Invalid release command");
      if (!isStringArray(check.argv) || !check.argv.length) throw new Error("Invalid release verification arguments");
      const args = check.argv.map(
        (value2) => value2.replace(
          /\{(package|bin|runtime)\}/g,
          (_, key) => key === "package" ? packagePath : key === "bin" ? bin : runtime
        )
      );
      const result = spawnSync(
        docker,
        ["exec", "--workdir", "/tmp", "--env", "GUIX_EXECUTION_ENGINE=proot", name, ...args],
        { encoding: "utf8" }
      );
      if (result.error) throw result.error;
      assert.ok(Number.isInteger(result.status), `Release command did not complete: ${String(result.signal)}`);
      if (check.status === "nonzero") assert.notEqual(result.status, 0, result.stdout);
      else assert.equal(result.status, check.status ?? 0, result.stderr || result.stdout || JSON.stringify(args));
      if (check.stdout !== void 0) assert.equal(result.stdout, check.stdout);
    }
  }
  console.log(`Verified ${String(metadata.builder)} release offline outside the checkout and host stores.`);
} finally {
  if (created) container(["rm", "--force", name]);
  rmSync(temporary, { recursive: true, force: true });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInZlcmlmeS1tYW5hZ2VkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZWNvcmQsIHJlcXVpcmVkLCBzdHJpbmcsIGlzU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyB0eXBlIFNwYXduU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2RpbmcsIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBvcGVuU3luYywgY2xvc2VTeW5jLCByZWFkRmlsZVN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmNvbnN0IFthcnRpZmFjdCwgc291cmNlLCBuaXhJbWFnZSwgYnVpbGRlcl0gPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5jb25zdCBkaXJlY3RvcnkgPSByZXNvbHZlKHJlcXVpcmVkKGFydGlmYWN0LCBcIk1pc3NpbmcgcmVsZWFzZSBhcnRpZmFjdFwiKSk7XG5jb25zdCBzb3VyY2VSb290ID0gcmVzb2x2ZShyZXF1aXJlZChzb3VyY2UsIFwiTWlzc2luZyByZWxlYXNlIHNvdXJjZVwiKSk7XG5jb25zdCBtZXRhZGF0YSA9IHJlY29yZChcbiAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJlY3RvcnksIFwibWFuYWdlZC1yZWxlYXNlLmpzb25cIiksIFwidXRmOFwiKSksXG4gIFwiSW52YWxpZCBtYW5hZ2VkIHJlbGVhc2UgbWV0YWRhdGFcIixcbik7XG5jb25zdCBjaGVja01ldGFkYXRhID0gcmVjb3JkKG1ldGFkYXRhLmNoZWNrLCBcIkludmFsaWQgcmVsZWFzZSBjaGVjayBjb250cmFjdFwiKTtcbmNvbnN0IHBhY2thZ2VQYXRoID0gc3RyaW5nKG1ldGFkYXRhLnBhY2thZ2UsIFwiTWlzc2luZyByZWxlYXNlIHBhY2thZ2VcIik7XG5pZiAobWV0YWRhdGEudmVyc2lvbiAhPT0gMSB8fCAoYnVpbGRlciAhPT0gXCJndWl4XCIgJiYgYnVpbGRlciAhPT0gXCJuaXhcIikgfHwgbWV0YWRhdGEuYnVpbGRlciAhPT0gYnVpbGRlcilcbiAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBtYW5hZ2VkIHJlbGVhc2UgbWV0YWRhdGFcIik7XG5jb25zdCBleHBlY3RlZCA9IHJlY29yZChcbiAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihzb3VyY2VSb290LCBcIm1hbmFnZWQtcmVsZWFzZS1jaGVjay5qc29uXCIpLCBcInV0ZjhcIikpLFxuICBcIkludmFsaWQgZXhwZWN0ZWQgcmVsZWFzZSBjb250cmFjdFwiLFxuKTtcbmFzc2VydC5kZWVwRXF1YWwoY2hlY2tNZXRhZGF0YSwgZXhwZWN0ZWQsIFwiUmVsZWFzZSBiZWhhdmlvciBtdXN0IG1hdGNoIHRoZSBzb3VyY2Utb3duZWQgdmVyaWZpY2F0aW9uIGNvbnRyYWN0XCIpO1xuY29uc3QgZXhlY3V0YWJsZVJ1bnRpbWUgPVxuICBjaGVja01ldGFkYXRhLnJ1bnRpbWUgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHN0cmluZyhjaGVja01ldGFkYXRhLnJ1bnRpbWUsIFwiSW52YWxpZCBydW50aW1lIG5hbWVcIik7XG5pZiAoZXhlY3V0YWJsZVJ1bnRpbWUgJiYgIS9eW2EtekEtWjAtOV1bYS16QS1aMC05Ll8rLV0qJC8udGVzdChleGVjdXRhYmxlUnVudGltZSkpXG4gIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbWFuYWdlZCBydW50aW1lIGV4ZWN1dGFibGVcIik7XG5jb25zdCBwcmVmaXggPSBtZXRhZGF0YS5idWlsZGVyID09PSBcIm5peFwiID8gXCJuaXhcIiA6IFwiZ251XCI7XG5pZiAoIW5ldyBSZWdFeHAoYF4vJHtwcmVmaXh9L3N0b3JlL1thLXowLTldezMyfS1bQS1aYS16MC05Ky5fLV0rJGApLnRlc3QocGFja2FnZVBhdGgpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHBhY2thZ2Ugc3RvcmUgaWRlbnRpdHlcIik7XG5jb25zdCBiYXNlID0gbWV0YWRhdGEuYnVpbGRlciA9PT0gXCJuaXhcIiA/IG5peEltYWdlIDogc3RyaW5nKGV4cGVjdGVkLmltYWdlLCBcIk1pc3NpbmcgdmVyaWZpY2F0aW9uIGltYWdlXCIpO1xuaWYgKCFiYXNlIHx8ICEvQHNoYTI1NjpbYS1mMC05XXs2NH0kLy50ZXN0KGJhc2UpKSB0aHJvdyBuZXcgRXJyb3IoXCJWZXJpZmljYXRpb24gcmVxdWlyZXMgYSBkaWdlc3QtcGlubmVkIGJhc2UgaW1hZ2VcIik7XG5jb25zdCBkb2NrZXIgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0lfRE9DS0VSID8/IFwiZG9ja2VyXCI7XG5mdW5jdGlvbiBleGVjdXRlKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBvcHRpb25zOiBPbWl0PFNwYXduU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2RpbmcsIFwiZW5jb2RpbmdcIj4gPSB7fSxcbikge1xuICBjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywgeyBlbmNvZGluZzogXCJ1dGY4XCIsIC4uLm9wdGlvbnMgfSk7XG4gIGlmIChyZXN1bHQuZXJyb3IgfHwgcmVzdWx0LnN0YXR1cyAhPT0gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gKHJlc3VsdC5zdGRlcnIgfHwgcmVzdWx0LnN0YXR1cykpfWApO1xuICByZXR1cm4gcmVzdWx0LnN0ZG91dC50cmltKCk7XG59XG5mdW5jdGlvbiBjb250YWluZXIoYXJnczogc3RyaW5nW10sIG9wdGlvbnM6IE9taXQ8U3Bhd25TeW5jT3B0aW9uc1dpdGhTdHJpbmdFbmNvZGluZywgXCJlbmNvZGluZ1wiPiA9IHt9KSB7XG4gIHJldHVybiBleGVjdXRlKGRvY2tlciwgYXJncywgb3B0aW9ucyk7XG59XG5jb25zdCBuYW1lID0gYHdvcmtiZW5jaC1yZWxlYXNlLSR7cmFuZG9tVVVJRCgpfWA7XG5jb25zdCB0ZW1wb3JhcnkgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC1tYW5hZ2VkLXZlcmlmeS1cIikpO1xubGV0IGNyZWF0ZWQgPSBmYWxzZTtcbnRyeSB7XG4gIGNvbnRhaW5lcihbXCJwdWxsXCIsIGJhc2VdKTtcbiAgY29udGFpbmVyKFtcbiAgICBcImNyZWF0ZVwiLFxuICAgIFwiLS1uYW1lXCIsXG4gICAgbmFtZSxcbiAgICBcIi0tbmV0d29yaz1ub25lXCIsXG4gICAgXCItLW1vdW50XCIsXG4gICAgYHR5cGU9YmluZCxzcmM9JHtkaXJlY3Rvcnl9LGRzdD0vYXJ0aWZhY3RzLHJlYWRvbmx5YCxcbiAgICBiYXNlLFxuICAgIFwic2xlZXBcIixcbiAgICBcImluZmluaXR5XCIsXG4gIF0pO1xuICBjcmVhdGVkID0gdHJ1ZTtcbiAgY29udGFpbmVyKFtcInN0YXJ0XCIsIG5hbWVdKTtcbiAgY29uc3QgYmluID0gbWV0YWRhdGEuYnVpbGRlciA9PT0gXCJuaXhcIiA/IGAke3BhY2thZ2VQYXRofS9iaW5gIDogXCIvdG1wL3BhY2thZ2UvYmluXCI7XG4gIGxldCBydW50aW1lID0gYmluO1xuICBpZiAobWV0YWRhdGEuYnVpbGRlciA9PT0gXCJuaXhcIikge1xuICAgIGNvbnN0IGlucHV0ID0gb3BlblN5bmMoam9pbihkaXJlY3RvcnksIFwiY2xvc3VyZS5uYXJcIiksIFwiclwiKTtcbiAgICB0cnkge1xuICAgICAgY29udGFpbmVyKFtcImV4ZWNcIiwgXCItaVwiLCBuYW1lLCBcIm5peC1zdG9yZVwiLCBcIi0taW1wb3J0XCJdLCB7IHN0ZGlvOiBbaW5wdXQsIFwicGlwZVwiLCBcInBpcGVcIl0gfSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlU3luYyhpbnB1dCk7XG4gICAgfVxuICAgIGNvbnRhaW5lcihbXCJleGVjXCIsIG5hbWUsIFwidGVzdFwiLCBcIi1kXCIsIHBhY2thZ2VQYXRoXSk7XG4gICAgaWYgKGV4ZWN1dGFibGVSdW50aW1lKSB7XG4gICAgICBjb25zdCBwcm9wYWdhdGVkID0gY29udGFpbmVyKFtcImV4ZWNcIiwgbmFtZSwgXCJjYXRcIiwgYCR7cGFja2FnZVBhdGh9L25peC1zdXBwb3J0L3Byb3BhZ2F0ZWQtYnVpbGQtaW5wdXRzYF0pLnNwbGl0KFxuICAgICAgICAvXFxzKy8sXG4gICAgICApO1xuICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb3BhZ2F0ZWQuZmlsdGVyKFxuICAgICAgICAocGF0aCkgPT4gc3Bhd25TeW5jKGRvY2tlciwgW1wiZXhlY1wiLCBuYW1lLCBcInRlc3RcIiwgXCIteFwiLCBgJHtwYXRofS9iaW4vJHtleGVjdXRhYmxlUnVudGltZX1gXSkuc3RhdHVzID09PSAwLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYW5kaWRhdGVzLmxlbmd0aCwgMSwgXCJFeHBlY3RlZCBvbmUgc2VsZWN0ZWQgcnVudGltZSBpbiB0aGUgcmVsZWFzZSBjbG9zdXJlXCIpO1xuICAgICAgcnVudGltZSA9IGAke1N0cmluZyhjYW5kaWRhdGVzWzBdKX0vYmluYDtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgY29udGFpbmVyKFtcbiAgICAgIFwiZXhlY1wiLFxuICAgICAgbmFtZSxcbiAgICAgIFwic2hcIixcbiAgICAgIFwiLWV1XCIsXG4gICAgICBcIi1jXCIsXG4gICAgICBcIm1rZGlyIC90bXAvcGFja2FnZTsgdGFyIC14emYgL2FydGlmYWN0cy9wYWNrYWdlLnRhci5neiAtQyAvdG1wL3BhY2thZ2VcIixcbiAgICBdKTtcbiAgfVxuICBpZiAoY2hlY2tNZXRhZGF0YS5zaXRlKSB7XG4gICAgaWYgKGNoZWNrTWV0YWRhdGEuc2l0ZSAhPT0gXCJzaGFyZS9zaXRlXCIpIHRocm93IG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIHN0YXRpYy1zaXRlIG91dHB1dCBwYXRoXCIpO1xuICAgIGNvbnN0IHBhdGggPSBgJHttZXRhZGF0YS5idWlsZGVyID09PSBcImd1aXhcIiA/IFwiL3RtcC9wYWNrYWdlXCIgOiBcIlwifSR7cGFja2FnZVBhdGh9LyR7Y2hlY2tNZXRhZGF0YS5zaXRlfWA7XG4gICAgY29uc3Qgc2l0ZSA9IGpvaW4odGVtcG9yYXJ5LCBcInNpdGVcIik7XG4gICAgY29udGFpbmVyKFtcbiAgICAgIFwiZXhlY1wiLFxuICAgICAgbmFtZSxcbiAgICAgIFwic2hcIixcbiAgICAgIFwiLWV1XCIsXG4gICAgICBcIi1jXCIsXG4gICAgICAnbWtkaXIgL3RtcC92ZXJpZmllZC1zaXRlOyBjcCAtciBcIiQxXCIvLiAvdG1wL3ZlcmlmaWVkLXNpdGUvOyBjaG1vZCAtUiB1K3J3WCAvdG1wL3ZlcmlmaWVkLXNpdGUnLFxuICAgICAgXCJ2ZXJpZnktc2l0ZVwiLFxuICAgICAgcGF0aCxcbiAgICBdKTtcbiAgICBjb250YWluZXIoW1wiY3BcIiwgYCR7bmFtZX06L3RtcC92ZXJpZmllZC1zaXRlYCwgc2l0ZV0pO1xuICAgIGV4ZWN1dGUocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4oc291cmNlUm9vdCwgXCJzY3JpcHRzL2NoZWNrLXNpdGUubWpzXCIpLCBzaXRlXSwgeyBjd2Q6IHRlbXBvcmFyeSB9KTtcbiAgfSBlbHNlIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoY2hlY2tNZXRhZGF0YS5jb21tYW5kcykgfHwgIWNoZWNrTWV0YWRhdGEuY29tbWFuZHMubGVuZ3RoKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUmVsZWFzZSB2ZXJpZmljYXRpb24gbXVzdCBjb250YWluIGJlaGF2aW9yYWwgY29tbWFuZHNcIik7XG4gICAgZm9yIChjb25zdCB2YWx1ZSBvZiBjaGVja01ldGFkYXRhLmNvbW1hbmRzKSB7XG4gICAgICBjb25zdCBjaGVjayA9IHJlY29yZCh2YWx1ZSwgXCJJbnZhbGlkIHJlbGVhc2UgY29tbWFuZFwiKTtcbiAgICAgIGlmICghaXNTdHJpbmdBcnJheShjaGVjay5hcmd2KSB8fCAhY2hlY2suYXJndi5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgcmVsZWFzZSB2ZXJpZmljYXRpb24gYXJndW1lbnRzXCIpO1xuICAgICAgY29uc3QgYXJncyA9IGNoZWNrLmFyZ3YubWFwKCh2YWx1ZTogc3RyaW5nKSA9PlxuICAgICAgICB2YWx1ZS5yZXBsYWNlKC9cXHsocGFja2FnZXxiaW58cnVudGltZSlcXH0vZywgKF8sIGtleTogc3RyaW5nKSA9PlxuICAgICAgICAgIGtleSA9PT0gXCJwYWNrYWdlXCIgPyBwYWNrYWdlUGF0aCA6IGtleSA9PT0gXCJiaW5cIiA/IGJpbiA6IHJ1bnRpbWUsXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgY29uc3QgcmVzdWx0ID0gc3Bhd25TeW5jKFxuICAgICAgICBkb2NrZXIsXG4gICAgICAgIFtcImV4ZWNcIiwgXCItLXdvcmtkaXJcIiwgXCIvdG1wXCIsIFwiLS1lbnZcIiwgXCJHVUlYX0VYRUNVVElPTl9FTkdJTkU9cHJvb3RcIiwgbmFtZSwgLi4uYXJnc10sXG4gICAgICAgIHsgZW5jb2Rpbmc6IFwidXRmOFwiIH0sXG4gICAgICApO1xuICAgICAgaWYgKHJlc3VsdC5lcnJvcikgdGhyb3cgcmVzdWx0LmVycm9yO1xuICAgICAgYXNzZXJ0Lm9rKE51bWJlci5pc0ludGVnZXIocmVzdWx0LnN0YXR1cyksIGBSZWxlYXNlIGNvbW1hbmQgZGlkIG5vdCBjb21wbGV0ZTogJHtTdHJpbmcocmVzdWx0LnNpZ25hbCl9YCk7XG4gICAgICBpZiAoY2hlY2suc3RhdHVzID09PSBcIm5vbnplcm9cIikgYXNzZXJ0Lm5vdEVxdWFsKHJlc3VsdC5zdGF0dXMsIDAsIHJlc3VsdC5zdGRvdXQpO1xuICAgICAgZWxzZSBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgY2hlY2suc3RhdHVzID8/IDAsIHJlc3VsdC5zdGRlcnIgfHwgcmVzdWx0LnN0ZG91dCB8fCBKU09OLnN0cmluZ2lmeShhcmdzKSk7XG4gICAgICBpZiAoY2hlY2suc3Rkb3V0ICE9PSB1bmRlZmluZWQpIGFzc2VydC5lcXVhbChyZXN1bHQuc3Rkb3V0LCBjaGVjay5zdGRvdXQpO1xuICAgIH1cbiAgfVxuICBjb25zb2xlLmxvZyhgVmVyaWZpZWQgJHtTdHJpbmcobWV0YWRhdGEuYnVpbGRlcil9IHJlbGVhc2Ugb2ZmbGluZSBvdXRzaWRlIHRoZSBjaGVja291dCBhbmQgaG9zdCBzdG9yZXMuYCk7XG59IGZpbmFsbHkge1xuICBpZiAoY3JlYXRlZCkgY29udGFpbmVyKFtcInJtXCIsIFwiLS1mb3JjZVwiLCBuYW1lXSk7XG4gIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsUUFBUSxVQUFVLFFBQVEscUJBQXFCO0FBQ3hELFNBQWtELGlCQUFpQjtBQUNuRSxPQUFPLFlBQVk7QUFFbkIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxVQUFVLFdBQVcsY0FBYyxhQUFhLGNBQWM7QUFDdkUsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsTUFBTSxlQUFlO0FBRTlCLE1BQU0sQ0FBQyxVQUFVLFFBQVEsVUFBVSxPQUFPLElBQUksUUFBUSxLQUFLLE1BQU0sQ0FBQztBQUNsRSxNQUFNLFlBQVksUUFBUSxTQUFTLFVBQVUsMEJBQTBCLENBQUM7QUFDeEUsTUFBTSxhQUFhLFFBQVEsU0FBUyxRQUFRLHdCQUF3QixDQUFDO0FBQ3JFLE1BQU0sV0FBVztBQUFBLEVBQ2YsS0FBSyxNQUFNLGFBQWEsS0FBSyxXQUFXLHNCQUFzQixHQUFHLE1BQU0sQ0FBQztBQUFBLEVBQ3hFO0FBQ0Y7QUFDQSxNQUFNLGdCQUFnQixPQUFPLFNBQVMsT0FBTyxnQ0FBZ0M7QUFDN0UsTUFBTSxjQUFjLE9BQU8sU0FBUyxTQUFTLHlCQUF5QjtBQUN0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
