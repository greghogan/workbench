// Generated from release-rust.mts; edit the TypeScript source.
import { readAcquiredCIImage } from "../app/src/core/execution/ci/support/ci-image-contract.mjs";
import { capturedText, record, string, isRecord, isStringArray } from "../app/src/core/runtime/values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "../app/src/core/runtime/owned-child.mjs";
import { processFailure } from "../app/src/core/runtime/process-outcome.mjs";
import { settleCleanup } from "../app/src/core/diagnostics/diagnostic-errors.mjs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cpuBudget } from "../app/src/core/execution/checks/cpu-budget.mjs";
const { values } = parseArgs({ options: { target: { type: "string" }, "image-profile": { type: "string" } } });
const root = process.cwd();
const output = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist");
const env = {
  ...process.env,
  CARGO_BUILD_JOBS: String(cpuBudget()),
  RUST_TEST_THREADS: String(cpuBudget())
};
const cancellation = processCancellation();
async function run(command, args, capture = false) {
  const options = { cwd: root, env, signal: cancellation.signal };
  if (capture) {
    const result2 = await captureOwnedChild(command, args, options, 16 * 1024 * 1024);
    if (result2.stderr) process.stderr.write(result2.stderr);
    const failure3 = processFailure(`Rust release: ${command} ${args[0] ?? ""}`, result2, result2);
    if (failure3) throw failure3;
    return capturedText(result2.stdout);
  }
  const result = await runOwnedChild(command, args, options);
  const failure2 = processFailure(`Rust release: ${command} ${args[0] ?? ""}`, result);
  if (failure2) throw failure2;
  return "";
}
let imageDirectory;
let failure;
try {
  const compiler = await run("rustc", ["-vV"], true);
  const host = /^host: (.+)$/m.exec(compiler)?.[1];
  const compilerVersion = /^rustc (\d+\.\d+\.\d+)\b/.exec(compiler)?.[1];
  if (!host || !compilerVersion) throw new Error("Rust release: rustc did not report its version and host target");
  const target = values.target ?? host;
  const toolchain = `+${compilerVersion}`;
  let recipe;
  if (values.target) {
    const value = record(JSON.parse(readFileSync(join(root, "release-musl.json"), "utf8")), "Invalid musl recipe");
    recipe = {
      targets: Object.fromEntries(
        Object.entries(record(value.targets, "Missing musl targets")).map(([key, target2]) => [
          key,
          record(target2, "Invalid musl target")
        ])
      ),
      cross_version: string(value.cross_version, "Missing cross version"),
      cross_revision: string(value.cross_revision, "Missing cross revision")
    };
    const selected = recipe.targets[target];
    if (selected?.platform !== `${process.platform}-${process.arch}`)
      throw new Error(`Rust release: ${target} requires its native Linux architecture builder; no emulation`);
    if (process.env.WORKBENCH_SHELL_ENVIRONMENT && process.env.WORKBENCH_SHELL_ENVIRONMENT !== "native")
      throw new Error(
        "Rust release: musl profiles require the native builder; managed releases retain their own tool authority"
      );
    const buildOptions = env.CROSS_BUILD_OPTS;
    for (const name of Object.keys(env))
      if (/^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.*_(?:LINKER|RUNNER|RUSTFLAGS)|CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS|CROSS_.*)$/.test(
        name
      ))
        Reflect.deleteProperty(env, name);
    if (buildOptions) env.CROSS_BUILD_OPTS = buildOptions;
    env.CROSS_CONTAINER_ENGINE = "docker";
    env.RUSTFLAGS = `-Ctarget-cpu=${process.arch === "x64" ? "x86-64" : "generic"} -Ctarget-feature=+crt-static`;
    const enginePlatform = (await run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], true)).trim();
    if (enginePlatform !== `linux/${process.arch === "x64" ? "amd64" : "arm64"}`)
      throw new Error(`Rust release: Docker engine ${enginePlatform} requires emulation`);
    const reported = /^cross (\S+)(?: \(([0-9a-f]{7,40}) [^)]+\))?/m.exec(
      await run("cross", [toolchain, "--version"], true)
    );
    const version = reported?.[1];
    if (version !== recipe.cross_version)
      throw new Error(`Rust release: expected cross ${recipe.cross_version}, found ${version ?? "unknown"}`);
    if (!reported?.[2] || !recipe.cross_revision.startsWith(reported[2]))
      throw new Error(
        `Rust release: expected cross revision ${recipe.cross_revision}, found ${reported?.[2] ?? "unknown"}`
      );
    if (values["image-profile"]) {
      mkdirSync(dirname(output), { recursive: true });
      imageDirectory = mkdtempSync(join(dirname(output), ".musl-image-"));
      const metadata = join(imageDirectory, "image.json");
      await run(process.execPath, [
        resolve(import.meta.dirname, "../bin/workbench.mjs"),
        "ci-image-acquire",
        values["image-profile"],
        "--output",
        metadata
      ]);
      const image = readAcquiredCIImage(JSON.parse(readFileSync(metadata, "utf8")));
      if (image.platform !== `linux-${process.arch}` || image.profile !== values["image-profile"])
        throw new Error("Rust release: prepared image belongs to another platform or profile");
      await run("docker", ["run", "--rm", "--network=none", image.published, "musl-gcc", "--version"]);
      const configuration = join(imageDirectory, "Cross.toml");
      writeFileSync(
        configuration,
        `[build.env]
passthrough = ["CARGO_BUILD_JOBS", "RUST_TEST_THREADS"]
[target.${target}]
runner = "native"
image.name = ${JSON.stringify(image.published)}
image.toolchain = [${JSON.stringify(host)}]
`
      );
      env.CROSS_CONFIG = configuration;
    }
  }
  delete env.CARGO_BUILD_TARGET;
  const runner = values.target ? "cross" : "cargo";
  const prefix = values.target ? [toolchain] : [];
  const build = resolve(process.env.CARGO_TARGET_DIR ?? join(process.env.WORKBENCH_BUILD_DIR ?? root, "target"));
  const selection = ["--release", "--locked", "--target", target, "--target-dir", build];
  await run(runner, [...prefix, "test", "--workspace", "--all-targets", "--no-fail-fast", ...selection]);
  await run(runner, [...prefix, "test", "--workspace", "--doc", ...selection]);
  const messages = await run(
    runner,
    [...prefix, "build", "--workspace", "--bins", "--message-format=json-render-diagnostics", ...selection],
    true
  );
  const binaries = /* @__PURE__ */ new Set();
  for (const line of messages.split("\n").filter(Boolean)) {
    if (!line.startsWith("{")) {
      console.log(line);
      continue;
    }
    const event = record(JSON.parse(line), "Invalid Rust build event");
    if (event.reason === "compiler-message" && isRecord(event.message) && typeof event.message.rendered === "string")
      process.stderr.write(event.message.rendered);
    if (event.reason === "compiler-artifact" && isRecord(event.target) && isStringArray(event.target.kind) && event.target.kind.includes("bin") && typeof event.executable === "string")
      binaries.add(basename(event.executable));
  }
  if (!binaries.size) throw new Error("Rust release: no executable artifacts were produced");
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".rust-release-"));
  try {
    for (const name of binaries) copyFileSync(join(build, target, "release", name), join(staging, name));
    if (existsSync(join(root, "LICENSE"))) copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));
    writeFileSync(
      join(staging, "rust-release.json"),
      JSON.stringify(
        {
          target,
          binaries: [...binaries].sort(),
          ...recipe ? { ...recipe.targets[target], cross_version: recipe.cross_version, cross_revision: recipe.cross_revision } : {}
        },
        null,
        2
      ) + "\n"
    );
    await run(process.execPath, [join(root, "scripts/release-verify.mjs"), staging, root]);
    mkdirSync(output, { recursive: true });
    for (const name of readdirSync(staging)) renameSync(join(staging, name), join(output, name));
    console.log(`Prepared verified Rust release (${target}): ${output}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
} catch (error) {
  failure = error;
  throw error;
} finally {
  await settleCleanup(
    [
      () => {
        if (imageDirectory) rmSync(imageDirectory, { recursive: true, force: true });
      },
      () => {
        cancellation.close();
      }
    ],
    failure
  );
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJlbGVhc2UtcnVzdC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEFjcXVpcmVkQ0lJbWFnZSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2NpL3N1cHBvcnQvY2ktaW1hZ2UtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyBjYXB0dXJlZFRleHQsIHJlY29yZCwgc3RyaW5nLCBpc1JlY29yZCwgaXNTdHJpbmdBcnJheSB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5cbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIGNhcHR1cmVPd25lZENoaWxkLCBwcm9jZXNzQ2FuY2VsbGF0aW9uIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL293bmVkLWNoaWxkLm1qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0ZhaWx1cmUgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvcHJvY2Vzcy1vdXRjb21lLm1qc1wiO1xuaW1wb3J0IHsgc2V0dGxlQ2xlYW51cCB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZGlhZ25vc3RpY3MvZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5pbXBvcnQge1xuICBjb3B5RmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgbWtkdGVtcFN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlbmFtZVN5bmMsXG4gIHJtU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgY3B1QnVkZ2V0IH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vY2hlY2tzL2NwdS1idWRnZXQubWpzXCI7XG5cbmNvbnN0IHsgdmFsdWVzIH0gPSBwYXJzZUFyZ3MoeyBvcHRpb25zOiB7IHRhcmdldDogeyB0eXBlOiBcInN0cmluZ1wiIH0sIFwiaW1hZ2UtcHJvZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSB9IH0pO1xuY29uc3Qgcm9vdCA9IHByb2Nlc3MuY3dkKCk7XG5jb25zdCBvdXRwdXQgPSByZXNvbHZlKHByb2Nlc3MuZW52LldPUktCRU5DSF9SRUxFQVNFX09VVFBVVCA/PyBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfRElTVF9ESVIgPz8gXCJkaXN0XCIpO1xuY29uc3QgZW52OiBOb2RlSlMuUHJvY2Vzc0VudiA9IHtcbiAgLi4ucHJvY2Vzcy5lbnYsXG4gIENBUkdPX0JVSUxEX0pPQlM6IFN0cmluZyhjcHVCdWRnZXQoKSksXG4gIFJVU1RfVEVTVF9USFJFQURTOiBTdHJpbmcoY3B1QnVkZ2V0KCkpLFxufTtcbmNvbnN0IGNhbmNlbGxhdGlvbiA9IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbmFzeW5jIGZ1bmN0aW9uIHJ1bihjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBjYXB0dXJlID0gZmFsc2UpIHtcbiAgY29uc3Qgb3B0aW9ucyA9IHsgY3dkOiByb290LCBlbnYsIHNpZ25hbDogY2FuY2VsbGF0aW9uLnNpZ25hbCB9O1xuICBpZiAoY2FwdHVyZSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhcHR1cmVPd25lZENoaWxkKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMsIDE2ICogMTAyNCAqIDEwMjQpO1xuICAgIGlmIChyZXN1bHQuc3RkZXJyKSBwcm9jZXNzLnN0ZGVyci53cml0ZShyZXN1bHQuc3RkZXJyKTtcbiAgICBjb25zdCBmYWlsdXJlID0gcHJvY2Vzc0ZhaWx1cmUoYFJ1c3QgcmVsZWFzZTogJHtjb21tYW5kfSAke2FyZ3NbMF0gPz8gXCJcIn1gLCByZXN1bHQsIHJlc3VsdCk7XG4gICAgaWYgKGZhaWx1cmUpIHRocm93IGZhaWx1cmU7XG4gICAgcmV0dXJuIGNhcHR1cmVkVGV4dChyZXN1bHQuc3Rkb3V0KTtcbiAgfVxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5Pd25lZENoaWxkKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpO1xuICBjb25zdCBmYWlsdXJlID0gcHJvY2Vzc0ZhaWx1cmUoYFJ1c3QgcmVsZWFzZTogJHtjb21tYW5kfSAke2FyZ3NbMF0gPz8gXCJcIn1gLCByZXN1bHQpO1xuICBpZiAoZmFpbHVyZSkgdGhyb3cgZmFpbHVyZTtcbiAgcmV0dXJuIFwiXCI7XG59XG5cbmxldCBpbWFnZURpcmVjdG9yeTogc3RyaW5nIHwgdW5kZWZpbmVkO1xubGV0IGZhaWx1cmU6IHVua25vd247XG50cnkge1xuICBjb25zdCBjb21waWxlciA9IGF3YWl0IHJ1bihcInJ1c3RjXCIsIFtcIi12VlwiXSwgdHJ1ZSk7XG4gIGNvbnN0IGhvc3QgPSAvXmhvc3Q6ICguKykkL20uZXhlYyhjb21waWxlcik/LlsxXTtcbiAgY29uc3QgY29tcGlsZXJWZXJzaW9uID0gL15ydXN0YyAoXFxkK1xcLlxcZCtcXC5cXGQrKVxcYi8uZXhlYyhjb21waWxlcik/LlsxXTtcbiAgaWYgKCFob3N0IHx8ICFjb21waWxlclZlcnNpb24pIHRocm93IG5ldyBFcnJvcihcIlJ1c3QgcmVsZWFzZTogcnVzdGMgZGlkIG5vdCByZXBvcnQgaXRzIHZlcnNpb24gYW5kIGhvc3QgdGFyZ2V0XCIpO1xuICBjb25zdCB0YXJnZXQgPSB2YWx1ZXMudGFyZ2V0ID8/IGhvc3Q7XG4gIGNvbnN0IHRvb2xjaGFpbiA9IGArJHtjb21waWxlclZlcnNpb259YDtcbiAgbGV0IHJlY2lwZTpcbiAgICB7IHRhcmdldHM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PjsgY3Jvc3NfdmVyc2lvbjogc3RyaW5nOyBjcm9zc19yZXZpc2lvbjogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gIGlmICh2YWx1ZXMudGFyZ2V0KSB7XG4gICAgY29uc3QgdmFsdWUgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInJlbGVhc2UtbXVzbC5qc29uXCIpLCBcInV0ZjhcIikpLCBcIkludmFsaWQgbXVzbCByZWNpcGVcIik7XG4gICAgcmVjaXBlID0ge1xuICAgICAgdGFyZ2V0czogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICBPYmplY3QuZW50cmllcyhyZWNvcmQodmFsdWUudGFyZ2V0cywgXCJNaXNzaW5nIG11c2wgdGFyZ2V0c1wiKSkubWFwKChba2V5LCB0YXJnZXRdKSA9PiBbXG4gICAgICAgICAga2V5LFxuICAgICAgICAgIHJlY29yZCh0YXJnZXQsIFwiSW52YWxpZCBtdXNsIHRhcmdldFwiKSxcbiAgICAgICAgXSksXG4gICAgICApLFxuICAgICAgY3Jvc3NfdmVyc2lvbjogc3RyaW5nKHZhbHVlLmNyb3NzX3ZlcnNpb24sIFwiTWlzc2luZyBjcm9zcyB2ZXJzaW9uXCIpLFxuICAgICAgY3Jvc3NfcmV2aXNpb246IHN0cmluZyh2YWx1ZS5jcm9zc19yZXZpc2lvbiwgXCJNaXNzaW5nIGNyb3NzIHJldmlzaW9uXCIpLFxuICAgIH07XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZWNpcGUudGFyZ2V0c1t0YXJnZXRdO1xuICAgIGlmIChzZWxlY3RlZD8ucGxhdGZvcm0gIT09IGAke3Byb2Nlc3MucGxhdGZvcm19LSR7cHJvY2Vzcy5hcmNofWApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFJ1c3QgcmVsZWFzZTogJHt0YXJnZXR9IHJlcXVpcmVzIGl0cyBuYXRpdmUgTGludXggYXJjaGl0ZWN0dXJlIGJ1aWxkZXI7IG5vIGVtdWxhdGlvbmApO1xuICAgIGlmIChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfU0hFTExfRU5WSVJPTk1FTlQgJiYgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1NIRUxMX0VOVklST05NRU5UICE9PSBcIm5hdGl2ZVwiKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIlJ1c3QgcmVsZWFzZTogbXVzbCBwcm9maWxlcyByZXF1aXJlIHRoZSBuYXRpdmUgYnVpbGRlcjsgbWFuYWdlZCByZWxlYXNlcyByZXRhaW4gdGhlaXIgb3duIHRvb2wgYXV0aG9yaXR5XCIsXG4gICAgICApO1xuICAgIC8vIFBvcnRhYmxlIHJlY2lwZXMgbXVzdCBub3QgaW5oZXJpdCBob3N0LXNwZWNpZmljIG9wdGltaXphdGlvbiBvciBsaW5rZXIgc2V0dGluZ3MuXG4gICAgY29uc3QgYnVpbGRPcHRpb25zID0gZW52LkNST1NTX0JVSUxEX09QVFM7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKGVudikpXG4gICAgICBpZiAoXG4gICAgICAgIC9eKD86UlVTVEZMQUdTfENBUkdPX0VOQ09ERURfUlVTVEZMQUdTfENBUkdPX0JVSUxEX1JVU1RGTEFHU3xDQVJHT19UQVJHRVRfLipfKD86TElOS0VSfFJVTk5FUnxSVVNURkxBR1MpfENDfENYWHxBUnxDRkxBR1N8Q1hYRkxBR1N8TERGTEFHU3xDUk9TU18uKikkLy50ZXN0KFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgICAgUmVmbGVjdC5kZWxldGVQcm9wZXJ0eShlbnYsIG5hbWUpO1xuICAgIC8vIEtlZXAgY3Jvc3MncyBleHBsaWNpdCBEb2NrZXIgYnVpbGQgdHJhbnNwb3J0IG9wdGlvbnMgKGZvciBleGFtcGxlIGxvY2FsIGhvc3QgbmV0d29ya2luZykuXG4gICAgaWYgKGJ1aWxkT3B0aW9ucykgZW52LkNST1NTX0JVSUxEX09QVFMgPSBidWlsZE9wdGlvbnM7XG4gICAgZW52LkNST1NTX0NPTlRBSU5FUl9FTkdJTkUgPSBcImRvY2tlclwiO1xuICAgIGVudi5SVVNURkxBR1MgPSBgLUN0YXJnZXQtY3B1PSR7cHJvY2Vzcy5hcmNoID09PSBcIng2NFwiID8gXCJ4ODYtNjRcIiA6IFwiZ2VuZXJpY1wifSAtQ3RhcmdldC1mZWF0dXJlPStjcnQtc3RhdGljYDtcbiAgICBjb25zdCBlbmdpbmVQbGF0Zm9ybSA9IChcbiAgICAgIGF3YWl0IHJ1bihcImRvY2tlclwiLCBbXCJ2ZXJzaW9uXCIsIFwiLS1mb3JtYXRcIiwgXCJ7ey5TZXJ2ZXIuT3N9fS97ey5TZXJ2ZXIuQXJjaH19XCJdLCB0cnVlKVxuICAgICkudHJpbSgpO1xuICAgIGlmIChlbmdpbmVQbGF0Zm9ybSAhPT0gYGxpbnV4LyR7cHJvY2Vzcy5hcmNoID09PSBcIng2NFwiID8gXCJhbWQ2NFwiIDogXCJhcm02NFwifWApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFJ1c3QgcmVsZWFzZTogRG9ja2VyIGVuZ2luZSAke2VuZ2luZVBsYXRmb3JtfSByZXF1aXJlcyBlbXVsYXRpb25gKTtcbiAgICBjb25zdCByZXBvcnRlZCA9IC9eY3Jvc3MgKFxcUyspKD86IFxcKChbMC05YS1mXXs3LDQwfSkgW14pXStcXCkpPy9tLmV4ZWMoXG4gICAgICBhd2FpdCBydW4oXCJjcm9zc1wiLCBbdG9vbGNoYWluLCBcIi0tdmVyc2lvblwiXSwgdHJ1ZSksXG4gICAgKTtcbiAgICBjb25zdCB2ZXJzaW9uID0gcmVwb3J0ZWQ/LlsxXTtcbiAgICBpZiAodmVyc2lvbiAhPT0gcmVjaXBlLmNyb3NzX3ZlcnNpb24pXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFJ1c3QgcmVsZWFzZTogZXhwZWN0ZWQgY3Jvc3MgJHtyZWNpcGUuY3Jvc3NfdmVyc2lvbn0sIGZvdW5kICR7dmVyc2lvbiA/PyBcInVua25vd25cIn1gKTtcbiAgICBpZiAoIXJlcG9ydGVkPy5bMl0gfHwgIXJlY2lwZS5jcm9zc19yZXZpc2lvbi5zdGFydHNXaXRoKHJlcG9ydGVkWzJdKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFJ1c3QgcmVsZWFzZTogZXhwZWN0ZWQgY3Jvc3MgcmV2aXNpb24gJHtyZWNpcGUuY3Jvc3NfcmV2aXNpb259LCBmb3VuZCAke3JlcG9ydGVkPy5bMl0gPz8gXCJ1bmtub3duXCJ9YCxcbiAgICAgICk7XG4gICAgaWYgKHZhbHVlc1tcImltYWdlLXByb2ZpbGVcIl0pIHtcbiAgICAgIG1rZGlyU3luYyhkaXJuYW1lKG91dHB1dCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgaW1hZ2VEaXJlY3RvcnkgPSBta2R0ZW1wU3luYyhqb2luKGRpcm5hbWUob3V0cHV0KSwgXCIubXVzbC1pbWFnZS1cIikpO1xuICAgICAgY29uc3QgbWV0YWRhdGEgPSBqb2luKGltYWdlRGlyZWN0b3J5LCBcImltYWdlLmpzb25cIik7XG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICByZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi4vYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwiY2ktaW1hZ2UtYWNxdWlyZVwiLFxuICAgICAgICB2YWx1ZXNbXCJpbWFnZS1wcm9maWxlXCJdLFxuICAgICAgICBcIi0tb3V0cHV0XCIsXG4gICAgICAgIG1ldGFkYXRhLFxuICAgICAgXSk7XG4gICAgICBjb25zdCBpbWFnZSA9IHJlYWRBY3F1aXJlZENJSW1hZ2UoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobWV0YWRhdGEsIFwidXRmOFwiKSkpO1xuICAgICAgaWYgKGltYWdlLnBsYXRmb3JtICE9PSBgbGludXgtJHtwcm9jZXNzLmFyY2h9YCB8fCBpbWFnZS5wcm9maWxlICE9PSB2YWx1ZXNbXCJpbWFnZS1wcm9maWxlXCJdKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSdXN0IHJlbGVhc2U6IHByZXBhcmVkIGltYWdlIGJlbG9uZ3MgdG8gYW5vdGhlciBwbGF0Zm9ybSBvciBwcm9maWxlXCIpO1xuICAgICAgYXdhaXQgcnVuKFwiZG9ja2VyXCIsIFtcInJ1blwiLCBcIi0tcm1cIiwgXCItLW5ldHdvcms9bm9uZVwiLCBpbWFnZS5wdWJsaXNoZWQsIFwibXVzbC1nY2NcIiwgXCItLXZlcnNpb25cIl0pO1xuICAgICAgY29uc3QgY29uZmlndXJhdGlvbiA9IGpvaW4oaW1hZ2VEaXJlY3RvcnksIFwiQ3Jvc3MudG9tbFwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGNvbmZpZ3VyYXRpb24sXG4gICAgICAgIGBbYnVpbGQuZW52XVxcbnBhc3N0aHJvdWdoID0gW1wiQ0FSR09fQlVJTERfSk9CU1wiLCBcIlJVU1RfVEVTVF9USFJFQURTXCJdXFxuYCArXG4gICAgICAgICAgYFt0YXJnZXQuJHt0YXJnZXR9XVxcbnJ1bm5lciA9IFwibmF0aXZlXCJcXG5pbWFnZS5uYW1lID0gJHtKU09OLnN0cmluZ2lmeShpbWFnZS5wdWJsaXNoZWQpfVxcbmAgK1xuICAgICAgICAgIGBpbWFnZS50b29sY2hhaW4gPSBbJHtKU09OLnN0cmluZ2lmeShob3N0KX1dXFxuYCxcbiAgICAgICk7XG4gICAgICBlbnYuQ1JPU1NfQ09ORklHID0gY29uZmlndXJhdGlvbjtcbiAgICB9XG4gIH1cbiAgZGVsZXRlIGVudi5DQVJHT19CVUlMRF9UQVJHRVQ7XG4gIGNvbnN0IHJ1bm5lciA9IHZhbHVlcy50YXJnZXQgPyBcImNyb3NzXCIgOiBcImNhcmdvXCI7XG4gIGNvbnN0IHByZWZpeCA9IHZhbHVlcy50YXJnZXQgPyBbdG9vbGNoYWluXSA6IFtdO1xuICBjb25zdCBidWlsZCA9IHJlc29sdmUocHJvY2Vzcy5lbnYuQ0FSR09fVEFSR0VUX0RJUiA/PyBqb2luKHByb2Nlc3MuZW52LldPUktCRU5DSF9CVUlMRF9ESVIgPz8gcm9vdCwgXCJ0YXJnZXRcIikpO1xuICBjb25zdCBzZWxlY3Rpb24gPSBbXCItLXJlbGVhc2VcIiwgXCItLWxvY2tlZFwiLCBcIi0tdGFyZ2V0XCIsIHRhcmdldCwgXCItLXRhcmdldC1kaXJcIiwgYnVpbGRdO1xuICBhd2FpdCBydW4ocnVubmVyLCBbLi4ucHJlZml4LCBcInRlc3RcIiwgXCItLXdvcmtzcGFjZVwiLCBcIi0tYWxsLXRhcmdldHNcIiwgXCItLW5vLWZhaWwtZmFzdFwiLCAuLi5zZWxlY3Rpb25dKTtcbiAgYXdhaXQgcnVuKHJ1bm5lciwgWy4uLnByZWZpeCwgXCJ0ZXN0XCIsIFwiLS13b3Jrc3BhY2VcIiwgXCItLWRvY1wiLCAuLi5zZWxlY3Rpb25dKTtcbiAgY29uc3QgbWVzc2FnZXMgPSBhd2FpdCBydW4oXG4gICAgcnVubmVyLFxuICAgIFsuLi5wcmVmaXgsIFwiYnVpbGRcIiwgXCItLXdvcmtzcGFjZVwiLCBcIi0tYmluc1wiLCBcIi0tbWVzc2FnZS1mb3JtYXQ9anNvbi1yZW5kZXItZGlhZ25vc3RpY3NcIiwgLi4uc2VsZWN0aW9uXSxcbiAgICB0cnVlLFxuICApO1xuICBjb25zdCBiaW5hcmllcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgbWVzc2FnZXMuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pKSB7XG4gICAgaWYgKCFsaW5lLnN0YXJ0c1dpdGgoXCJ7XCIpKSB7XG4gICAgICBjb25zb2xlLmxvZyhsaW5lKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBldmVudCA9IHJlY29yZChKU09OLnBhcnNlKGxpbmUpLCBcIkludmFsaWQgUnVzdCBidWlsZCBldmVudFwiKTtcbiAgICBpZiAoZXZlbnQucmVhc29uID09PSBcImNvbXBpbGVyLW1lc3NhZ2VcIiAmJiBpc1JlY29yZChldmVudC5tZXNzYWdlKSAmJiB0eXBlb2YgZXZlbnQubWVzc2FnZS5yZW5kZXJlZCA9PT0gXCJzdHJpbmdcIilcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGV2ZW50Lm1lc3NhZ2UucmVuZGVyZWQpO1xuICAgIGlmIChcbiAgICAgIGV2ZW50LnJlYXNvbiA9PT0gXCJjb21waWxlci1hcnRpZmFjdFwiICYmXG4gICAgICBpc1JlY29yZChldmVudC50YXJnZXQpICYmXG4gICAgICBpc1N0cmluZ0FycmF5KGV2ZW50LnRhcmdldC5raW5kKSAmJlxuICAgICAgZXZlbnQudGFyZ2V0LmtpbmQuaW5jbHVkZXMoXCJiaW5cIikgJiZcbiAgICAgIHR5cGVvZiBldmVudC5leGVjdXRhYmxlID09PSBcInN0cmluZ1wiXG4gICAgKVxuICAgICAgYmluYXJpZXMuYWRkKGJhc2VuYW1lKGV2ZW50LmV4ZWN1dGFibGUpKTtcbiAgfVxuICBpZiAoIWJpbmFyaWVzLnNpemUpIHRocm93IG5ldyBFcnJvcihcIlJ1c3QgcmVsZWFzZTogbm8gZXhlY3V0YWJsZSBhcnRpZmFjdHMgd2VyZSBwcm9kdWNlZFwiKTtcblxuICBta2RpclN5bmMoZGlybmFtZShvdXRwdXQpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3Qgc3RhZ2luZyA9IG1rZHRlbXBTeW5jKGpvaW4oZGlybmFtZShvdXRwdXQpLCBcIi5ydXN0LXJlbGVhc2UtXCIpKTtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgYmluYXJpZXMpIGNvcHlGaWxlU3luYyhqb2luKGJ1aWxkLCB0YXJnZXQsIFwicmVsZWFzZVwiLCBuYW1lKSwgam9pbihzdGFnaW5nLCBuYW1lKSk7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihyb290LCBcIkxJQ0VOU0VcIikpKSBjb3B5RmlsZVN5bmMoam9pbihyb290LCBcIkxJQ0VOU0VcIiksIGpvaW4oc3RhZ2luZywgXCJMSUNFTlNFXCIpKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihzdGFnaW5nLCBcInJ1c3QtcmVsZWFzZS5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIHtcbiAgICAgICAgICB0YXJnZXQsXG4gICAgICAgICAgYmluYXJpZXM6IFsuLi5iaW5hcmllc10uc29ydCgpLFxuICAgICAgICAgIC4uLihyZWNpcGVcbiAgICAgICAgICAgID8geyAuLi5yZWNpcGUudGFyZ2V0c1t0YXJnZXRdLCBjcm9zc192ZXJzaW9uOiByZWNpcGUuY3Jvc3NfdmVyc2lvbiwgY3Jvc3NfcmV2aXNpb246IHJlY2lwZS5jcm9zc19yZXZpc2lvbiB9XG4gICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgfSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgMixcbiAgICAgICkgKyBcIlxcblwiLFxuICAgICk7XG4gICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKHJvb3QsIFwic2NyaXB0cy9yZWxlYXNlLXZlcmlmeS5tanNcIiksIHN0YWdpbmcsIHJvb3RdKTtcbiAgICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBWZXJpZmljYXRpb24gZmluaXNoZXMgYmVmb3JlIGFueSBhY2NlcHRlZCBmaWxlIGlzIHJlcGxhY2VkLiBFYWNoIHJlcGxhY2VtZW50IGlzIGFuIGF0b21pYyByZW5hbWUuXG4gICAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKHN0YWdpbmcpKSByZW5hbWVTeW5jKGpvaW4oc3RhZ2luZywgbmFtZSksIGpvaW4ob3V0cHV0LCBuYW1lKSk7XG4gICAgY29uc29sZS5sb2coYFByZXBhcmVkIHZlcmlmaWVkIFJ1c3QgcmVsZWFzZSAoJHt0YXJnZXR9KTogJHtvdXRwdXR9YCk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSBjYXRjaCAoZXJyb3IpIHtcbiAgZmFpbHVyZSA9IGVycm9yO1xuICB0aHJvdyBlcnJvcjtcbn0gZmluYWxseSB7XG4gIGF3YWl0IHNldHRsZUNsZWFudXAoXG4gICAgW1xuICAgICAgKCkgPT4ge1xuICAgICAgICBpZiAoaW1hZ2VEaXJlY3RvcnkpIHJtU3luYyhpbWFnZURpcmVjdG9yeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgfSxcbiAgICAgICgpID0+IHtcbiAgICAgICAgY2FuY2VsbGF0aW9uLmNsb3NlKCk7XG4gICAgICB9LFxuICAgIF0sXG4gICAgZmFpbHVyZSxcbiAgKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsY0FBYyxRQUFRLFFBQVEsVUFBVSxxQkFBcUI7QUFFdEUsU0FBUyxlQUFlLG1CQUFtQiwyQkFBMkI7QUFDdEUsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxxQkFBcUI7QUFDOUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxVQUFVLFNBQVMsTUFBTSxlQUFlO0FBQ2pELFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsaUJBQWlCO0FBRTFCLE1BQU0sRUFBRSxPQUFPLElBQUksVUFBVSxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsTUFBTSxTQUFTLEdBQUcsaUJBQWlCLEVBQUUsTUFBTSxTQUFTLEVBQUUsRUFBRSxDQUFDO0FBQzdHLE1BQU0sT0FBTyxRQUFRLElBQUk7QUFDekIsTUFBTSxTQUFTLFFBQVEsUUFBUSxJQUFJLDRCQUE0QixRQUFRLElBQUksc0JBQXNCLE1BQU07QUFDdkcsTUFBTSxNQUF5QjtBQUFBLEVBQzdCLEdBQUcsUUFBUTtBQUFBLEVBQ1gsa0JBQWtCLE9BQU8sVUFBVSxDQUFDO0FBQUEsRUFDcEMsbUJBQW1CLE9BQU8sVUFBVSxDQUFDO0FBQ3ZDO0FBQ0EsTUFBTSxlQUFlLG9CQUFvQjtBQUN6QyxlQUFlLElBQUksU0FBaUIsTUFBZ0IsVUFBVSxPQUFPO0FBQ25FLFFBQU0sVUFBVSxFQUFFLEtBQUssTUFBTSxLQUFLLFFBQVEsYUFBYSxPQUFPO0FBQzlELE1BQUksU0FBUztBQUNYLFVBQU1BLFVBQVMsTUFBTSxrQkFBa0IsU0FBUyxNQUFNLFNBQVMsS0FBSyxPQUFPLElBQUk7QUFDL0UsUUFBSUEsUUFBTyxPQUFRLFNBQVEsT0FBTyxNQUFNQSxRQUFPLE1BQU07QUFDckQsVUFBTUMsV0FBVSxlQUFlLGlCQUFpQixPQUFPLElBQUksS0FBSyxDQUFDLEtBQUssRUFBRSxJQUFJRCxTQUFRQSxPQUFNO0FBQzFGLFFBQUlDLFNBQVMsT0FBTUE7QUFDbkIsV0FBTyxhQUFhRCxRQUFPLE1BQU07QUFBQSxFQUNuQztBQUNBLFFBQU0sU0FBUyxNQUFNLGNBQWMsU0FBUyxNQUFNLE9BQU87QUFDekQsUUFBTUMsV0FBVSxlQUFlLGlCQUFpQixPQUFPLElBQUksS0FBSyxDQUFDLEtBQUssRUFBRSxJQUFJLE1BQU07QUFDbEYsTUFBSUEsU0FBUyxPQUFNQTtBQUNuQixTQUFPO0FBQ1Q7QUFFQSxJQUFJO0FBQ0osSUFBSTtBQUNKLElBQUk7QUFDRixRQUFNLFdBQVcsTUFBTSxJQUFJLFNBQVMsQ0FBQyxLQUFLLEdBQUcsSUFBSTtBQUNqRCxRQUFNLE9BQU8sZ0JBQWdCLEtBQUssUUFBUSxJQUFJLENBQUM7QUFDL0MsUUFBTSxrQkFBa0IsMkJBQTJCLEtBQUssUUFBUSxJQUFJLENBQUM7QUFDckUsTUFBSSxDQUFDLFFBQVEsQ0FBQyxnQkFBaUIsT0FBTSxJQUFJLE1BQU0sZ0VBQWdFO0FBQy9HLFFBQU0sU0FBUyxPQUFPLFVBQVU7QUFDaEMsUUFBTSxZQUFZLElBQUksZUFBZTtBQUNyQyxNQUFJO0FBRUosTUFBSSxPQUFPLFFBQVE7QUFDakIsVUFBTSxRQUFRLE9BQU8sS0FBSyxNQUFNLGFBQWEsS0FBSyxNQUFNLG1CQUFtQixHQUFHLE1BQU0sQ0FBQyxHQUFHLHFCQUFxQjtBQUM3RyxhQUFTO0FBQUEsTUFDUCxTQUFTLE9BQU87QUFBQSxRQUNkLE9BQU8sUUFBUSxPQUFPLE1BQU0sU0FBUyxzQkFBc0IsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEtBQUtDLE9BQU0sTUFBTTtBQUFBLFVBQ25GO0FBQUEsVUFDQSxPQUFPQSxTQUFRLHFCQUFxQjtBQUFBLFFBQ3RDLENBQUM7QUFBQSxNQUNIO0FBQUEsTUFDQSxlQUFlLE9BQU8sTUFBTSxlQUFlLHVCQUF1QjtBQUFBLE1BQ2xFLGdCQUFnQixPQUFPLE1BQU0sZ0JBQWdCLHdCQUF3QjtBQUFBLElBQ3ZFO0FBQ0EsVUFBTSxXQUFXLE9BQU8sUUFBUSxNQUFNO0FBQ3RDLFFBQUksVUFBVSxhQUFhLEdBQUcsUUFBUSxRQUFRLElBQUksUUFBUSxJQUFJO0FBQzVELFlBQU0sSUFBSSxNQUFNLGlCQUFpQixNQUFNLCtEQUErRDtBQUN4RyxRQUFJLFFBQVEsSUFBSSwrQkFBK0IsUUFBUSxJQUFJLGdDQUFnQztBQUN6RixZQUFNLElBQUk7QUFBQSxRQUNSO0FBQUEsTUFDRjtBQUVGLFVBQU0sZUFBZSxJQUFJO0FBQ3pCLGVBQVcsUUFBUSxPQUFPLEtBQUssR0FBRztBQUNoQyxVQUNFLHVKQUF1SjtBQUFBLFFBQ3JKO0FBQUEsTUFDRjtBQUVBLGdCQUFRLGVBQWUsS0FBSyxJQUFJO0FBRXBDLFFBQUksYUFBYyxLQUFJLG1CQUFtQjtBQUN6QyxRQUFJLHlCQUF5QjtBQUM3QixRQUFJLFlBQVksZ0JBQWdCLFFBQVEsU0FBUyxRQUFRLFdBQVcsU0FBUztBQUM3RSxVQUFNLGtCQUNKLE1BQU0sSUFBSSxVQUFVLENBQUMsV0FBVyxZQUFZLGlDQUFpQyxHQUFHLElBQUksR0FDcEYsS0FBSztBQUNQLFFBQUksbUJBQW1CLFNBQVMsUUFBUSxTQUFTLFFBQVEsVUFBVSxPQUFPO0FBQ3hFLFlBQU0sSUFBSSxNQUFNLCtCQUErQixjQUFjLHFCQUFxQjtBQUNwRixVQUFNLFdBQVcsZ0RBQWdEO0FBQUEsTUFDL0QsTUFBTSxJQUFJLFNBQVMsQ0FBQyxXQUFXLFdBQVcsR0FBRyxJQUFJO0FBQUEsSUFDbkQ7QUFDQSxVQUFNLFVBQVUsV0FBVyxDQUFDO0FBQzVCLFFBQUksWUFBWSxPQUFPO0FBQ3JCLFlBQU0sSUFBSSxNQUFNLGdDQUFnQyxPQUFPLGFBQWEsV0FBVyxXQUFXLFNBQVMsRUFBRTtBQUN2RyxRQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxPQUFPLGVBQWUsV0FBVyxTQUFTLENBQUMsQ0FBQztBQUNqRSxZQUFNLElBQUk7QUFBQSxRQUNSLHlDQUF5QyxPQUFPLGNBQWMsV0FBVyxXQUFXLENBQUMsS0FBSyxTQUFTO0FBQUEsTUFDckc7QUFDRixRQUFJLE9BQU8sZUFBZSxHQUFHO0FBQzNCLGdCQUFVLFFBQVEsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDOUMsdUJBQWlCLFlBQVksS0FBSyxRQUFRLE1BQU0sR0FBRyxjQUFjLENBQUM7QUFDbEUsWUFBTSxXQUFXLEtBQUssZ0JBQWdCLFlBQVk7QUFDbEQsWUFBTSxJQUFJLFFBQVEsVUFBVTtBQUFBLFFBQzFCLFFBQVEsWUFBWSxTQUFTLHNCQUFzQjtBQUFBLFFBQ25EO0FBQUEsUUFDQSxPQUFPLGVBQWU7QUFBQSxRQUN0QjtBQUFBLFFBQ0E7QUFBQSxNQUNGLENBQUM7QUFDRCxZQUFNLFFBQVEsb0JBQW9CLEtBQUssTUFBTSxhQUFhLFVBQVUsTUFBTSxDQUFDLENBQUM7QUFDNUUsVUFBSSxNQUFNLGFBQWEsU0FBUyxRQUFRLElBQUksTUFBTSxNQUFNLFlBQVksT0FBTyxlQUFlO0FBQ3hGLGNBQU0sSUFBSSxNQUFNLHFFQUFxRTtBQUN2RixZQUFNLElBQUksVUFBVSxDQUFDLE9BQU8sUUFBUSxrQkFBa0IsTUFBTSxXQUFXLFlBQVksV0FBVyxDQUFDO0FBQy9GLFlBQU0sZ0JBQWdCLEtBQUssZ0JBQWdCLFlBQVk7QUFDdkQ7QUFBQSxRQUNFO0FBQUEsUUFDQTtBQUFBO0FBQUEsVUFDYSxNQUFNO0FBQUE7QUFBQSxlQUFzQyxLQUFLLFVBQVUsTUFBTSxTQUFTLENBQUM7QUFBQSxxQkFDaEUsS0FBSyxVQUFVLElBQUksQ0FBQztBQUFBO0FBQUEsTUFDOUM7QUFDQSxVQUFJLGVBQWU7QUFBQSxJQUNyQjtBQUFBLEVBQ0Y7QUFDQSxTQUFPLElBQUk7QUFDWCxRQUFNLFNBQVMsT0FBTyxTQUFTLFVBQVU7QUFDekMsUUFBTSxTQUFTLE9BQU8sU0FBUyxDQUFDLFNBQVMsSUFBSSxDQUFDO0FBQzlDLFFBQU0sUUFBUSxRQUFRLFFBQVEsSUFBSSxvQkFBb0IsS0FBSyxRQUFRLElBQUksdUJBQXVCLE1BQU0sUUFBUSxDQUFDO0FBQzdHLFFBQU0sWUFBWSxDQUFDLGFBQWEsWUFBWSxZQUFZLFFBQVEsZ0JBQWdCLEtBQUs7QUFDckYsUUFBTSxJQUFJLFFBQVEsQ0FBQyxHQUFHLFFBQVEsUUFBUSxlQUFlLGlCQUFpQixrQkFBa0IsR0FBRyxTQUFTLENBQUM7QUFDckcsUUFBTSxJQUFJLFFBQVEsQ0FBQyxHQUFHLFFBQVEsUUFBUSxlQUFlLFNBQVMsR0FBRyxTQUFTLENBQUM7QUFDM0UsUUFBTSxXQUFXLE1BQU07QUFBQSxJQUNyQjtBQUFBLElBQ0EsQ0FBQyxHQUFHLFFBQVEsU0FBUyxlQUFlLFVBQVUsNENBQTRDLEdBQUcsU0FBUztBQUFBLElBQ3RHO0FBQUEsRUFDRjtBQUNBLFFBQU0sV0FBVyxvQkFBSSxJQUFZO0FBQ2pDLGFBQVcsUUFBUSxTQUFTLE1BQU0sSUFBSSxFQUFFLE9BQU8sT0FBTyxHQUFHO0FBQ3ZELFFBQUksQ0FBQyxLQUFLLFdBQVcsR0FBRyxHQUFHO0FBQ3pCLGNBQVEsSUFBSSxJQUFJO0FBQ2hCO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxPQUFPLEtBQUssTUFBTSxJQUFJLEdBQUcsMEJBQTBCO0FBQ2pFLFFBQUksTUFBTSxXQUFXLHNCQUFzQixTQUFTLE1BQU0sT0FBTyxLQUFLLE9BQU8sTUFBTSxRQUFRLGFBQWE7QUFDdEcsY0FBUSxPQUFPLE1BQU0sTUFBTSxRQUFRLFFBQVE7QUFDN0MsUUFDRSxNQUFNLFdBQVcsdUJBQ2pCLFNBQVMsTUFBTSxNQUFNLEtBQ3JCLGNBQWMsTUFBTSxPQUFPLElBQUksS0FDL0IsTUFBTSxPQUFPLEtBQUssU0FBUyxLQUFLLEtBQ2hDLE9BQU8sTUFBTSxlQUFlO0FBRTVCLGVBQVMsSUFBSSxTQUFTLE1BQU0sVUFBVSxDQUFDO0FBQUEsRUFDM0M7QUFDQSxNQUFJLENBQUMsU0FBUyxLQUFNLE9BQU0sSUFBSSxNQUFNLHFEQUFxRDtBQUV6RixZQUFVLFFBQVEsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDOUMsUUFBTSxVQUFVLFlBQVksS0FBSyxRQUFRLE1BQU0sR0FBRyxnQkFBZ0IsQ0FBQztBQUNuRSxNQUFJO0FBQ0YsZUFBVyxRQUFRLFNBQVUsY0FBYSxLQUFLLE9BQU8sUUFBUSxXQUFXLElBQUksR0FBRyxLQUFLLFNBQVMsSUFBSSxDQUFDO0FBQ25HLFFBQUksV0FBVyxLQUFLLE1BQU0sU0FBUyxDQUFDLEVBQUcsY0FBYSxLQUFLLE1BQU0sU0FBUyxHQUFHLEtBQUssU0FBUyxTQUFTLENBQUM7QUFDbkc7QUFBQSxNQUNFLEtBQUssU0FBUyxtQkFBbUI7QUFBQSxNQUNqQyxLQUFLO0FBQUEsUUFDSDtBQUFBLFVBQ0U7QUFBQSxVQUNBLFVBQVUsQ0FBQyxHQUFHLFFBQVEsRUFBRSxLQUFLO0FBQUEsVUFDN0IsR0FBSSxTQUNBLEVBQUUsR0FBRyxPQUFPLFFBQVEsTUFBTSxHQUFHLGVBQWUsT0FBTyxlQUFlLGdCQUFnQixPQUFPLGVBQWUsSUFDeEcsQ0FBQztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsSUFBSTtBQUFBLElBQ047QUFDQSxVQUFNLElBQUksUUFBUSxVQUFVLENBQUMsS0FBSyxNQUFNLDRCQUE0QixHQUFHLFNBQVMsSUFBSSxDQUFDO0FBQ3JGLGNBQVUsUUFBUSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBRXJDLGVBQVcsUUFBUSxZQUFZLE9BQU8sRUFBRyxZQUFXLEtBQUssU0FBUyxJQUFJLEdBQUcsS0FBSyxRQUFRLElBQUksQ0FBQztBQUMzRixZQUFRLElBQUksbUNBQW1DLE1BQU0sTUFBTSxNQUFNLEVBQUU7QUFBQSxFQUNyRSxVQUFFO0FBQ0EsV0FBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDbEQ7QUFDRixTQUFTLE9BQU87QUFDZCxZQUFVO0FBQ1YsUUFBTTtBQUNSLFVBQUU7QUFDQSxRQUFNO0FBQUEsSUFDSjtBQUFBLE1BQ0UsTUFBTTtBQUNKLFlBQUksZUFBZ0IsUUFBTyxnQkFBZ0IsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxNQUM3RTtBQUFBLE1BQ0EsTUFBTTtBQUNKLHFCQUFhLE1BQU07QUFBQSxNQUNyQjtBQUFBLElBQ0Y7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNGOyIsIm5hbWVzIjpbInJlc3VsdCIsImZhaWx1cmUiLCJ0YXJnZXQiXSwiZmlsZSI6InNjcmlwdHMvcmVsZWFzZS1ydXN0Lm1qcyJ9
