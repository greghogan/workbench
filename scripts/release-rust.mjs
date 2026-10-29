// Generated from release-rust.mts; edit the TypeScript source.
import { readAcquiredCIImage } from "./ci-image-contract.mjs";
import { capturedText, record, string, isRecord, isStringArray } from "./values.mjs";
import { runOwnedChild, captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { settleCleanup } from "./diagnostic-errors.mjs";
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
import { cpuBudget } from "./cpu-budget.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJlbGVhc2UtcnVzdC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEFjcXVpcmVkQ0lJbWFnZSB9IGZyb20gXCIuL2NpLWltYWdlLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgY2FwdHVyZWRUZXh0LCByZWNvcmQsIHN0cmluZywgaXNSZWNvcmQsIGlzU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5cbmltcG9ydCB7IHJ1bk93bmVkQ2hpbGQsIGNhcHR1cmVPd25lZENoaWxkLCBwcm9jZXNzQ2FuY2VsbGF0aW9uIH0gZnJvbSBcIi4vb3duZWQtY2hpbGQubWpzXCI7XG5pbXBvcnQgeyBwcm9jZXNzRmFpbHVyZSB9IGZyb20gXCIuL3Byb2Nlc3Mtb3V0Y29tZS5tanNcIjtcbmltcG9ydCB7IHNldHRsZUNsZWFudXAgfSBmcm9tIFwiLi9kaWFnbm9zdGljLWVycm9ycy5tanNcIjtcbmltcG9ydCB7XG4gIGNvcHlGaWxlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBta2R0ZW1wU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgcm1TeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyBjcHVCdWRnZXQgfSBmcm9tIFwiLi9jcHUtYnVkZ2V0Lm1qc1wiO1xuXG5jb25zdCB7IHZhbHVlcyB9ID0gcGFyc2VBcmdzKHsgb3B0aW9uczogeyB0YXJnZXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LCBcImltYWdlLXByb2ZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0gfSB9KTtcbmNvbnN0IHJvb3QgPSBwcm9jZXNzLmN3ZCgpO1xuY29uc3Qgb3V0cHV0ID0gcmVzb2x2ZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVMRUFTRV9PVVRQVVQgPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RfRElSID8/IFwiZGlzdFwiKTtcbmNvbnN0IGVudjogTm9kZUpTLlByb2Nlc3NFbnYgPSB7XG4gIC4uLnByb2Nlc3MuZW52LFxuICBDQVJHT19CVUlMRF9KT0JTOiBTdHJpbmcoY3B1QnVkZ2V0KCkpLFxuICBSVVNUX1RFU1RfVEhSRUFEUzogU3RyaW5nKGNwdUJ1ZGdldCgpKSxcbn07XG5jb25zdCBjYW5jZWxsYXRpb24gPSBwcm9jZXNzQ2FuY2VsbGF0aW9uKCk7XG5hc3luYyBmdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgY2FwdHVyZSA9IGZhbHNlKSB7XG4gIGNvbnN0IG9wdGlvbnMgPSB7IGN3ZDogcm9vdCwgZW52LCBzaWduYWw6IGNhbmNlbGxhdGlvbi5zaWduYWwgfTtcbiAgaWYgKGNhcHR1cmUpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYXB0dXJlT3duZWRDaGlsZChjb21tYW5kLCBhcmdzLCBvcHRpb25zLCAxNiAqIDEwMjQgKiAxMDI0KTtcbiAgICBpZiAocmVzdWx0LnN0ZGVycikgcHJvY2Vzcy5zdGRlcnIud3JpdGUocmVzdWx0LnN0ZGVycik7XG4gICAgY29uc3QgZmFpbHVyZSA9IHByb2Nlc3NGYWlsdXJlKGBSdXN0IHJlbGVhc2U6ICR7Y29tbWFuZH0gJHthcmdzWzBdID8/IFwiXCJ9YCwgcmVzdWx0LCByZXN1bHQpO1xuICAgIGlmIChmYWlsdXJlKSB0aHJvdyBmYWlsdXJlO1xuICAgIHJldHVybiBjYXB0dXJlZFRleHQocmVzdWx0LnN0ZG91dCk7XG4gIH1cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuT3duZWRDaGlsZChjb21tYW5kLCBhcmdzLCBvcHRpb25zKTtcbiAgY29uc3QgZmFpbHVyZSA9IHByb2Nlc3NGYWlsdXJlKGBSdXN0IHJlbGVhc2U6ICR7Y29tbWFuZH0gJHthcmdzWzBdID8/IFwiXCJ9YCwgcmVzdWx0KTtcbiAgaWYgKGZhaWx1cmUpIHRocm93IGZhaWx1cmU7XG4gIHJldHVybiBcIlwiO1xufVxuXG5sZXQgaW1hZ2VEaXJlY3Rvcnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbmxldCBmYWlsdXJlOiB1bmtub3duO1xudHJ5IHtcbiAgY29uc3QgY29tcGlsZXIgPSBhd2FpdCBydW4oXCJydXN0Y1wiLCBbXCItdlZcIl0sIHRydWUpO1xuICBjb25zdCBob3N0ID0gL15ob3N0OiAoLispJC9tLmV4ZWMoY29tcGlsZXIpPy5bMV07XG4gIGNvbnN0IGNvbXBpbGVyVmVyc2lvbiA9IC9ecnVzdGMgKFxcZCtcXC5cXGQrXFwuXFxkKylcXGIvLmV4ZWMoY29tcGlsZXIpPy5bMV07XG4gIGlmICghaG9zdCB8fCAhY29tcGlsZXJWZXJzaW9uKSB0aHJvdyBuZXcgRXJyb3IoXCJSdXN0IHJlbGVhc2U6IHJ1c3RjIGRpZCBub3QgcmVwb3J0IGl0cyB2ZXJzaW9uIGFuZCBob3N0IHRhcmdldFwiKTtcbiAgY29uc3QgdGFyZ2V0ID0gdmFsdWVzLnRhcmdldCA/PyBob3N0O1xuICBjb25zdCB0b29sY2hhaW4gPSBgKyR7Y29tcGlsZXJWZXJzaW9ufWA7XG4gIGxldCByZWNpcGU6XG4gICAgeyB0YXJnZXRzOiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47IGNyb3NzX3ZlcnNpb246IHN0cmluZzsgY3Jvc3NfcmV2aXNpb246IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICBpZiAodmFsdWVzLnRhcmdldCkge1xuICAgIGNvbnN0IHZhbHVlID0gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJyZWxlYXNlLW11c2wuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIG11c2wgcmVjaXBlXCIpO1xuICAgIHJlY2lwZSA9IHtcbiAgICAgIHRhcmdldHM6IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgT2JqZWN0LmVudHJpZXMocmVjb3JkKHZhbHVlLnRhcmdldHMsIFwiTWlzc2luZyBtdXNsIHRhcmdldHNcIikpLm1hcCgoW2tleSwgdGFyZ2V0XSkgPT4gW1xuICAgICAgICAgIGtleSxcbiAgICAgICAgICByZWNvcmQodGFyZ2V0LCBcIkludmFsaWQgbXVzbCB0YXJnZXRcIiksXG4gICAgICAgIF0pLFxuICAgICAgKSxcbiAgICAgIGNyb3NzX3ZlcnNpb246IHN0cmluZyh2YWx1ZS5jcm9zc192ZXJzaW9uLCBcIk1pc3NpbmcgY3Jvc3MgdmVyc2lvblwiKSxcbiAgICAgIGNyb3NzX3JldmlzaW9uOiBzdHJpbmcodmFsdWUuY3Jvc3NfcmV2aXNpb24sIFwiTWlzc2luZyBjcm9zcyByZXZpc2lvblwiKSxcbiAgICB9O1xuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVjaXBlLnRhcmdldHNbdGFyZ2V0XTtcbiAgICBpZiAoc2VsZWN0ZWQ/LnBsYXRmb3JtICE9PSBgJHtwcm9jZXNzLnBsYXRmb3JtfS0ke3Byb2Nlc3MuYXJjaH1gKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBSdXN0IHJlbGVhc2U6ICR7dGFyZ2V0fSByZXF1aXJlcyBpdHMgbmF0aXZlIExpbnV4IGFyY2hpdGVjdHVyZSBidWlsZGVyOyBubyBlbXVsYXRpb25gKTtcbiAgICBpZiAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1NIRUxMX0VOVklST05NRU5UICYmIHByb2Nlc3MuZW52LldPUktCRU5DSF9TSEVMTF9FTlZJUk9OTUVOVCAhPT0gXCJuYXRpdmVcIilcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJSdXN0IHJlbGVhc2U6IG11c2wgcHJvZmlsZXMgcmVxdWlyZSB0aGUgbmF0aXZlIGJ1aWxkZXI7IG1hbmFnZWQgcmVsZWFzZXMgcmV0YWluIHRoZWlyIG93biB0b29sIGF1dGhvcml0eVwiLFxuICAgICAgKTtcbiAgICAvLyBQb3J0YWJsZSByZWNpcGVzIG11c3Qgbm90IGluaGVyaXQgaG9zdC1zcGVjaWZpYyBvcHRpbWl6YXRpb24gb3IgbGlua2VyIHNldHRpbmdzLlxuICAgIGNvbnN0IGJ1aWxkT3B0aW9ucyA9IGVudi5DUk9TU19CVUlMRF9PUFRTO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyhlbnYpKVxuICAgICAgaWYgKFxuICAgICAgICAvXig/OlJVU1RGTEFHU3xDQVJHT19FTkNPREVEX1JVU1RGTEFHU3xDQVJHT19CVUlMRF9SVVNURkxBR1N8Q0FSR09fVEFSR0VUXy4qXyg/OkxJTktFUnxSVU5ORVJ8UlVTVEZMQUdTKXxDQ3xDWFh8QVJ8Q0ZMQUdTfENYWEZMQUdTfExERkxBR1N8Q1JPU1NfLiopJC8udGVzdChcbiAgICAgICAgICBuYW1lLFxuICAgICAgICApXG4gICAgICApXG4gICAgICAgIFJlZmxlY3QuZGVsZXRlUHJvcGVydHkoZW52LCBuYW1lKTtcbiAgICAvLyBLZWVwIGNyb3NzJ3MgZXhwbGljaXQgRG9ja2VyIGJ1aWxkIHRyYW5zcG9ydCBvcHRpb25zIChmb3IgZXhhbXBsZSBsb2NhbCBob3N0IG5ldHdvcmtpbmcpLlxuICAgIGlmIChidWlsZE9wdGlvbnMpIGVudi5DUk9TU19CVUlMRF9PUFRTID0gYnVpbGRPcHRpb25zO1xuICAgIGVudi5DUk9TU19DT05UQUlORVJfRU5HSU5FID0gXCJkb2NrZXJcIjtcbiAgICBlbnYuUlVTVEZMQUdTID0gYC1DdGFyZ2V0LWNwdT0ke3Byb2Nlc3MuYXJjaCA9PT0gXCJ4NjRcIiA/IFwieDg2LTY0XCIgOiBcImdlbmVyaWNcIn0gLUN0YXJnZXQtZmVhdHVyZT0rY3J0LXN0YXRpY2A7XG4gICAgY29uc3QgZW5naW5lUGxhdGZvcm0gPSAoXG4gICAgICBhd2FpdCBydW4oXCJkb2NrZXJcIiwgW1widmVyc2lvblwiLCBcIi0tZm9ybWF0XCIsIFwie3suU2VydmVyLk9zfX0ve3suU2VydmVyLkFyY2h9fVwiXSwgdHJ1ZSlcbiAgICApLnRyaW0oKTtcbiAgICBpZiAoZW5naW5lUGxhdGZvcm0gIT09IGBsaW51eC8ke3Byb2Nlc3MuYXJjaCA9PT0gXCJ4NjRcIiA/IFwiYW1kNjRcIiA6IFwiYXJtNjRcIn1gKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBSdXN0IHJlbGVhc2U6IERvY2tlciBlbmdpbmUgJHtlbmdpbmVQbGF0Zm9ybX0gcmVxdWlyZXMgZW11bGF0aW9uYCk7XG4gICAgY29uc3QgcmVwb3J0ZWQgPSAvXmNyb3NzIChcXFMrKSg/OiBcXCgoWzAtOWEtZl17Nyw0MH0pIFteKV0rXFwpKT8vbS5leGVjKFxuICAgICAgYXdhaXQgcnVuKFwiY3Jvc3NcIiwgW3Rvb2xjaGFpbiwgXCItLXZlcnNpb25cIl0sIHRydWUpLFxuICAgICk7XG4gICAgY29uc3QgdmVyc2lvbiA9IHJlcG9ydGVkPy5bMV07XG4gICAgaWYgKHZlcnNpb24gIT09IHJlY2lwZS5jcm9zc192ZXJzaW9uKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBSdXN0IHJlbGVhc2U6IGV4cGVjdGVkIGNyb3NzICR7cmVjaXBlLmNyb3NzX3ZlcnNpb259LCBmb3VuZCAke3ZlcnNpb24gPz8gXCJ1bmtub3duXCJ9YCk7XG4gICAgaWYgKCFyZXBvcnRlZD8uWzJdIHx8ICFyZWNpcGUuY3Jvc3NfcmV2aXNpb24uc3RhcnRzV2l0aChyZXBvcnRlZFsyXSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBSdXN0IHJlbGVhc2U6IGV4cGVjdGVkIGNyb3NzIHJldmlzaW9uICR7cmVjaXBlLmNyb3NzX3JldmlzaW9ufSwgZm91bmQgJHtyZXBvcnRlZD8uWzJdID8/IFwidW5rbm93blwifWAsXG4gICAgICApO1xuICAgIGlmICh2YWx1ZXNbXCJpbWFnZS1wcm9maWxlXCJdKSB7XG4gICAgICBta2RpclN5bmMoZGlybmFtZShvdXRwdXQpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGltYWdlRGlyZWN0b3J5ID0gbWtkdGVtcFN5bmMoam9pbihkaXJuYW1lKG91dHB1dCksIFwiLm11c2wtaW1hZ2UtXCIpKTtcbiAgICAgIGNvbnN0IG1ldGFkYXRhID0gam9pbihpbWFnZURpcmVjdG9yeSwgXCJpbWFnZS5qc29uXCIpO1xuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgcmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uL2Jpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICBcImNpLWltYWdlLWFjcXVpcmVcIixcbiAgICAgICAgdmFsdWVzW1wiaW1hZ2UtcHJvZmlsZVwiXSxcbiAgICAgICAgXCItLW91dHB1dFwiLFxuICAgICAgICBtZXRhZGF0YSxcbiAgICAgIF0pO1xuICAgICAgY29uc3QgaW1hZ2UgPSByZWFkQWNxdWlyZWRDSUltYWdlKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKG1ldGFkYXRhLCBcInV0ZjhcIikpKTtcbiAgICAgIGlmIChpbWFnZS5wbGF0Zm9ybSAhPT0gYGxpbnV4LSR7cHJvY2Vzcy5hcmNofWAgfHwgaW1hZ2UucHJvZmlsZSAhPT0gdmFsdWVzW1wiaW1hZ2UtcHJvZmlsZVwiXSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUnVzdCByZWxlYXNlOiBwcmVwYXJlZCBpbWFnZSBiZWxvbmdzIHRvIGFub3RoZXIgcGxhdGZvcm0gb3IgcHJvZmlsZVwiKTtcbiAgICAgIGF3YWl0IHJ1bihcImRvY2tlclwiLCBbXCJydW5cIiwgXCItLXJtXCIsIFwiLS1uZXR3b3JrPW5vbmVcIiwgaW1hZ2UucHVibGlzaGVkLCBcIm11c2wtZ2NjXCIsIFwiLS12ZXJzaW9uXCJdKTtcbiAgICAgIGNvbnN0IGNvbmZpZ3VyYXRpb24gPSBqb2luKGltYWdlRGlyZWN0b3J5LCBcIkNyb3NzLnRvbWxcIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBjb25maWd1cmF0aW9uLFxuICAgICAgICBgW2J1aWxkLmVudl1cXG5wYXNzdGhyb3VnaCA9IFtcIkNBUkdPX0JVSUxEX0pPQlNcIiwgXCJSVVNUX1RFU1RfVEhSRUFEU1wiXVxcbmAgK1xuICAgICAgICAgIGBbdGFyZ2V0LiR7dGFyZ2V0fV1cXG5ydW5uZXIgPSBcIm5hdGl2ZVwiXFxuaW1hZ2UubmFtZSA9ICR7SlNPTi5zdHJpbmdpZnkoaW1hZ2UucHVibGlzaGVkKX1cXG5gICtcbiAgICAgICAgICBgaW1hZ2UudG9vbGNoYWluID0gWyR7SlNPTi5zdHJpbmdpZnkoaG9zdCl9XVxcbmAsXG4gICAgICApO1xuICAgICAgZW52LkNST1NTX0NPTkZJRyA9IGNvbmZpZ3VyYXRpb247XG4gICAgfVxuICB9XG4gIGRlbGV0ZSBlbnYuQ0FSR09fQlVJTERfVEFSR0VUO1xuICBjb25zdCBydW5uZXIgPSB2YWx1ZXMudGFyZ2V0ID8gXCJjcm9zc1wiIDogXCJjYXJnb1wiO1xuICBjb25zdCBwcmVmaXggPSB2YWx1ZXMudGFyZ2V0ID8gW3Rvb2xjaGFpbl0gOiBbXTtcbiAgY29uc3QgYnVpbGQgPSByZXNvbHZlKHByb2Nlc3MuZW52LkNBUkdPX1RBUkdFVF9ESVIgPz8gam9pbihwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERfRElSID8/IHJvb3QsIFwidGFyZ2V0XCIpKTtcbiAgY29uc3Qgc2VsZWN0aW9uID0gW1wiLS1yZWxlYXNlXCIsIFwiLS1sb2NrZWRcIiwgXCItLXRhcmdldFwiLCB0YXJnZXQsIFwiLS10YXJnZXQtZGlyXCIsIGJ1aWxkXTtcbiAgYXdhaXQgcnVuKHJ1bm5lciwgWy4uLnByZWZpeCwgXCJ0ZXN0XCIsIFwiLS13b3Jrc3BhY2VcIiwgXCItLWFsbC10YXJnZXRzXCIsIFwiLS1uby1mYWlsLWZhc3RcIiwgLi4uc2VsZWN0aW9uXSk7XG4gIGF3YWl0IHJ1bihydW5uZXIsIFsuLi5wcmVmaXgsIFwidGVzdFwiLCBcIi0td29ya3NwYWNlXCIsIFwiLS1kb2NcIiwgLi4uc2VsZWN0aW9uXSk7XG4gIGNvbnN0IG1lc3NhZ2VzID0gYXdhaXQgcnVuKFxuICAgIHJ1bm5lcixcbiAgICBbLi4ucHJlZml4LCBcImJ1aWxkXCIsIFwiLS13b3Jrc3BhY2VcIiwgXCItLWJpbnNcIiwgXCItLW1lc3NhZ2UtZm9ybWF0PWpzb24tcmVuZGVyLWRpYWdub3N0aWNzXCIsIC4uLnNlbGVjdGlvbl0sXG4gICAgdHJ1ZSxcbiAgKTtcbiAgY29uc3QgYmluYXJpZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIG1lc3NhZ2VzLnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKSkge1xuICAgIGlmICghbGluZS5zdGFydHNXaXRoKFwie1wiKSkge1xuICAgICAgY29uc29sZS5sb2cobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgZXZlbnQgPSByZWNvcmQoSlNPTi5wYXJzZShsaW5lKSwgXCJJbnZhbGlkIFJ1c3QgYnVpbGQgZXZlbnRcIik7XG4gICAgaWYgKGV2ZW50LnJlYXNvbiA9PT0gXCJjb21waWxlci1tZXNzYWdlXCIgJiYgaXNSZWNvcmQoZXZlbnQubWVzc2FnZSkgJiYgdHlwZW9mIGV2ZW50Lm1lc3NhZ2UucmVuZGVyZWQgPT09IFwic3RyaW5nXCIpXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShldmVudC5tZXNzYWdlLnJlbmRlcmVkKTtcbiAgICBpZiAoXG4gICAgICBldmVudC5yZWFzb24gPT09IFwiY29tcGlsZXItYXJ0aWZhY3RcIiAmJlxuICAgICAgaXNSZWNvcmQoZXZlbnQudGFyZ2V0KSAmJlxuICAgICAgaXNTdHJpbmdBcnJheShldmVudC50YXJnZXQua2luZCkgJiZcbiAgICAgIGV2ZW50LnRhcmdldC5raW5kLmluY2x1ZGVzKFwiYmluXCIpICYmXG4gICAgICB0eXBlb2YgZXZlbnQuZXhlY3V0YWJsZSA9PT0gXCJzdHJpbmdcIlxuICAgIClcbiAgICAgIGJpbmFyaWVzLmFkZChiYXNlbmFtZShldmVudC5leGVjdXRhYmxlKSk7XG4gIH1cbiAgaWYgKCFiaW5hcmllcy5zaXplKSB0aHJvdyBuZXcgRXJyb3IoXCJSdXN0IHJlbGVhc2U6IG5vIGV4ZWN1dGFibGUgYXJ0aWZhY3RzIHdlcmUgcHJvZHVjZWRcIik7XG5cbiAgbWtkaXJTeW5jKGRpcm5hbWUob3V0cHV0KSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHN0YWdpbmcgPSBta2R0ZW1wU3luYyhqb2luKGRpcm5hbWUob3V0cHV0KSwgXCIucnVzdC1yZWxlYXNlLVwiKSk7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIGJpbmFyaWVzKSBjb3B5RmlsZVN5bmMoam9pbihidWlsZCwgdGFyZ2V0LCBcInJlbGVhc2VcIiwgbmFtZSksIGpvaW4oc3RhZ2luZywgbmFtZSkpO1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJMSUNFTlNFXCIpKSkgY29weUZpbGVTeW5jKGpvaW4ocm9vdCwgXCJMSUNFTlNFXCIpLCBqb2luKHN0YWdpbmcsIFwiTElDRU5TRVwiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oc3RhZ2luZywgXCJydXN0LXJlbGVhc2UuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KFxuICAgICAgICB7XG4gICAgICAgICAgdGFyZ2V0LFxuICAgICAgICAgIGJpbmFyaWVzOiBbLi4uYmluYXJpZXNdLnNvcnQoKSxcbiAgICAgICAgICAuLi4ocmVjaXBlXG4gICAgICAgICAgICA/IHsgLi4ucmVjaXBlLnRhcmdldHNbdGFyZ2V0XSwgY3Jvc3NfdmVyc2lvbjogcmVjaXBlLmNyb3NzX3ZlcnNpb24sIGNyb3NzX3JldmlzaW9uOiByZWNpcGUuY3Jvc3NfcmV2aXNpb24gfVxuICAgICAgICAgICAgOiB7fSksXG4gICAgICAgIH0sXG4gICAgICAgIG51bGwsXG4gICAgICAgIDIsXG4gICAgICApICsgXCJcXG5cIixcbiAgICApO1xuICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihyb290LCBcInNjcmlwdHMvcmVsZWFzZS12ZXJpZnkubWpzXCIpLCBzdGFnaW5nLCByb290XSk7XG4gICAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gVmVyaWZpY2F0aW9uIGZpbmlzaGVzIGJlZm9yZSBhbnkgYWNjZXB0ZWQgZmlsZSBpcyByZXBsYWNlZC4gRWFjaCByZXBsYWNlbWVudCBpcyBhbiBhdG9taWMgcmVuYW1lLlxuICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhzdGFnaW5nKSkgcmVuYW1lU3luYyhqb2luKHN0YWdpbmcsIG5hbWUpLCBqb2luKG91dHB1dCwgbmFtZSkpO1xuICAgIGNvbnNvbGUubG9nKGBQcmVwYXJlZCB2ZXJpZmllZCBSdXN0IHJlbGVhc2UgKCR7dGFyZ2V0fSk6ICR7b3V0cHV0fWApO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0gY2F0Y2ggKGVycm9yKSB7XG4gIGZhaWx1cmUgPSBlcnJvcjtcbiAgdGhyb3cgZXJyb3I7XG59IGZpbmFsbHkge1xuICBhd2FpdCBzZXR0bGVDbGVhbnVwKFxuICAgIFtcbiAgICAgICgpID0+IHtcbiAgICAgICAgaWYgKGltYWdlRGlyZWN0b3J5KSBybVN5bmMoaW1hZ2VEaXJlY3RvcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIH0sXG4gICAgICAoKSA9PiB7XG4gICAgICAgIGNhbmNlbGxhdGlvbi5jbG9zZSgpO1xuICAgICAgfSxcbiAgICBdLFxuICAgIGZhaWx1cmUsXG4gICk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLGNBQWMsUUFBUSxRQUFRLFVBQVUscUJBQXFCO0FBRXRFLFNBQVMsZUFBZSxtQkFBbUIsMkJBQTJCO0FBQ3RFLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMscUJBQXFCO0FBQzlCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsVUFBVSxTQUFTLE1BQU0sZUFBZTtBQUNqRCxTQUFTLGlCQUFpQjtBQUMx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QUFRLE1BQU0sR0FBRyxlQUFlLE9BQU8sZUFBZSxnQkFBZ0IsT0FBTyxlQUFlLElBQ3hHLENBQUM7QUFBQSxRQUNQO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLElBQUk7QUFBQSxJQUNOO0FBQ0EsVUFBTSxJQUFJLFFBQVEsVUFBVSxDQUFDLEtBQUssTUFBTSw0QkFBNEIsR0FBRyxTQUFTLElBQUksQ0FBQztBQUNyRixjQUFVLFFBQVEsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUVyQyxlQUFXLFFBQVEsWUFBWSxPQUFPLEVBQUcsWUFBVyxLQUFLLFNBQVMsSUFBSSxHQUFHLEtBQUssUUFBUSxJQUFJLENBQUM7QUFDM0YsWUFBUSxJQUFJLG1DQUFtQyxNQUFNLE1BQU0sTUFBTSxFQUFFO0FBQUEsRUFDckUsVUFBRTtBQUNBLFdBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2xEO0FBQ0YsU0FBUyxPQUFPO0FBQ2QsWUFBVTtBQUNWLFFBQU07QUFDUixVQUFFO0FBQ0EsUUFBTTtBQUFBLElBQ0o7QUFBQSxNQUNFLE1BQU07QUFDSixZQUFJLGVBQWdCLFFBQU8sZ0JBQWdCLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsTUFDN0U7QUFBQSxNQUNBLE1BQU07QUFDSixxQkFBYSxNQUFNO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDRjsiLCJuYW1lcyI6WyJyZXN1bHQiLCJmYWlsdXJlIiwidGFyZ2V0Il0sImZpbGUiOiJzY3JpcHRzL3JlbGVhc2UtcnVzdC5tanMifQ==
