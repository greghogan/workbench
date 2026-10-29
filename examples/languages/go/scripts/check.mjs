// Generated from check.mts; edit the TypeScript source.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const emitCheckDetail = process.env.WORKBENCH_DISTRIBUTION_ROOT
  ? (await import(pathToFileURL(join(process.env.WORKBENCH_DISTRIBUTION_ROOT, "scripts/check-detail-data.mjs")).href))
      .emitCheckDetail
  : () => void 0;
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
const role = process.argv[2];
const builds = process.env.WORKBENCH_BUILD_DIR ?? "build";
const policy = JSON.parse(readFileSync("workbench/quality.json", "utf8"));
const env = { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: `${process.env.GOFLAGS ?? ""} -mod=readonly`.trim() };
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? (result.stderr || result.status))}`);
  return result.stdout;
}
if (role === "format") {
  const files = run("gofmt", ["-l", "."], true);
  if (files.trim())
    throw new Error(`gofmt would change:
${files}`);
} else if (role === "format-write") {
  run("gofmt", ["-w", "."]);
} else if (role === "build" || role === "release") {
  const directory = `${builds}/${role === "release" ? "release" : "debug"}`;
  mkdirSync(directory, { recursive: true });
  run("go", [
    "build",
    ...(role === "release" ? ["-trimpath", "-ldflags=-s -w"] : []),
    "-o",
    `${directory}/count${process.platform === "win32" ? ".exe" : ""}`,
    "./cmd/count",
  ]);
  if (role === "release") {
    const output = process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist";
    mkdirSync(output, { recursive: true });
    const name = `count${process.platform === "win32" ? ".exe" : ""}`;
    copyFileSync(`${directory}/${name}`, `${output}/${name}`);
    copyFileSync("LICENSE", `${output}/LICENSE`);
  }
} else if (role === "lint") {
  run("go", ["mod", "verify"]);
  run("go", ["mod", "tidy", "-diff"]);
  run("go", ["vet", "./..."]);
  run("go", ["tool", "staticcheck", "-checks=all", "./..."]);
} else if (role === "test" || role === "coverage") {
  mkdirSync("coverage", { recursive: true });
  const args = [
    "test",
    "-json",
    "-count=1",
    "-timeout=0",
    "-race",
    ...(role === "coverage" ? ["-covermode=atomic", "-coverpkg=./...", "-coverprofile=coverage/profile.out"] : []),
    "./...",
  ];
  const result = spawnSync("go", args, {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync("coverage/tests.jsonl", result.stdout ?? "");
  for (const line of (result.stdout ?? "").split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.Action === "output") {
      if (typeof event.Output !== "string") throw new Error("Go output event omitted its text");
      process.stdout.write(event.Output);
    }
    if (role === "test" && event.Test && event.Elapsed !== void 0 && event.Elapsed > policy.slow_test_seconds) {
      emitCheckDetail({
        version: 1,
        kind: "slow",
        scope: "test",
        name: `${String(event.Package)}/${event.Test}`,
        elapsedSeconds: event.Elapsed,
        thresholdSeconds: policy.slow_test_seconds,
      });
      console.error(
        `SLOW ${String(event.Package)}/${event.Test}: ${String(event.Elapsed)}s (soft cap ${String(policy.slow_test_seconds)}s; advisory only)`,
      );
    }
  }
  if (result.error || result.status !== 0) throw new Error(`Go tests failed: ${String(result.error ?? result.stderr)}`);
  if (role === "coverage") {
    const report = run("go", ["tool", "cover", "-func=coverage/profile.out"], true);
    console.log(report);
    const match = /total:\s+\(statements\)\s+([\d.]+)%/.exec(report);
    if (!match || Number(match[1]) < policy.coverage.statements)
      throw new Error(`statement coverage is below ${String(policy.coverage.statements)}%`);
  }
} else {
  throw new Error("expected build, release, format, format-write, lint, test, or coverage");
}
