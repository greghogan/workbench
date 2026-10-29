import assert from "node:assert/strict";
import { existsSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withEngineeringRun } from "./engineering-run.mjs";
import { optimizationInputs, publishOptimization, fileSHA256 } from "./optimization-artifact.mjs";
const language = process.argv[2];
if (language !== "rust" && language !== "go") throw new Error("Select the rust or go PGO example");
const builds = process.env.WORKBENCH_BUILD_DIR;
if (!builds) throw new Error("Run PGO through a configured Workbench check or shell");
const output = join(builds, "pgo");
const suffix = process.platform === "win32" ? ".exe" : "";

await withEngineeringRun(builds, "pgo", async (job) => {
  const run = (command: string, args: string[], env = process.env) => job.run(command, args, { env, capture: true });
  const inputs = await optimizationInputs(job, process.cwd(), builds, fileURLToPath(import.meta.url));
  const name = `${language === "go" ? "count" : "rust-reference"}${suffix}`;
  await publishOptimization(job, output, name, async (stage) => {
    const scratch = job.directory;
    let mergerVersion: string | undefined;
    let executable: string, compiler: string, profile: string;
    if (language === "go") {
      compiler = (await run("go", ["version"])).trim();
      profile = join(scratch, "cpu.pprof");
      await run("go", [
        "test",
        "-pgo=off",
        "-run=^$",
        "-bench=BenchmarkCountByte",
        "-benchtime=2s",
        "-cpuprofile",
        profile,
        "-o",
        join(scratch, `training.test${suffix}`),
        ".",
      ]);
      assert.ok(
        existsSync(profile) &&
          (await fileSHA256(profile)) !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "Go training produced no CPU profile",
      );
      executable = join(scratch, `count${suffix}`);
      await run("go", ["build", "-trimpath", `-pgo=${profile}`, "-o", executable, "./cmd/count"]);
      await run("go", ["test", "-count=1", `-pgo=${profile}`, "./..."]);
      assert.equal((await run(executable, ["r", "cherry"])).trim(), "2", "Independent optimized Go result");
    } else {
      compiler = (await run("rustc", ["-vV"])).trim();
      const sysroot = (await run("rustc", ["--print", "sysroot"])).trim();
      const host = /^host: (.+)$/m.exec(compiler)?.[1];
      if (!host) throw new Error("Rust did not identify its native target");
      const bundled = join(sysroot, "lib/rustlib", host, "bin", `llvm-profdata${suffix}`);
      const merger = process.env.LLVM_PROFDATA ?? (existsSync(bundled) ? bundled : "llvm-profdata");
      const rustLLVM = /^LLVM version: (\d+)/m.exec(compiler)?.[1];
      mergerVersion = (await run(merger, ["--version"])).trim();
      assert.ok(
        rustLLVM && new RegExp(`LLVM version ${rustLLVM}\\.`, "i").test(mergerVersion),
        "PGO requires llvm-profdata matching Rust's LLVM major",
      );
      const profiles = join(scratch, "profiles");
      mkdirSync(profiles);
      const inherited =
        process.env.CARGO_ENCODED_RUSTFLAGS?.split("\u001f") ??
        (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
      if (inherited.some((flag) => /profile-(?:use|generate)|instrument-coverage/.test(flag)))
        throw new Error("PGO requires a build separate from existing profile or coverage instrumentation");
      const environment = (flag: string) => {
        const env = {
          ...process.env,
          CARGO_ENCODED_RUSTFLAGS: [...inherited, flag].join("\u001f"),
          LLVM_PROFILE_FILE: join(profiles, "%p-%m.profraw"),
        };
        Reflect.deleteProperty(env, "RUSTFLAGS");
        return env;
      };
      const training = join(scratch, "generate"),
        optimized = join(scratch, "use");
      const generate = environment(`-Cprofile-generate=${profiles}`);
      await run("cargo", ["test", "--release", "--locked", "--all-targets", "--target-dir", training], generate);
      await run("cargo", ["build", "--release", "--locked", "--target-dir", training], generate);
      await run(join(training, "release", `rust-reference${suffix}`), ["4", "5"], generate);
      const raw = readdirSync(profiles)
        .filter((name) => name.endsWith(".profraw"))
        .map((name) => join(profiles, name));
      assert.ok(raw.length, "Rust training produced no compiler profiles");
      profile = join(profiles, "merged.profdata");
      await run(merger, ["merge", "-o", profile, ...raw]);
      const use = environment(`-Cprofile-use=${profile}`);
      await run("cargo", ["build", "--release", "--locked", "--target-dir", optimized], use);
      await run("cargo", ["test", "--release", "--locked", "--all-targets", "--target-dir", optimized], use);
      executable = join(optimized, "release", `rust-reference${suffix}`);
      assert.equal((await run(executable, ["6", "7"], use)).trim(), "13", "Independent optimized Rust result");
    }
    copyFileSync(executable, join(stage, name));
    assert.equal(
      (
        await job.run(join(stage, name), language === "go" ? ["z", "pizza"] : ["20", "22"], {
          cwd: stage,
          capture: true,
        })
      ).trim(),
      language === "go" ? "2" : "42",
    );
    assert.deepEqual(
      await optimizationInputs(job, process.cwd(), builds, fileURLToPath(import.meta.url)),
      inputs,
      "PGO source inputs changed during training or verification",
    );
    return {
      language,
      compiler,
      mergerVersion,
      inputs,
      platform: `${process.platform}-${process.arch}`,
      training: language === "go" ? "BenchmarkCountByte" : "canonical tests and CLI workload",
      profile: { sha256: await fileSHA256(profile) },
      verification: "complete optimized tests and independent relocated CLI results",
    };
  });
});
