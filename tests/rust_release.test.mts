import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "smol-toml";
import { assertStaticElf } from "../examples/languages/rust/scripts/release-verify.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("each portable recipe uses a container toolchain for its native builder architecture", () => {
  const directory = join(repository, "examples/languages/rust");
  const recipe = JSON.parse(readFileSync(join(directory, "release-musl.json"), "utf8")) as {
    targets: Record<string, { platform: "linux-x64" | "linux-arm64" }>;
  };
  const configuration = parse(readFileSync(join(directory, "Cross.toml"), "utf8")) as {
    target: Record<string, { image: { toolchain: string[] }; dockerfile: string; runner: string }>;
  };
  for (const [target, { platform }] of Object.entries(recipe.targets)) {
    const selected = required(configuration.target, "Expected fixture value: configuration.target")[target];
    const host = { "linux-x64": "x86_64-unknown-linux-gnu", "linux-arm64": "aarch64-unknown-linux-gnu" }[platform];
    expect(host).toBeDefined();
    expect(required(selected, "Expected fixture value").image.toolchain).toEqual([host]);
    expect(existsSync(join(directory, required(selected, "Expected fixture value").dockerfile))).toBe(true);
    expect(required(selected, "Expected fixture value").runner).toBe("native");
  }
});

function elf(machine = 62, types = [1]) {
  const bytes = Buffer.alloc(256);
  bytes.set(Buffer.from("7f454c46020101", "hex"));
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(types.length, 56);
  for (const [index, type] of types.entries()) bytes.writeUInt32LE(type, 64 + index * 56);
  return bytes;
}

test("portable ELF inspection accepts static executables and PIE on their declared architecture", () => {
  for (const [machine, target] of [
    [62, "x86_64-unknown-linux-musl"],
    [183, "aarch64-unknown-linux-musl"],
  ] as const) {
    const bytes = elf(required(machine, "Expected fixture value"), [1, 2]);
    expect(() => {
      assertStaticElf(bytes, required(target, "Expected fixture value"));
    }).not.toThrow();
    bytes.writeUInt16LE(2, 16);
    expect(() => {
      assertStaticElf(bytes, required(target, "Expected fixture value"));
    }).not.toThrow();
  }
});

test("portable ELF inspection rejects dynamic interpreters, shared dependencies, wrong architectures, and malformed metadata", () => {
  const target = "x86_64-unknown-linux-musl";
  expect(() => {
    assertStaticElf(elf(62, [1, 3]), target);
  }).toThrow(/dynamic ELF interpreter/);
  const shared = elf(62, [1, 2]);
  shared.writeBigUInt64LE(224n, 128);
  shared.writeBigUInt64LE(16n, 152);
  shared.writeBigUInt64LE(1n, 224);
  expect(() => {
    assertStaticElf(shared, target);
  }).toThrow(/shared library/);
  expect(() => {
    assertStaticElf(elf(183), target);
  }).toThrow(/architecture/);
  expect(() => {
    assertStaticElf(elf(), "unknown");
  }).toThrow(/Unsupported musl target/);
  expect(() => {
    assertStaticElf(elf().subarray(0, 20), target);
  }).toThrow(/Truncated ELF header/);
  expect(() => {
    assertStaticElf(Buffer.alloc(256), target);
  }).toThrow(/64-bit little-endian/);
  const malformed = elf();
  malformed.writeBigUInt64LE(2n ** 63n, 32);
  expect(() => {
    assertStaticElf(malformed, target);
  }).toThrow(/program headers/);
  const truncated = elf();
  truncated.writeBigUInt64LE(1024n, 96);
  expect(() => {
    assertStaticElf(truncated, target);
  }).toThrow(/Truncated ELF segment/);
  expect(() => {
    assertStaticElf(elf(62, [2]), target);
  }).toThrow(/no loadable segment/);
});

