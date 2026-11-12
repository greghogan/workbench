// Generated from verify-managed.mts; edit the TypeScript source.
import { record, required, string, isStringArray } from "../app/src/core/runtime/values.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInZlcmlmeS1tYW5hZ2VkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZWNvcmQsIHJlcXVpcmVkLCBzdHJpbmcsIGlzU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgdHlwZSBTcGF3blN5bmNPcHRpb25zV2l0aFN0cmluZ0VuY29kaW5nLCBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgb3BlblN5bmMsIGNsb3NlU3luYywgcmVhZEZpbGVTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5jb25zdCBbYXJ0aWZhY3QsIHNvdXJjZSwgbml4SW1hZ2UsIGJ1aWxkZXJdID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpO1xuY29uc3QgZGlyZWN0b3J5ID0gcmVzb2x2ZShyZXF1aXJlZChhcnRpZmFjdCwgXCJNaXNzaW5nIHJlbGVhc2UgYXJ0aWZhY3RcIikpO1xuY29uc3Qgc291cmNlUm9vdCA9IHJlc29sdmUocmVxdWlyZWQoc291cmNlLCBcIk1pc3NpbmcgcmVsZWFzZSBzb3VyY2VcIikpO1xuY29uc3QgbWV0YWRhdGEgPSByZWNvcmQoXG4gIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcIm1hbmFnZWQtcmVsZWFzZS5qc29uXCIpLCBcInV0ZjhcIikpLFxuICBcIkludmFsaWQgbWFuYWdlZCByZWxlYXNlIG1ldGFkYXRhXCIsXG4pO1xuY29uc3QgY2hlY2tNZXRhZGF0YSA9IHJlY29yZChtZXRhZGF0YS5jaGVjaywgXCJJbnZhbGlkIHJlbGVhc2UgY2hlY2sgY29udHJhY3RcIik7XG5jb25zdCBwYWNrYWdlUGF0aCA9IHN0cmluZyhtZXRhZGF0YS5wYWNrYWdlLCBcIk1pc3NpbmcgcmVsZWFzZSBwYWNrYWdlXCIpO1xuaWYgKG1ldGFkYXRhLnZlcnNpb24gIT09IDEgfHwgKGJ1aWxkZXIgIT09IFwiZ3VpeFwiICYmIGJ1aWxkZXIgIT09IFwibml4XCIpIHx8IG1ldGFkYXRhLmJ1aWxkZXIgIT09IGJ1aWxkZXIpXG4gIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbWFuYWdlZCByZWxlYXNlIG1ldGFkYXRhXCIpO1xuY29uc3QgZXhwZWN0ZWQgPSByZWNvcmQoXG4gIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oc291cmNlUm9vdCwgXCJtYW5hZ2VkLXJlbGVhc2UtY2hlY2suanNvblwiKSwgXCJ1dGY4XCIpKSxcbiAgXCJJbnZhbGlkIGV4cGVjdGVkIHJlbGVhc2UgY29udHJhY3RcIixcbik7XG5hc3NlcnQuZGVlcEVxdWFsKGNoZWNrTWV0YWRhdGEsIGV4cGVjdGVkLCBcIlJlbGVhc2UgYmVoYXZpb3IgbXVzdCBtYXRjaCB0aGUgc291cmNlLW93bmVkIHZlcmlmaWNhdGlvbiBjb250cmFjdFwiKTtcbmNvbnN0IGV4ZWN1dGFibGVSdW50aW1lID1cbiAgY2hlY2tNZXRhZGF0YS5ydW50aW1lID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBzdHJpbmcoY2hlY2tNZXRhZGF0YS5ydW50aW1lLCBcIkludmFsaWQgcnVudGltZSBuYW1lXCIpO1xuaWYgKGV4ZWN1dGFibGVSdW50aW1lICYmICEvXlthLXpBLVowLTldW2EtekEtWjAtOS5fKy1dKiQvLnRlc3QoZXhlY3V0YWJsZVJ1bnRpbWUpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1hbmFnZWQgcnVudGltZSBleGVjdXRhYmxlXCIpO1xuY29uc3QgcHJlZml4ID0gbWV0YWRhdGEuYnVpbGRlciA9PT0gXCJuaXhcIiA/IFwibml4XCIgOiBcImdudVwiO1xuaWYgKCFuZXcgUmVnRXhwKGBeLyR7cHJlZml4fS9zdG9yZS9bYS16MC05XXszMn0tW0EtWmEtejAtOSsuXy1dKyRgKS50ZXN0KHBhY2thZ2VQYXRoKSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBwYWNrYWdlIHN0b3JlIGlkZW50aXR5XCIpO1xuY29uc3QgYmFzZSA9IG1ldGFkYXRhLmJ1aWxkZXIgPT09IFwibml4XCIgPyBuaXhJbWFnZSA6IHN0cmluZyhleHBlY3RlZC5pbWFnZSwgXCJNaXNzaW5nIHZlcmlmaWNhdGlvbiBpbWFnZVwiKTtcbmlmICghYmFzZSB8fCAhL0BzaGEyNTY6W2EtZjAtOV17NjR9JC8udGVzdChiYXNlKSkgdGhyb3cgbmV3IEVycm9yKFwiVmVyaWZpY2F0aW9uIHJlcXVpcmVzIGEgZGlnZXN0LXBpbm5lZCBiYXNlIGltYWdlXCIpO1xuY29uc3QgZG9ja2VyID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NJX0RPQ0tFUiA/PyBcImRvY2tlclwiO1xuZnVuY3Rpb24gZXhlY3V0ZShcbiAgY29tbWFuZDogc3RyaW5nLFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgb3B0aW9uczogT21pdDxTcGF3blN5bmNPcHRpb25zV2l0aFN0cmluZ0VuY29kaW5nLCBcImVuY29kaW5nXCI+ID0ge30sXG4pIHtcbiAgY29uc3QgcmVzdWx0ID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHsgZW5jb2Rpbmc6IFwidXRmOFwiLCAuLi5vcHRpb25zIH0pO1xuICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgIT09IDApXG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2NvbW1hbmR9IGZhaWxlZDogJHtTdHJpbmcocmVzdWx0LmVycm9yID8/IChyZXN1bHQuc3RkZXJyIHx8IHJlc3VsdC5zdGF0dXMpKX1gKTtcbiAgcmV0dXJuIHJlc3VsdC5zdGRvdXQudHJpbSgpO1xufVxuZnVuY3Rpb24gY29udGFpbmVyKGFyZ3M6IHN0cmluZ1tdLCBvcHRpb25zOiBPbWl0PFNwYXduU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2RpbmcsIFwiZW5jb2RpbmdcIj4gPSB7fSkge1xuICByZXR1cm4gZXhlY3V0ZShkb2NrZXIsIGFyZ3MsIG9wdGlvbnMpO1xufVxuY29uc3QgbmFtZSA9IGB3b3JrYmVuY2gtcmVsZWFzZS0ke3JhbmRvbVVVSUQoKX1gO1xuY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtbWFuYWdlZC12ZXJpZnktXCIpKTtcbmxldCBjcmVhdGVkID0gZmFsc2U7XG50cnkge1xuICBjb250YWluZXIoW1wicHVsbFwiLCBiYXNlXSk7XG4gIGNvbnRhaW5lcihbXG4gICAgXCJjcmVhdGVcIixcbiAgICBcIi0tbmFtZVwiLFxuICAgIG5hbWUsXG4gICAgXCItLW5ldHdvcms9bm9uZVwiLFxuICAgIFwiLS1tb3VudFwiLFxuICAgIGB0eXBlPWJpbmQsc3JjPSR7ZGlyZWN0b3J5fSxkc3Q9L2FydGlmYWN0cyxyZWFkb25seWAsXG4gICAgYmFzZSxcbiAgICBcInNsZWVwXCIsXG4gICAgXCJpbmZpbml0eVwiLFxuICBdKTtcbiAgY3JlYXRlZCA9IHRydWU7XG4gIGNvbnRhaW5lcihbXCJzdGFydFwiLCBuYW1lXSk7XG4gIGNvbnN0IGJpbiA9IG1ldGFkYXRhLmJ1aWxkZXIgPT09IFwibml4XCIgPyBgJHtwYWNrYWdlUGF0aH0vYmluYCA6IFwiL3RtcC9wYWNrYWdlL2JpblwiO1xuICBsZXQgcnVudGltZSA9IGJpbjtcbiAgaWYgKG1ldGFkYXRhLmJ1aWxkZXIgPT09IFwibml4XCIpIHtcbiAgICBjb25zdCBpbnB1dCA9IG9wZW5TeW5jKGpvaW4oZGlyZWN0b3J5LCBcImNsb3N1cmUubmFyXCIpLCBcInJcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnRhaW5lcihbXCJleGVjXCIsIFwiLWlcIiwgbmFtZSwgXCJuaXgtc3RvcmVcIiwgXCItLWltcG9ydFwiXSwgeyBzdGRpbzogW2lucHV0LCBcInBpcGVcIiwgXCJwaXBlXCJdIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZVN5bmMoaW5wdXQpO1xuICAgIH1cbiAgICBjb250YWluZXIoW1wiZXhlY1wiLCBuYW1lLCBcInRlc3RcIiwgXCItZFwiLCBwYWNrYWdlUGF0aF0pO1xuICAgIGlmIChleGVjdXRhYmxlUnVudGltZSkge1xuICAgICAgY29uc3QgcHJvcGFnYXRlZCA9IGNvbnRhaW5lcihbXCJleGVjXCIsIG5hbWUsIFwiY2F0XCIsIGAke3BhY2thZ2VQYXRofS9uaXgtc3VwcG9ydC9wcm9wYWdhdGVkLWJ1aWxkLWlucHV0c2BdKS5zcGxpdChcbiAgICAgICAgL1xccysvLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBwcm9wYWdhdGVkLmZpbHRlcihcbiAgICAgICAgKHBhdGgpID0+IHNwYXduU3luYyhkb2NrZXIsIFtcImV4ZWNcIiwgbmFtZSwgXCJ0ZXN0XCIsIFwiLXhcIiwgYCR7cGF0aH0vYmluLyR7ZXhlY3V0YWJsZVJ1bnRpbWV9YF0pLnN0YXR1cyA9PT0gMCxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FuZGlkYXRlcy5sZW5ndGgsIDEsIFwiRXhwZWN0ZWQgb25lIHNlbGVjdGVkIHJ1bnRpbWUgaW4gdGhlIHJlbGVhc2UgY2xvc3VyZVwiKTtcbiAgICAgIHJ1bnRpbWUgPSBgJHtTdHJpbmcoY2FuZGlkYXRlc1swXSl9L2JpbmA7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvbnRhaW5lcihbXG4gICAgICBcImV4ZWNcIixcbiAgICAgIG5hbWUsXG4gICAgICBcInNoXCIsXG4gICAgICBcIi1ldVwiLFxuICAgICAgXCItY1wiLFxuICAgICAgXCJta2RpciAvdG1wL3BhY2thZ2U7IHRhciAteHpmIC9hcnRpZmFjdHMvcGFja2FnZS50YXIuZ3ogLUMgL3RtcC9wYWNrYWdlXCIsXG4gICAgXSk7XG4gIH1cbiAgaWYgKGNoZWNrTWV0YWRhdGEuc2l0ZSkge1xuICAgIGlmIChjaGVja01ldGFkYXRhLnNpdGUgIT09IFwic2hhcmUvc2l0ZVwiKSB0aHJvdyBuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBzdGF0aWMtc2l0ZSBvdXRwdXQgcGF0aFwiKTtcbiAgICBjb25zdCBwYXRoID0gYCR7bWV0YWRhdGEuYnVpbGRlciA9PT0gXCJndWl4XCIgPyBcIi90bXAvcGFja2FnZVwiIDogXCJcIn0ke3BhY2thZ2VQYXRofS8ke2NoZWNrTWV0YWRhdGEuc2l0ZX1gO1xuICAgIGNvbnN0IHNpdGUgPSBqb2luKHRlbXBvcmFyeSwgXCJzaXRlXCIpO1xuICAgIGNvbnRhaW5lcihbXG4gICAgICBcImV4ZWNcIixcbiAgICAgIG5hbWUsXG4gICAgICBcInNoXCIsXG4gICAgICBcIi1ldVwiLFxuICAgICAgXCItY1wiLFxuICAgICAgJ21rZGlyIC90bXAvdmVyaWZpZWQtc2l0ZTsgY3AgLXIgXCIkMVwiLy4gL3RtcC92ZXJpZmllZC1zaXRlLzsgY2htb2QgLVIgdStyd1ggL3RtcC92ZXJpZmllZC1zaXRlJyxcbiAgICAgIFwidmVyaWZ5LXNpdGVcIixcbiAgICAgIHBhdGgsXG4gICAgXSk7XG4gICAgY29udGFpbmVyKFtcImNwXCIsIGAke25hbWV9Oi90bXAvdmVyaWZpZWQtc2l0ZWAsIHNpdGVdKTtcbiAgICBleGVjdXRlKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKHNvdXJjZVJvb3QsIFwic2NyaXB0cy9jaGVjay1zaXRlLm1qc1wiKSwgc2l0ZV0sIHsgY3dkOiB0ZW1wb3JhcnkgfSk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGNoZWNrTWV0YWRhdGEuY29tbWFuZHMpIHx8ICFjaGVja01ldGFkYXRhLmNvbW1hbmRzLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJlbGVhc2UgdmVyaWZpY2F0aW9uIG11c3QgY29udGFpbiBiZWhhdmlvcmFsIGNvbW1hbmRzXCIpO1xuICAgIGZvciAoY29uc3QgdmFsdWUgb2YgY2hlY2tNZXRhZGF0YS5jb21tYW5kcykge1xuICAgICAgY29uc3QgY2hlY2sgPSByZWNvcmQodmFsdWUsIFwiSW52YWxpZCByZWxlYXNlIGNvbW1hbmRcIik7XG4gICAgICBpZiAoIWlzU3RyaW5nQXJyYXkoY2hlY2suYXJndikgfHwgIWNoZWNrLmFyZ3YubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHJlbGVhc2UgdmVyaWZpY2F0aW9uIGFyZ3VtZW50c1wiKTtcbiAgICAgIGNvbnN0IGFyZ3MgPSBjaGVjay5hcmd2Lm1hcCgodmFsdWU6IHN0cmluZykgPT5cbiAgICAgICAgdmFsdWUucmVwbGFjZSgvXFx7KHBhY2thZ2V8YmlufHJ1bnRpbWUpXFx9L2csIChfLCBrZXk6IHN0cmluZykgPT5cbiAgICAgICAgICBrZXkgPT09IFwicGFja2FnZVwiID8gcGFja2FnZVBhdGggOiBrZXkgPT09IFwiYmluXCIgPyBiaW4gOiBydW50aW1lLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhcbiAgICAgICAgZG9ja2VyLFxuICAgICAgICBbXCJleGVjXCIsIFwiLS13b3JrZGlyXCIsIFwiL3RtcFwiLCBcIi0tZW52XCIsIFwiR1VJWF9FWEVDVVRJT05fRU5HSU5FPXByb290XCIsIG5hbWUsIC4uLmFyZ3NdLFxuICAgICAgICB7IGVuY29kaW5nOiBcInV0ZjhcIiB9LFxuICAgICAgKTtcbiAgICAgIGlmIChyZXN1bHQuZXJyb3IpIHRocm93IHJlc3VsdC5lcnJvcjtcbiAgICAgIGFzc2VydC5vayhOdW1iZXIuaXNJbnRlZ2VyKHJlc3VsdC5zdGF0dXMpLCBgUmVsZWFzZSBjb21tYW5kIGRpZCBub3QgY29tcGxldGU6ICR7U3RyaW5nKHJlc3VsdC5zaWduYWwpfWApO1xuICAgICAgaWYgKGNoZWNrLnN0YXR1cyA9PT0gXCJub256ZXJvXCIpIGFzc2VydC5ub3RFcXVhbChyZXN1bHQuc3RhdHVzLCAwLCByZXN1bHQuc3Rkb3V0KTtcbiAgICAgIGVsc2UgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIGNoZWNrLnN0YXR1cyA/PyAwLCByZXN1bHQuc3RkZXJyIHx8IHJlc3VsdC5zdGRvdXQgfHwgSlNPTi5zdHJpbmdpZnkoYXJncykpO1xuICAgICAgaWYgKGNoZWNrLnN0ZG91dCAhPT0gdW5kZWZpbmVkKSBhc3NlcnQuZXF1YWwocmVzdWx0LnN0ZG91dCwgY2hlY2suc3Rkb3V0KTtcbiAgICB9XG4gIH1cbiAgY29uc29sZS5sb2coYFZlcmlmaWVkICR7U3RyaW5nKG1ldGFkYXRhLmJ1aWxkZXIpfSByZWxlYXNlIG9mZmxpbmUgb3V0c2lkZSB0aGUgY2hlY2tvdXQgYW5kIGhvc3Qgc3RvcmVzLmApO1xufSBmaW5hbGx5IHtcbiAgaWYgKGNyZWF0ZWQpIGNvbnRhaW5lcihbXCJybVwiLCBcIi0tZm9yY2VcIiwgbmFtZV0pO1xuICBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsVUFBVSxRQUFRLHFCQUFxQjtBQUN4RCxTQUFrRCxpQkFBaUI7QUFDbkUsT0FBTyxZQUFZO0FBRW5CLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsVUFBVSxXQUFXLGNBQWMsYUFBYSxjQUFjO0FBQ3ZFLFNBQVMsY0FBYztBQUN2QixTQUFTLE1BQU0sZUFBZTtBQUU5QixNQUFNLENBQUMsVUFBVSxRQUFRLFVBQVUsT0FBTyxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDbEUsTUFBTSxZQUFZLFFBQVEsU0FBUyxVQUFVLDBCQUEwQixDQUFDO0FBQ3hFLE1BQU0sYUFBYSxRQUFRLFNBQVMsUUFBUSx3QkFBd0IsQ0FBQztBQUNyRSxNQUFNLFdBQVc7QUFBQSxFQUNmLEtBQUssTUFBTSxhQUFhLEtBQUssV0FBVyxzQkFBc0IsR0FBRyxNQUFNLENBQUM7QUFBQSxFQUN4RTtBQUNGO0FBQ0EsTUFBTSxnQkFBZ0IsT0FBTyxTQUFTLE9BQU8sZ0NBQWdDO0FBQzdFLE1BQU0sY0FBYyxPQUFP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
