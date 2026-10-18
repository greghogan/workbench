// Generated from verify-managed.mts; edit the TypeScript source.
import { record, required, string, isStringArray } from "./values.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInZlcmlmeS1tYW5hZ2VkLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZWNvcmQsIHJlcXVpcmVkLCBzdHJpbmcsIGlzU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgdHlwZSB7IFNwYXduU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2RpbmcgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IG9wZW5TeW5jLCBjbG9zZVN5bmMsIHJlYWRGaWxlU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuY29uc3QgW2FydGlmYWN0LCBzb3VyY2UsIG5peEltYWdlLCBidWlsZGVyXSA9IHByb2Nlc3MuYXJndi5zbGljZSgyKTtcbmNvbnN0IGRpcmVjdG9yeSA9IHJlc29sdmUocmVxdWlyZWQoYXJ0aWZhY3QsIFwiTWlzc2luZyByZWxlYXNlIGFydGlmYWN0XCIpKTtcbmNvbnN0IHNvdXJjZVJvb3QgPSByZXNvbHZlKHJlcXVpcmVkKHNvdXJjZSwgXCJNaXNzaW5nIHJlbGVhc2Ugc291cmNlXCIpKTtcbmNvbnN0IG1ldGFkYXRhID0gcmVjb3JkKFxuICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgXCJtYW5hZ2VkLXJlbGVhc2UuanNvblwiKSwgXCJ1dGY4XCIpKSxcbiAgXCJJbnZhbGlkIG1hbmFnZWQgcmVsZWFzZSBtZXRhZGF0YVwiLFxuKTtcbmNvbnN0IGNoZWNrTWV0YWRhdGEgPSByZWNvcmQobWV0YWRhdGEuY2hlY2ssIFwiSW52YWxpZCByZWxlYXNlIGNoZWNrIGNvbnRyYWN0XCIpO1xuY29uc3QgcGFja2FnZVBhdGggPSBzdHJpbmcobWV0YWRhdGEucGFja2FnZSwgXCJNaXNzaW5nIHJlbGVhc2UgcGFja2FnZVwiKTtcbmlmIChtZXRhZGF0YS52ZXJzaW9uICE9PSAxIHx8IChidWlsZGVyICE9PSBcImd1aXhcIiAmJiBidWlsZGVyICE9PSBcIm5peFwiKSB8fCBtZXRhZGF0YS5idWlsZGVyICE9PSBidWlsZGVyKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1hbmFnZWQgcmVsZWFzZSBtZXRhZGF0YVwiKTtcbmNvbnN0IGV4cGVjdGVkID0gcmVjb3JkKFxuICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHNvdXJjZVJvb3QsIFwibWFuYWdlZC1yZWxlYXNlLWNoZWNrLmpzb25cIiksIFwidXRmOFwiKSksXG4gIFwiSW52YWxpZCBleHBlY3RlZCByZWxlYXNlIGNvbnRyYWN0XCIsXG4pO1xuYXNzZXJ0LmRlZXBFcXVhbChjaGVja01ldGFkYXRhLCBleHBlY3RlZCwgXCJSZWxlYXNlIGJlaGF2aW9yIG11c3QgbWF0Y2ggdGhlIHNvdXJjZS1vd25lZCB2ZXJpZmljYXRpb24gY29udHJhY3RcIik7XG5jb25zdCBleGVjdXRhYmxlUnVudGltZSA9XG4gIGNoZWNrTWV0YWRhdGEucnVudGltZSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogc3RyaW5nKGNoZWNrTWV0YWRhdGEucnVudGltZSwgXCJJbnZhbGlkIHJ1bnRpbWUgbmFtZVwiKTtcbmlmIChleGVjdXRhYmxlUnVudGltZSAmJiAhL15bYS16QS1aMC05XVthLXpBLVowLTkuXystXSokLy50ZXN0KGV4ZWN1dGFibGVSdW50aW1lKSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBtYW5hZ2VkIHJ1bnRpbWUgZXhlY3V0YWJsZVwiKTtcbmNvbnN0IHByZWZpeCA9IG1ldGFkYXRhLmJ1aWxkZXIgPT09IFwibml4XCIgPyBcIm5peFwiIDogXCJnbnVcIjtcbmlmICghbmV3IFJlZ0V4cChgXi8ke3ByZWZpeH0vc3RvcmUvW2EtejAtOV17MzJ9LVtBLVphLXowLTkrLl8tXSskYCkudGVzdChwYWNrYWdlUGF0aCkpXG4gIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgcGFja2FnZSBzdG9yZSBpZGVudGl0eVwiKTtcbmNvbnN0IGJhc2UgPSBtZXRhZGF0YS5idWlsZGVyID09PSBcIm5peFwiID8gbml4SW1hZ2UgOiBzdHJpbmcoZXhwZWN0ZWQuaW1hZ2UsIFwiTWlzc2luZyB2ZXJpZmljYXRpb24gaW1hZ2VcIik7XG5pZiAoIWJhc2UgfHwgIS9Ac2hhMjU2OlthLWYwLTldezY0fSQvLnRlc3QoYmFzZSkpIHRocm93IG5ldyBFcnJvcihcIlZlcmlmaWNhdGlvbiByZXF1aXJlcyBhIGRpZ2VzdC1waW5uZWQgYmFzZSBpbWFnZVwiKTtcbmNvbnN0IGRvY2tlciA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9DSV9ET0NLRVIgPz8gXCJkb2NrZXJcIjtcbmZ1bmN0aW9uIGV4ZWN1dGUoXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIG9wdGlvbnM6IE9taXQ8U3Bhd25TeW5jT3B0aW9uc1dpdGhTdHJpbmdFbmNvZGluZywgXCJlbmNvZGluZ1wiPiA9IHt9LFxuKSB7XG4gIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhjb21tYW5kLCBhcmdzLCB7IGVuY29kaW5nOiBcInV0ZjhcIiwgLi4ub3B0aW9ucyB9KTtcbiAgaWYgKHJlc3VsdC5lcnJvciB8fCByZXN1bHQuc3RhdHVzICE9PSAwKVxuICAgIHRocm93IG5ldyBFcnJvcihgJHtjb21tYW5kfSBmYWlsZWQ6ICR7U3RyaW5nKHJlc3VsdC5lcnJvciA/PyAocmVzdWx0LnN0ZGVyciB8fCByZXN1bHQuc3RhdHVzKSl9YCk7XG4gIHJldHVybiByZXN1bHQuc3Rkb3V0LnRyaW0oKTtcbn1cbmZ1bmN0aW9uIGNvbnRhaW5lcihhcmdzOiBzdHJpbmdbXSwgb3B0aW9uczogT21pdDxTcGF3blN5bmNPcHRpb25zV2l0aFN0cmluZ0VuY29kaW5nLCBcImVuY29kaW5nXCI+ID0ge30pIHtcbiAgcmV0dXJuIGV4ZWN1dGUoZG9ja2VyLCBhcmdzLCBvcHRpb25zKTtcbn1cbmNvbnN0IG5hbWUgPSBgd29ya2JlbmNoLXJlbGVhc2UtJHtyYW5kb21VVUlEKCl9YDtcbmNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid29ya2JlbmNoLW1hbmFnZWQtdmVyaWZ5LVwiKSk7XG5sZXQgY3JlYXRlZCA9IGZhbHNlO1xudHJ5IHtcbiAgY29udGFpbmVyKFtcInB1bGxcIiwgYmFzZV0pO1xuICBjb250YWluZXIoW1xuICAgIFwiY3JlYXRlXCIsXG4gICAgXCItLW5hbWVcIixcbiAgICBuYW1lLFxuICAgIFwiLS1uZXR3b3JrPW5vbmVcIixcbiAgICBcIi0tbW91bnRcIixcbiAgICBgdHlwZT1iaW5kLHNyYz0ke2RpcmVjdG9yeX0sZHN0PS9hcnRpZmFjdHMscmVhZG9ubHlgLFxuICAgIGJhc2UsXG4gICAgXCJzbGVlcFwiLFxuICAgIFwiaW5maW5pdHlcIixcbiAgXSk7XG4gIGNyZWF0ZWQgPSB0cnVlO1xuICBjb250YWluZXIoW1wic3RhcnRcIiwgbmFtZV0pO1xuICBjb25zdCBiaW4gPSBtZXRhZGF0YS5idWlsZGVyID09PSBcIm5peFwiID8gYCR7cGFja2FnZVBhdGh9L2JpbmAgOiBcIi90bXAvcGFja2FnZS9iaW5cIjtcbiAgbGV0IHJ1bnRpbWUgPSBiaW47XG4gIGlmIChtZXRhZGF0YS5idWlsZGVyID09PSBcIm5peFwiKSB7XG4gICAgY29uc3QgaW5wdXQgPSBvcGVuU3luYyhqb2luKGRpcmVjdG9yeSwgXCJjbG9zdXJlLm5hclwiKSwgXCJyXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb250YWluZXIoW1wiZXhlY1wiLCBcIi1pXCIsIG5hbWUsIFwibml4LXN0b3JlXCIsIFwiLS1pbXBvcnRcIl0sIHsgc3RkaW86IFtpbnB1dCwgXCJwaXBlXCIsIFwicGlwZVwiXSB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VTeW5jKGlucHV0KTtcbiAgICB9XG4gICAgY29udGFpbmVyKFtcImV4ZWNcIiwgbmFtZSwgXCJ0ZXN0XCIsIFwiLWRcIiwgcGFja2FnZVBhdGhdKTtcbiAgICBpZiAoZXhlY3V0YWJsZVJ1bnRpbWUpIHtcbiAgICAgIGNvbnN0IHByb3BhZ2F0ZWQgPSBjb250YWluZXIoW1wiZXhlY1wiLCBuYW1lLCBcImNhdFwiLCBgJHtwYWNrYWdlUGF0aH0vbml4LXN1cHBvcnQvcHJvcGFnYXRlZC1idWlsZC1pbnB1dHNgXSkuc3BsaXQoXG4gICAgICAgIC9cXHMrLyxcbiAgICAgICk7XG4gICAgICBjb25zdCBjYW5kaWRhdGVzID0gcHJvcGFnYXRlZC5maWx0ZXIoXG4gICAgICAgIChwYXRoKSA9PiBzcGF3blN5bmMoZG9ja2VyLCBbXCJleGVjXCIsIG5hbWUsIFwidGVzdFwiLCBcIi14XCIsIGAke3BhdGh9L2Jpbi8ke2V4ZWN1dGFibGVSdW50aW1lfWBdKS5zdGF0dXMgPT09IDAsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhbmRpZGF0ZXMubGVuZ3RoLCAxLCBcIkV4cGVjdGVkIG9uZSBzZWxlY3RlZCBydW50aW1lIGluIHRoZSByZWxlYXNlIGNsb3N1cmVcIik7XG4gICAgICBydW50aW1lID0gYCR7U3RyaW5nKGNhbmRpZGF0ZXNbMF0pfS9iaW5gO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb250YWluZXIoW1xuICAgICAgXCJleGVjXCIsXG4gICAgICBuYW1lLFxuICAgICAgXCJzaFwiLFxuICAgICAgXCItZXVcIixcbiAgICAgIFwiLWNcIixcbiAgICAgIFwibWtkaXIgL3RtcC9wYWNrYWdlOyB0YXIgLXh6ZiAvYXJ0aWZhY3RzL3BhY2thZ2UudGFyLmd6IC1DIC90bXAvcGFja2FnZVwiLFxuICAgIF0pO1xuICB9XG4gIGlmIChjaGVja01ldGFkYXRhLnNpdGUpIHtcbiAgICBpZiAoY2hlY2tNZXRhZGF0YS5zaXRlICE9PSBcInNoYXJlL3NpdGVcIikgdGhyb3cgbmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgc3RhdGljLXNpdGUgb3V0cHV0IHBhdGhcIik7XG4gICAgY29uc3QgcGF0aCA9IGAke21ldGFkYXRhLmJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gXCIvdG1wL3BhY2thZ2VcIiA6IFwiXCJ9JHtwYWNrYWdlUGF0aH0vJHtjaGVja01ldGFkYXRhLnNpdGV9YDtcbiAgICBjb25zdCBzaXRlID0gam9pbih0ZW1wb3JhcnksIFwic2l0ZVwiKTtcbiAgICBjb250YWluZXIoW1xuICAgICAgXCJleGVjXCIsXG4gICAgICBuYW1lLFxuICAgICAgXCJzaFwiLFxuICAgICAgXCItZXVcIixcbiAgICAgIFwiLWNcIixcbiAgICAgICdta2RpciAvdG1wL3ZlcmlmaWVkLXNpdGU7IGNwIC1yIFwiJDFcIi8uIC90bXAvdmVyaWZpZWQtc2l0ZS87IGNobW9kIC1SIHUrcndYIC90bXAvdmVyaWZpZWQtc2l0ZScsXG4gICAgICBcInZlcmlmeS1zaXRlXCIsXG4gICAgICBwYXRoLFxuICAgIF0pO1xuICAgIGNvbnRhaW5lcihbXCJjcFwiLCBgJHtuYW1lfTovdG1wL3ZlcmlmaWVkLXNpdGVgLCBzaXRlXSk7XG4gICAgZXhlY3V0ZShwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihzb3VyY2VSb290LCBcInNjcmlwdHMvY2hlY2stc2l0ZS5tanNcIiksIHNpdGVdLCB7IGN3ZDogdGVtcG9yYXJ5IH0pO1xuICB9IGVsc2Uge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShjaGVja01ldGFkYXRhLmNvbW1hbmRzKSB8fCAhY2hlY2tNZXRhZGF0YS5jb21tYW5kcy5sZW5ndGgpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSZWxlYXNlIHZlcmlmaWNhdGlvbiBtdXN0IGNvbnRhaW4gYmVoYXZpb3JhbCBjb21tYW5kc1wiKTtcbiAgICBmb3IgKGNvbnN0IHZhbHVlIG9mIGNoZWNrTWV0YWRhdGEuY29tbWFuZHMpIHtcbiAgICAgIGNvbnN0IGNoZWNrID0gcmVjb3JkKHZhbHVlLCBcIkludmFsaWQgcmVsZWFzZSBjb21tYW5kXCIpO1xuICAgICAgaWYgKCFpc1N0cmluZ0FycmF5KGNoZWNrLmFyZ3YpIHx8ICFjaGVjay5hcmd2Lmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCByZWxlYXNlIHZlcmlmaWNhdGlvbiBhcmd1bWVudHNcIik7XG4gICAgICBjb25zdCBhcmdzID0gY2hlY2suYXJndi5tYXAoKHZhbHVlOiBzdHJpbmcpID0+XG4gICAgICAgIHZhbHVlLnJlcGxhY2UoL1xceyhwYWNrYWdlfGJpbnxydW50aW1lKVxcfS9nLCAoXywga2V5OiBzdHJpbmcpID0+XG4gICAgICAgICAga2V5ID09PSBcInBhY2thZ2VcIiA/IHBhY2thZ2VQYXRoIDoga2V5ID09PSBcImJpblwiID8gYmluIDogcnVudGltZSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoXG4gICAgICAgIGRvY2tlcixcbiAgICAgICAgW1wiZXhlY1wiLCBcIi0td29ya2RpclwiLCBcIi90bXBcIiwgXCItLWVudlwiLCBcIkdVSVhfRVhFQ1VUSU9OX0VOR0lORT1wcm9vdFwiLCBuYW1lLCAuLi5hcmdzXSxcbiAgICAgICAgeyBlbmNvZGluZzogXCJ1dGY4XCIgfSxcbiAgICAgICk7XG4gICAgICBpZiAocmVzdWx0LmVycm9yKSB0aHJvdyByZXN1bHQuZXJyb3I7XG4gICAgICBhc3NlcnQub2soTnVtYmVyLmlzSW50ZWdlcihyZXN1bHQuc3RhdHVzKSwgYFJlbGVhc2UgY29tbWFuZCBkaWQgbm90IGNvbXBsZXRlOiAke1N0cmluZyhyZXN1bHQuc2lnbmFsKX1gKTtcbiAgICAgIGlmIChjaGVjay5zdGF0dXMgPT09IFwibm9uemVyb1wiKSBhc3NlcnQubm90RXF1YWwocmVzdWx0LnN0YXR1cywgMCwgcmVzdWx0LnN0ZG91dCk7XG4gICAgICBlbHNlIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBjaGVjay5zdGF0dXMgPz8gMCwgcmVzdWx0LnN0ZGVyciB8fCByZXN1bHQuc3Rkb3V0IHx8IEpTT04uc3RyaW5naWZ5KGFyZ3MpKTtcbiAgICAgIGlmIChjaGVjay5zdGRvdXQgIT09IHVuZGVmaW5lZCkgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGRvdXQsIGNoZWNrLnN0ZG91dCk7XG4gICAgfVxuICB9XG4gIGNvbnNvbGUubG9nKGBWZXJpZmllZCAke1N0cmluZyhtZXRhZGF0YS5idWlsZGVyKX0gcmVsZWFzZSBvZmZsaW5lIG91dHNpZGUgdGhlIGNoZWNrb3V0IGFuZCBob3N0IHN0b3Jlcy5gKTtcbn0gZmluYWxseSB7XG4gIGlmIChjcmVhdGVkKSBjb250YWluZXIoW1wicm1cIiwgXCItLWZvcmNlXCIsIG5hbWVdKTtcbiAgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxRQUFRLFVBQVUsUUFBUSxxQkFBcUI7QUFFeEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsVUFBVSxXQUFXLGNBQWMsYUFBYSxjQUFjO0FBQ3ZFLFNBQVMsY0FBYztBQUN2QixTQUFTLE1BQU0sZUFBZTtBQUU5QixNQUFNLENBQUMsVUFBVSxRQUFRLFVBQVUsT0FBTyxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDbEUsTUFBTSxZQUFZLFFBQVEsU0FBUyxVQUFVLDBCQUEwQixDQUFDO0FBQ3hFLE1BQU0sYUFBYSxRQUFRLFNBQVMsUUFBUSx3QkFBd0IsQ0FBQztBQUNyRSxNQUFNLFdBQVc7QUFBQSxFQUNmLEtBQUssTUFBTSxhQUFhLEtBQUssV0FBVyxzQkFBc0IsR0FBRyxNQUFNLENBQUM7QUFBQSxFQUN4RTtBQUNGO0FBQ0EsTUFBTSxnQkFBZ0IsT0FBTyxTQUFTLE9BQU8sZ0NBQWdDO0FBQzdF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