test.skipIf(process.platform !== "linux").each(["foreign-target", "foreign-engine", "driver-version", "managed-shell"])(
  "portable release rejects an unsuitable builder before compiling or changing artifacts: %s",
  (outcome) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-rust-builder-"));
    temporary.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/rust-reference"), "previous verified artifact");
    cpSync(join(repository, "examples/languages/rust/release-musl.json"), join(root, "release-musl.json"));
    const executable = (name: string, source: string) => {
      writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    };
    executable("rustc", 'console.log("rustc 1.99.0\\nhost: x86_64-unknown-linux-gnu");');
    executable(
      "docker",
      `console.log(${JSON.stringify(outcome === "foreign-engine" ? "linux/other" : `linux/${process.arch === "x64" ? "amd64" : "arm64"}`)});`,
    );
    executable(
      "cross",
      `import { writeFileSync } from "node:fs";
      if (!process.argv.includes("--version")) writeFileSync("compilation-started", "yes");
      console.log("cross 0.2.4");`,
    );
    const target =
      outcome === "foreign-target"
        ? process.arch === "x64"
          ? "aarch64"
          : "x86_64"
        : process.arch === "x64"
          ? "x86_64"
          : "aarch64";
    const result = spawnSync(
      process.execPath,
      [join(repository, "scripts/release-rust.mjs"), "--target", `${target}-unknown-linux-musl`],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${String(process.env.PATH)}`,
          WORKBENCH_RELEASE_OUTPUT: join(root, "dist"),
          WORKBENCH_SHELL_ENVIRONMENT: outcome === "managed-shell" ? "guix" : "native",
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      required(
        {
          "foreign-target": /native Linux architecture builder/,
          "foreign-engine": /Docker engine .* requires emulation/,
          "driver-version": /expected cross 0.2.5, found 0.2.4/,
          "managed-shell": /managed releases retain their own tool authority/,
        }[outcome],
        "Expected fixture value",
      ),
    );
    expect(existsSync(join(root, "compilation-started"))).toBe(false);
    expect(readFileSync(join(root, "dist/rust-reference"), "utf8")).toBe("previous verified artifact");
  },
);

// Cargo is the external build boundary. Produced executables and the real release verifier establish the outcome.
test
  .skipIf(process.platform === "win32")
  .each(["success", "tests-fail", "doctests-fail", "build-fails", "standalone-fails", "no-binaries"])(
  "Rust native release tests and verifies before replacing an accepted artifact: %s",
  (outcome) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-rust-release-"));
    temporary.push(root);
    const bin = join(root, "bin");
    const output = join(root, "dist");
    mkdirSync(bin);
    mkdirSync(output);
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "LICENSE"), "project license");
    writeFileSync(join(output, "rust-reference"), "previous verified artifact");
    writeFileSync(join(output, "notes.txt"), "unrelated user file");
    cpSync(
      join(repository, "examples/languages/rust/scripts/release-verify.mjs"),
      join(root, "scripts/release-verify.mjs"),
    );
    const executable = (name: string, source: string) => {
      writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    };
    executable("rustc", 'console.log("rustc 1.99.0\\nhost: x86_64-unknown-linux-gnu");');
    const application = `#!${process.execPath}\nconst sum = BigInt(process.argv[2]) + BigInt(process.argv[3]);
      if (sum > 18446744073709551615n) { console.error("error: sum exceeds the maximum unsigned 64-bit integer"); process.exitCode = 1; }
      else console.log(${outcome === "standalone-fails" ? '"wrong"' : "String(sum)"});\n`;
    executable(
      "cargo",
      `import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const args = process.argv.slice(2);
      if (args[0] === "test") process.exit(${JSON.stringify(outcome)} === (args.includes("--doc") ? "doctests-fail" : "tests-fail") ? 8 : 0);
      if (${JSON.stringify(outcome)} === "build-fails") process.exit(7);
      const directory = join(args[args.indexOf("--target-dir") + 1], args[args.indexOf("--target") + 1], "release");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "rust-reference"), ${JSON.stringify(application)}, { mode: 0o755 });
      console.log(JSON.stringify({ reason: "compiler-artifact", target: { kind: ["bin"] }, executable: ${outcome === "no-binaries" ? "null" : '"/container-target/release/rust-reference"'} }));`,
    );
    const result = spawnSync(process.execPath, [join(repository, "scripts/release-rust.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${String(process.env.PATH)}`,
        CARGO_TARGET_DIR: join(root, "build"),
        WORKBENCH_RELEASE_OUTPUT: output,
      },
      encoding: "utf8",
    });
    expect(readFileSync(join(output, "notes.txt"), "utf8")).toBe("unrelated user file");
    if (outcome === "success") {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(output, "LICENSE"), "utf8")).toBe("project license");
      expect(JSON.parse(readFileSync(join(output, "rust-release.json"), "utf8"))).toEqual({
        target: "x86_64-unknown-linux-gnu",
        binaries: ["rust-reference"],
      });
      expect(spawnSync(join(output, "rust-reference"), ["20", "22"], { encoding: "utf8" }).stdout).toBe("42\n");
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        outcome === "standalone-fails"
          ? /Standalone release result/
          : outcome === "no-binaries"
            ? /no executable artifacts/
            : /Rust release: cargo .* failed/,
      );
      expect(readFileSync(join(output, "rust-reference"), "utf8")).toBe("previous verified artifact");
      expect(existsSync(join(output, "rust-release.json"))).toBe(false);
    }
  },
);
