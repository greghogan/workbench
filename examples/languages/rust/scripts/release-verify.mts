import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PortableTarget {
  platform: string;
  cpu_baseline: string;
  kernel_baseline: string;
  verification_images: string[];
}
interface PortableRecipe {
  cross_version: string;
  cross_revision: string;
  targets: Record<string, PortableTarget>;
}
interface ReleaseManifest extends Partial<PortableTarget> {
  target: string;
  cross_version?: string;
  cross_revision?: string;
}

function run(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`Release artifact check failed: ${String(result.error ?? (result.stderr || result.status))}`);
  return result.stdout;
}

/** Inspect ELF metadata before execution; static PIE may have PT_DYNAMIC but cannot need shared libraries. */
export function assertStaticElf(bytes: Buffer, target: string) {
  const machines: Record<string, number> = { "x86_64-unknown-linux-musl": 62, "aarch64-unknown-linux-musl": 183 };
  const machine = machines[target];
  assert.ok(machine, "Unsupported musl target");
  assert.ok(bytes.length >= 64, "Truncated ELF header");
  assert.equal(bytes.subarray(0, 7).toString("hex"), "7f454c46020101", "Expected a 64-bit little-endian ELF");
  assert.ok([2, 3].includes(bytes.readUInt16LE(16)), "Expected an ELF executable or PIE");
  assert.equal(bytes.readUInt16LE(18), machine, "Release architecture differs from its target");
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  assert.ok(
    Number.isSafeInteger(offset) &&
      offset >= 64 &&
      size >= 56 &&
      count > 0 &&
      count < 65535 &&
      offset + size * count <= bytes.length,
    "Invalid ELF program headers",
  );
  let loadable = false;
  for (let index = 0; index < count; index++) {
    const header = offset + index * size;
    const type = bytes.readUInt32LE(header);
    const start = Number(bytes.readBigUInt64LE(header + 8));
    const length = Number(bytes.readBigUInt64LE(header + 32));
    assert.ok(
      Number.isSafeInteger(start) && Number.isSafeInteger(length) && start + length <= bytes.length,
      "Truncated ELF segment",
    );
    assert.notEqual(type, 3, "Portable release has a dynamic ELF interpreter");
    if (type === 1) loadable = true;
    if (type === 2) {
      assert.equal(length % 16, 0, "Invalid ELF dynamic entries");
      for (let entry = start; entry < start + length; entry += 16) {
        const tag = bytes.readBigUInt64LE(entry);
        if (tag === 0n) break;
        assert.notEqual(tag, 1n, "Portable release needs a shared library");
      }
    }
  }
  assert.ok(loadable, "ELF has no loadable segment");
}

export function verifyRustRelease(artifacts: string, root: string) {
  const manifest = JSON.parse(readFileSync(join(artifacts, "rust-release.json"), "utf8")) as ReleaseManifest;
  const portable = manifest.target.endsWith("-linux-musl");
  const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  try {
    const executable = join(temporary, `rust-reference${suffix}`);
    cpSync(join(artifacts, `rust-reference${suffix}`), executable);
    if (portable) {
      const recipe = JSON.parse(readFileSync(join(root, "release-musl.json"), "utf8")) as PortableRecipe;
      const selected = recipe.targets[manifest.target];
      assert.ok(
        selected?.platform === `${process.platform}-${process.arch}`,
        "Portable verification requires its native architecture; no emulation",
      );
      for (const key of ["platform", "cpu_baseline", "kernel_baseline", "verification_images"] as const)
        assert.deepEqual(manifest[key], selected[key], `Release ${key} differs from its recipe`);
      assert.equal(manifest.cross_version, recipe.cross_version, "Release cross version differs from its recipe");
      assert.equal(manifest.cross_revision, recipe.cross_revision, "Release cross revision differs from its recipe");
      assertStaticElf(readFileSync(executable), manifest.target);
      assert.ok(process.getuid && process.getgid, "Portable Linux verification requires Unix user identities");
      for (const image of selected.verification_images) {
        assert.match(image, /@sha256:[a-f0-9]{64}$/, "Verification images must be pinned by digest");
        const architecture = process.arch === "x64" ? "amd64" : "arm64";
        run("docker", ["pull", "--platform", `linux/${architecture}`, image], temporary);
        assert.equal(
          run("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], temporary).trim(),
          `linux/${architecture}`,
          "Verification image requires emulation",
        );
        run(
          "docker",
          [
            "run",
            "--rm",
            "--platform",
            `linux/${architecture}`,
            "--user",
            `${String(process.getuid())}:${String(process.getgid())}`,
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=16m",
            "--mount",
            `type=bind,source=${temporary},target=/artifacts,readonly`,
            "--entrypoint",
            "/bin/sh",
            image,
            "-eu",
            "-c",
            'test "$(/artifacts/rust-reference 20 22)" = 42\ntest "$(/artifacts/rust-reference 0 0)" = 0\nset +e\n/artifacts/rust-reference 18446744073709551615 1 >/tmp/out 2>/tmp/err\nstatus=$?\nset -e\ntest "$status" = 1\ntest ! -s /tmp/out\ngrep -Fx "error: sum exceeds the maximum unsigned 64-bit integer" /tmp/err\nset +e\nNO_COLOR=1 /artifacts/rust-reference invalid 2 >/tmp/out 2>/tmp/err\nstatus=$?\nset -e\ntest "$status" = 2\ntest ! -s /tmp/out\ngrep -F "invalid digit found in string" /tmp/err',
          ],
          temporary,
        );
        console.log(`Verified static ${manifest.target} behavior offline in ${image}.`);
      }
    } else {
      assert.equal(run(executable, ["20", "22"], temporary), "42\n", "Standalone release result");
      assert.equal(run(executable, ["0", "0"], temporary), "0\n", "Standalone zero result");
      const overflow = spawnSync(executable, ["18446744073709551615", "1"], { cwd: temporary, encoding: "utf8" });
      assert.equal(overflow.status, 1, "Standalone overflow status");
      assert.equal(overflow.stdout, "", "Standalone overflow output");
      assert.equal(
        overflow.stderr,
        "error: sum exceeds the maximum unsigned 64-bit integer\n",
        "Standalone overflow diagnostic",
      );
    }
    console.log(`Verified release artifacts from ${root} outside the source checkout.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[3] ?? process.cwd());
  verifyRustRelease(resolve(process.argv[2] ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist")), root);
}
