// Generated from release-verify.mts; edit the TypeScript source.

// scripts/elf.mts
import assert from "node:assert/strict";
function decodeElf(bytes) {
  assert.ok(bytes.length >= 64, "Truncated ELF header");
  assert.equal(bytes.subarray(0, 7).toString("hex"), "7f454c46020101", "Expected a 64-bit little-endian ELF");
  const type = bytes.readUInt16LE(16),
    machine = bytes.readUInt16LE(18);
  assert.ok([2, 3].includes(type), "Expected an ELF executable or PIE");
  assert.ok([62, 183].includes(machine), "Unsupported ELF machine");
  assert.equal(bytes.readUInt32LE(20), 1, "Invalid ELF version");
  assert.equal(bytes.readUInt16LE(52), 64, "Invalid ELF header size");
  const offset = Number(bytes.readBigUInt64LE(32)),
    size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  assert.ok(
    Number.isSafeInteger(offset) &&
      offset >= 64 &&
      size >= 56 &&
      count > 0 &&
      count < 65535 &&
      offset + size * count <= bytes.length,
    "Invalid ELF program headers",
  );
  const segments = [],
    dynamic = [];
  for (let index = 0; index < count; index++) {
    const at = offset + index * size;
    const segment = {
      type: bytes.readUInt32LE(at),
      flags: bytes.readUInt32LE(at + 4),
      offset: Number(bytes.readBigUInt64LE(at + 8)),
      length: Number(bytes.readBigUInt64LE(at + 32)),
    };
    assert.ok(
      Number.isSafeInteger(segment.offset) &&
        Number.isSafeInteger(segment.length) &&
        segment.offset + segment.length <= bytes.length,
      "Truncated ELF segment or dynamic entries",
    );
    segments.push(segment);
    if (segment.type === 2) {
      assert.equal(segment.length % 16, 0, "Invalid ELF dynamic entries");
      let terminated = false;
      for (let at2 = segment.offset; at2 < segment.offset + segment.length; at2 += 16) {
        const tag = bytes.readBigUInt64LE(at2),
          value = bytes.readBigUInt64LE(at2 + 8);
        if (tag === 0n) {
          terminated = true;
          break;
        }
        dynamic.push({ tag, value });
      }
      assert.ok(terminated, "Unterminated ELF dynamic entries");
    }
  }
  return { type, machine, segments, dynamic };
}

// examples/languages/rust/scripts/release-verify.mts
import assert2 from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error("Release artifact check failed: ".concat(String(result.error ?? (result.stderr || result.status))));
  return result.stdout;
}
function assertStaticElf(bytes, target) {
  const machines = { "x86_64-unknown-linux-musl": 62, "aarch64-unknown-linux-musl": 183 };
  const machine = machines[target];
  assert2.ok(machine, "Unsupported musl target");
  const elf = decodeElf(bytes);
  assert2.equal(elf.machine, machine, "Release architecture differs from its target");
  assert2.ok(
    elf.segments.some((segment) => segment.type === 1),
    "ELF has no loadable segment",
  );
  assert2.ok(
    elf.segments.every((segment) => segment.type !== 3),
    "Portable release has a dynamic ELF interpreter",
  );
  assert2.ok(
    elf.dynamic.every((entry) => entry.tag !== 1n),
    "Portable release needs a shared library",
  );
}
function verifyRustRelease(artifacts, root) {
  const manifest = JSON.parse(readFileSync(join(artifacts, "rust-release.json"), "utf8"));
  const portable = manifest.target.endsWith("-linux-musl");
  const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  try {
    const executable = join(temporary, "rust-reference".concat(suffix));
    cpSync(join(artifacts, "rust-reference".concat(suffix)), executable);
    if (portable) {
      const recipe = JSON.parse(readFileSync(join(root, "release-musl.json"), "utf8"));
      const selected = recipe.targets[manifest.target];
      assert2.ok(
        selected?.platform === "".concat(process.platform, "-").concat(process.arch),
        "Portable verification requires its native architecture; no emulation",
      );
      for (const key of ["platform", "cpu_baseline", "kernel_baseline", "verification_images"])
        assert2.deepEqual(manifest[key], selected[key], "Release ".concat(key, " differs from its recipe"));
      assert2.equal(manifest.cross_version, recipe.cross_version, "Release cross version differs from its recipe");
      assert2.equal(manifest.cross_revision, recipe.cross_revision, "Release cross revision differs from its recipe");
      assertStaticElf(readFileSync(executable), manifest.target);
      assert2.ok(process.getuid && process.getgid, "Portable Linux verification requires Unix user identities");
      for (const image of selected.verification_images) {
        assert2.match(image, /@sha256:[a-f0-9]{64}$/, "Verification images must be pinned by digest");
        const architecture = process.arch === "x64" ? "amd64" : "arm64";
        run("docker", ["pull", "--platform", "linux/".concat(architecture), image], temporary);
        assert2.equal(
          run("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], temporary).trim(),
          "linux/".concat(architecture),
          "Verification image requires emulation",
        );
        run(
          "docker",
          [
            "run",
            "--rm",
            "--platform",
            "linux/".concat(architecture),
            "--user",
            "".concat(String(process.getuid()), ":").concat(String(process.getgid())),
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=16m",
            "--mount",
            "type=bind,source=".concat(temporary, ",target=/artifacts,readonly"),
            "--entrypoint",
            "/bin/sh",
            image,
            "-eu",
            "-c",
            'test "$(/artifacts/rust-reference 20 22)" = 42\ntest "$(/artifacts/rust-reference 0 0)" = 0\nset +e\n/artifacts/rust-reference 18446744073709551615 1 >/tmp/out 2>/tmp/err\nstatus=$?\nset -e\ntest "$status" = 1\ntest ! -s /tmp/out\ngrep -Fx "error: sum exceeds the maximum unsigned 64-bit integer" /tmp/err\nset +e\nNO_COLOR=1 /artifacts/rust-reference invalid 2 >/tmp/out 2>/tmp/err\nstatus=$?\nset -e\ntest "$status" = 2\ntest ! -s /tmp/out\ngrep -F "invalid digit found in string" /tmp/err',
          ],
          temporary,
        );
        console.log("Verified static ".concat(manifest.target, " behavior offline in ").concat(image, "."));
      }
    } else {
      assert2.equal(run(executable, ["20", "22"], temporary), "42\n", "Standalone release result");
      assert2.equal(run(executable, ["0", "0"], temporary), "0\n", "Standalone zero result");
      const overflow = spawnSync(executable, ["18446744073709551615", "1"], { cwd: temporary, encoding: "utf8" });
      assert2.equal(overflow.status, 1, "Standalone overflow status");
      assert2.equal(overflow.stdout, "", "Standalone overflow output");
      assert2.equal(
        overflow.stderr,
        "error: sum exceeds the maximum unsigned 64-bit integer\n",
        "Standalone overflow diagnostic",
      );
    }
    console.log("Verified release artifacts from ".concat(root, " outside the source checkout."));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[3] ?? process.cwd());
  verifyRustRelease(resolve(process.argv[2] ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist")), root);
}
export { assertStaticElf, verifyRustRelease };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NjcmlwdHMvZWxmLm10cyIsInJlbGVhc2UtdmVyaWZ5Lm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuZXhwb3J0IGludGVyZmFjZSBFbGZTZWdtZW50IHtcbiAgdHlwZTogbnVtYmVyO1xuICBmbGFnczogbnVtYmVyO1xuICBvZmZzZXQ6IG51bWJlcjtcbiAgbGVuZ3RoOiBudW1iZXI7XG59XG5leHBvcnQgaW50ZXJmYWNlIEVsZkR5bmFtaWNFbnRyeSB7XG4gIHRhZzogYmlnaW50O1xuICB2YWx1ZTogYmlnaW50O1xufVxuZXhwb3J0IGludGVyZmFjZSBFbGZFeGVjdXRhYmxlIHtcbiAgdHlwZTogbnVtYmVyO1xuICBtYWNoaW5lOiBudW1iZXI7XG4gIHNlZ21lbnRzOiBFbGZTZWdtZW50W107XG4gIGR5bmFtaWM6IEVsZkR5bmFtaWNFbnRyeVtdO1xufVxuLyoqIERlY29kZSB0aGUgc3VwcG9ydGVkIEVMRjY0IGxpdHRsZS1lbmRpYW4gc3Vic2V0IG9uY2U7IGNvbnN1bWVycyBhcHBseSB0aGVpciBvd24gcmVsZWFzZSBwb2xpY2llcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWNvZGVFbGYoYnl0ZXM6IEJ1ZmZlcik6IEVsZkV4ZWN1dGFibGUge1xuICBhc3NlcnQub2soYnl0ZXMubGVuZ3RoID49IDY0LCBcIlRydW5jYXRlZCBFTEYgaGVhZGVyXCIpO1xuICBhc3NlcnQuZXF1YWwoYnl0ZXMuc3ViYXJyYXkoMCwgNykudG9TdHJpbmcoXCJoZXhcIiksIFwiN2Y0NTRjNDYwMjAxMDFcIiwgXCJFeHBlY3RlZCBhIDY0LWJpdCBsaXR0bGUtZW5kaWFuIEVMRlwiKTtcbiAgY29uc3QgdHlwZSA9IGJ5dGVzLnJlYWRVSW50MTZMRSgxNiksXG4gICAgbWFjaGluZSA9IGJ5dGVzLnJlYWRVSW50MTZMRSgxOCk7XG4gIGFzc2VydC5vayhbMiwgM10uaW5jbHVkZXModHlwZSksIFwiRXhwZWN0ZWQgYW4gRUxGIGV4ZWN1dGFibGUgb3IgUElFXCIpO1xuICBhc3NlcnQub2soWzYyLCAxODNdLmluY2x1ZGVzKG1hY2hpbmUpLCBcIlVuc3VwcG9ydGVkIEVMRiBtYWNoaW5lXCIpO1xuICBhc3NlcnQuZXF1YWwoYnl0ZXMucmVhZFVJbnQzMkxFKDIwKSwgMSwgXCJJbnZhbGlkIEVMRiB2ZXJzaW9uXCIpO1xuICBhc3NlcnQuZXF1YWwoYnl0ZXMucmVhZFVJbnQxNkxFKDUyKSwgNjQsIFwiSW52YWxpZCBFTEYgaGVhZGVyIHNpemVcIik7XG4gIGNvbnN0IG9mZnNldCA9IE51bWJlcihieXRlcy5yZWFkQmlnVUludDY0TEUoMzIpKSxcbiAgICBzaXplID0gYnl0ZXMucmVhZFVJbnQxNkxFKDU0KSxcbiAgICBjb3VudCA9IGJ5dGVzLnJlYWRVSW50MTZMRSg1Nik7XG4gIGFzc2VydC5vayhcbiAgICBOdW1iZXIuaXNTYWZlSW50ZWdlcihvZmZzZXQpICYmXG4gICAgICBvZmZzZXQgPj0gNjQgJiZcbiAgICAgIHNpemUgPj0gNTYgJiZcbiAgICAgIGNvdW50ID4gMCAmJlxuICAgICAgY291bnQgPCA2NTUzNSAmJlxuICAgICAgb2Zmc2V0ICsgc2l6ZSAqIGNvdW50IDw9IGJ5dGVzLmxlbmd0aCxcbiAgICBcIkludmFsaWQgRUxGIHByb2dyYW0gaGVhZGVyc1wiLFxuICApO1xuICBjb25zdCBzZWdtZW50czogRWxmU2VnbWVudFtdID0gW10sXG4gICAgZHluYW1pYzogRWxmRHluYW1pY0VudHJ5W10gPSBbXTtcbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGNvdW50OyBpbmRleCsrKSB7XG4gICAgY29uc3QgYXQgPSBvZmZzZXQgKyBpbmRleCAqIHNpemU7XG4gICAgY29uc3Qgc2VnbWVudCA9IHtcbiAgICAgIHR5cGU6IGJ5dGVzLnJlYWRVSW50MzJMRShhdCksXG4gICAgICBmbGFnczogYnl0ZXMucmVhZFVJbnQzMkxFKGF0ICsgNCksXG4gICAgICBvZmZzZXQ6IE51bWJlcihieXRlcy5yZWFkQmlnVUludDY0TEUoYXQgKyA4KSksXG4gICAgICBsZW5ndGg6IE51bWJlcihieXRlcy5yZWFkQmlnVUludDY0TEUoYXQgKyAzMikpLFxuICAgIH07XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgTnVtYmVyLmlzU2FmZUludGVnZXIoc2VnbWVudC5vZmZzZXQpICYmXG4gICAgICAgIE51bWJlci5pc1NhZmVJbnRlZ2VyKHNlZ21lbnQubGVuZ3RoKSAmJlxuICAgICAgICBzZWdtZW50Lm9mZnNldCArIHNlZ21lbnQubGVuZ3RoIDw9IGJ5dGVzLmxlbmd0aCxcbiAgICAgIFwiVHJ1bmNhdGVkIEVMRiBzZWdtZW50IG9yIGR5bmFtaWMgZW50cmllc1wiLFxuICAgICk7XG4gICAgc2VnbWVudHMucHVzaChzZWdtZW50KTtcbiAgICBpZiAoc2VnbWVudC50eXBlID09PSAyKSB7XG4gICAgICBhc3NlcnQuZXF1YWwoc2VnbWVudC5sZW5ndGggJSAxNiwgMCwgXCJJbnZhbGlkIEVMRiBkeW5hbWljIGVudHJpZXNcIik7XG4gICAgICBsZXQgdGVybWluYXRlZCA9IGZhbHNlO1xuICAgICAgZm9yIChsZXQgYXQgPSBzZWdtZW50Lm9mZnNldDsgYXQgPCBzZWdtZW50Lm9mZnNldCArIHNlZ21lbnQubGVuZ3RoOyBhdCArPSAxNikge1xuICAgICAgICBjb25zdCB0YWcgPSBieXRlcy5yZWFkQmlnVUludDY0TEUoYXQpLFxuICAgICAgICAgIHZhbHVlID0gYnl0ZXMucmVhZEJpZ1VJbnQ2NExFKGF0ICsgOCk7XG4gICAgICAgIGlmICh0YWcgPT09IDBuKSB7XG4gICAgICAgICAgdGVybWluYXRlZCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgZHluYW1pYy5wdXNoKHsgdGFnLCB2YWx1ZSB9KTtcbiAgICAgIH1cbiAgICAgIGFzc2VydC5vayh0ZXJtaW5hdGVkLCBcIlVudGVybWluYXRlZCBFTEYgZHluYW1pYyBlbnRyaWVzXCIpO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyB0eXBlLCBtYWNoaW5lLCBzZWdtZW50cywgZHluYW1pYyB9O1xufVxuIiwiaW1wb3J0IHsgZGVjb2RlRWxmIH0gZnJvbSBcIi4uLy4uLy4uLy4uL3NjcmlwdHMvZWxmLm1qc1wiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBjcFN5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuaW50ZXJmYWNlIFBvcnRhYmxlVGFyZ2V0IHtcbiAgcGxhdGZvcm06IHN0cmluZztcbiAgY3B1X2Jhc2VsaW5lOiBzdHJpbmc7XG4gIGtlcm5lbF9iYXNlbGluZTogc3RyaW5nO1xuICB2ZXJpZmljYXRpb25faW1hZ2VzOiBzdHJpbmdbXTtcbn1cbmludGVyZmFjZSBQb3J0YWJsZVJlY2lwZSB7XG4gIGNyb3NzX3ZlcnNpb246IHN0cmluZztcbiAgY3Jvc3NfcmV2aXNpb246IHN0cmluZztcbiAgdGFyZ2V0czogUmVjb3JkPHN0cmluZywgUG9ydGFibGVUYXJnZXQ+O1xufVxuaW50ZXJmYWNlIFJlbGVhc2VNYW5pZmVzdCBleHRlbmRzIFBhcnRpYWw8UG9ydGFibGVUYXJnZXQ+IHtcbiAgdGFyZ2V0OiBzdHJpbmc7XG4gIGNyb3NzX3ZlcnNpb24/OiBzdHJpbmc7XG4gIGNyb3NzX3JldmlzaW9uPzogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSwgY3dkOiBzdHJpbmcpIHtcbiAgY29uc3QgcmVzdWx0ID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHsgY3dkLCBlbmNvZGluZzogXCJ1dGY4XCIgfSk7XG4gIGlmIChyZXN1bHQuZXJyb3IgfHwgcmVzdWx0LnN0YXR1cyAhPT0gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFJlbGVhc2UgYXJ0aWZhY3QgY2hlY2sgZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gKHJlc3VsdC5zdGRlcnIgfHwgcmVzdWx0LnN0YXR1cykpfWApO1xuICByZXR1cm4gcmVzdWx0LnN0ZG91dDtcbn1cblxuLyoqIEluc3BlY3QgRUxGIG1ldGFkYXRhIGJlZm9yZSBleGVjdXRpb247IHN0YXRpYyBQSUUgbWF5IGhhdmUgUFRfRFlOQU1JQyBidXQgY2Fubm90IG5lZWQgc2hhcmVkIGxpYnJhcmllcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRTdGF0aWNFbGYoYnl0ZXM6IEJ1ZmZlciwgdGFyZ2V0OiBzdHJpbmcpIHtcbiAgY29uc3QgbWFjaGluZXM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IFwieDg2XzY0LXVua25vd24tbGludXgtbXVzbFwiOiA2MiwgXCJhYXJjaDY0LXVua25vd24tbGludXgtbXVzbFwiOiAxODMgfTtcbiAgY29uc3QgbWFjaGluZSA9IG1hY2hpbmVzW3RhcmdldF07XG4gIGFzc2VydC5vayhtYWNoaW5lLCBcIlVuc3VwcG9ydGVkIG11c2wgdGFyZ2V0XCIpO1xuICBjb25zdCBlbGYgPSBkZWNvZGVFbGYoYnl0ZXMpO1xuICBhc3NlcnQuZXF1YWwoZWxmLm1hY2hpbmUsIG1hY2hpbmUsIFwiUmVsZWFzZSBhcmNoaXRlY3R1cmUgZGlmZmVycyBmcm9tIGl0cyB0YXJnZXRcIik7XG4gIGFzc2VydC5vayhcbiAgICBlbGYuc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudC50eXBlID09PSAxKSxcbiAgICBcIkVMRiBoYXMgbm8gbG9hZGFibGUgc2VnbWVudFwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgZWxmLnNlZ21lbnRzLmV2ZXJ5KChzZWdtZW50KSA9PiBzZWdtZW50LnR5cGUgIT09IDMpLFxuICAgIFwiUG9ydGFibGUgcmVsZWFzZSBoYXMgYSBkeW5hbWljIEVMRiBpbnRlcnByZXRlclwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgZWxmLmR5bmFtaWMuZXZlcnkoKGVudHJ5KSA9PiBlbnRyeS50YWcgIT09IDFuKSxcbiAgICBcIlBvcnRhYmxlIHJlbGVhc2UgbmVlZHMgYSBzaGFyZWQgbGlicmFyeVwiLFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdmVyaWZ5UnVzdFJlbGVhc2UoYXJ0aWZhY3RzOiBzdHJpbmcsIHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBtYW5pZmVzdCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oYXJ0aWZhY3RzLCBcInJ1c3QtcmVsZWFzZS5qc29uXCIpLCBcInV0ZjhcIikpIGFzIFJlbGVhc2VNYW5pZmVzdDtcbiAgY29uc3QgcG9ydGFibGUgPSBtYW5pZmVzdC50YXJnZXQuZW5kc1dpdGgoXCItbGludXgtbXVzbFwiKTtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtcmVsZWFzZS1jaGVjay1cIikpO1xuICBjb25zdCBzdWZmaXggPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcIi5leGVcIiA6IFwiXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgZXhlY3V0YWJsZSA9IGpvaW4odGVtcG9yYXJ5LCBgcnVzdC1yZWZlcmVuY2Uke3N1ZmZpeH1gKTtcbiAgICBjcFN5bmMoam9pbihhcnRpZmFjdHMsIGBydXN0LXJlZmVyZW5jZSR7c3VmZml4fWApLCBleGVjdXRhYmxlKTtcbiAgICBpZiAocG9ydGFibGUpIHtcbiAgICAgIGNvbnN0IHJlY2lwZSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJyZWxlYXNlLW11c2wuanNvblwiKSwgXCJ1dGY4XCIpKSBhcyBQb3J0YWJsZVJlY2lwZTtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID0gcmVjaXBlLnRhcmdldHNbbWFuaWZlc3QudGFyZ2V0XTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgc2VsZWN0ZWQ/LnBsYXRmb3JtID09PSBgJHtwcm9jZXNzLnBsYXRmb3JtfS0ke3Byb2Nlc3MuYXJjaH1gLFxuICAgICAgICBcIlBvcnRhYmxlIHZlcmlmaWNhdGlvbiByZXF1aXJlcyBpdHMgbmF0aXZlIGFyY2hpdGVjdHVyZTsgbm8gZW11bGF0aW9uXCIsXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgW1wicGxhdGZvcm1cIiwgXCJjcHVfYmFzZWxpbmVcIiwgXCJrZXJuZWxfYmFzZWxpbmVcIiwgXCJ2ZXJpZmljYXRpb25faW1hZ2VzXCJdIGFzIGNvbnN0KVxuICAgICAgICBhc3NlcnQuZGVlcEVxdWFsKG1hbmlmZXN0W2tleV0sIHNlbGVjdGVkW2tleV0sIGBSZWxlYXNlICR7a2V5fSBkaWZmZXJzIGZyb20gaXRzIHJlY2lwZWApO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1hbmlmZXN0LmNyb3NzX3ZlcnNpb24sIHJlY2lwZS5jcm9zc192ZXJzaW9uLCBcIlJlbGVhc2UgY3Jvc3MgdmVyc2lvbiBkaWZmZXJzIGZyb20gaXRzIHJlY2lwZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChtYW5pZmVzdC5jcm9zc19yZXZpc2lvbiwgcmVjaXBlLmNyb3NzX3JldmlzaW9uLCBcIlJlbGVhc2UgY3Jvc3MgcmV2aXNpb24gZGlmZmVycyBmcm9tIGl0cyByZWNpcGVcIik7XG4gICAgICBhc3NlcnRTdGF0aWNFbGYocmVhZEZpbGVTeW5jKGV4ZWN1dGFibGUpLCBtYW5pZmVzdC50YXJnZXQpO1xuICAgICAgYXNzZXJ0Lm9rKHByb2Nlc3MuZ2V0dWlkICYmIHByb2Nlc3MuZ2V0Z2lkLCBcIlBvcnRhYmxlIExpbnV4IHZlcmlmaWNhdGlvbiByZXF1aXJlcyBVbml4IHVzZXIgaWRlbnRpdGllc1wiKTtcbiAgICAgIGZvciAoY29uc3QgaW1hZ2Ugb2Ygc2VsZWN0ZWQudmVyaWZpY2F0aW9uX2ltYWdlcykge1xuICAgICAgICBhc3NlcnQubWF0Y2goaW1hZ2UsIC9Ac2hhMjU2OlthLWYwLTldezY0fSQvLCBcIlZlcmlmaWNhdGlvbiBpbWFnZXMgbXVzdCBiZSBwaW5uZWQgYnkgZGlnZXN0XCIpO1xuICAgICAgICBjb25zdCBhcmNoaXRlY3R1cmUgPSBwcm9jZXNzLmFyY2ggPT09IFwieDY0XCIgPyBcImFtZDY0XCIgOiBcImFybTY0XCI7XG4gICAgICAgIHJ1bihcImRvY2tlclwiLCBbXCJwdWxsXCIsIFwiLS1wbGF0Zm9ybVwiLCBgbGludXgvJHthcmNoaXRlY3R1cmV9YCwgaW1hZ2VdLCB0ZW1wb3JhcnkpO1xuICAgICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgICAgcnVuKFwiZG9ja2VyXCIsIFtcImltYWdlXCIsIFwiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suT3N9fS97ey5BcmNoaXRlY3R1cmV9fVwiLCBpbWFnZV0sIHRlbXBvcmFyeSkudHJpbSgpLFxuICAgICAgICAgIGBsaW51eC8ke2FyY2hpdGVjdHVyZX1gLFxuICAgICAgICAgIFwiVmVyaWZpY2F0aW9uIGltYWdlIHJlcXVpcmVzIGVtdWxhdGlvblwiLFxuICAgICAgICApO1xuICAgICAgICBydW4oXG4gICAgICAgICAgXCJkb2NrZXJcIixcbiAgICAgICAgICBbXG4gICAgICAgICAgICBcInJ1blwiLFxuICAgICAgICAgICAgXCItLXJtXCIsXG4gICAgICAgICAgICBcIi0tcGxhdGZvcm1cIixcbiAgICAgICAgICAgIGBsaW51eC8ke2FyY2hpdGVjdHVyZX1gLFxuICAgICAgICAgICAgXCItLXVzZXJcIixcbiAgICAgICAgICAgIGAke1N0cmluZyhwcm9jZXNzLmdldHVpZCgpKX06JHtTdHJpbmcocHJvY2Vzcy5nZXRnaWQoKSl9YCxcbiAgICAgICAgICAgIFwiLS1uZXR3b3JrPW5vbmVcIixcbiAgICAgICAgICAgIFwiLS1yZWFkLW9ubHlcIixcbiAgICAgICAgICAgIFwiLS1jYXAtZHJvcD1BTExcIixcbiAgICAgICAgICAgIFwiLS1zZWN1cml0eS1vcHQ9bm8tbmV3LXByaXZpbGVnZXNcIixcbiAgICAgICAgICAgIFwiLS10bXBmc1wiLFxuICAgICAgICAgICAgXCIvdG1wOnJ3LG5vc3VpZCxub2RldixzaXplPTE2bVwiLFxuICAgICAgICAgICAgXCItLW1vdW50XCIsXG4gICAgICAgICAgICBgdHlwZT1iaW5kLHNvdXJjZT0ke3RlbXBvcmFyeX0sdGFyZ2V0PS9hcnRpZmFjdHMscmVhZG9ubHlgLFxuICAgICAgICAgICAgXCItLWVudHJ5cG9pbnRcIixcbiAgICAgICAgICAgIFwiL2Jpbi9zaFwiLFxuICAgICAgICAgICAgaW1hZ2UsXG4gICAgICAgICAgICBcIi1ldVwiLFxuICAgICAgICAgICAgXCItY1wiLFxuICAgICAgICAgICAgJ3Rlc3QgXCIkKC9hcnRpZmFjdHMvcnVzdC1yZWZlcmVuY2UgMjAgMjIpXCIgPSA0MlxcbnRlc3QgXCIkKC9hcnRpZmFjdHMvcnVzdC1yZWZlcmVuY2UgMCAwKVwiID0gMFxcbnNldCArZVxcbi9hcnRpZmFjdHMvcnVzdC1yZWZlcmVuY2UgMTg0NDY3NDQwNzM3MDk1NTE2MTUgMSA+L3RtcC9vdXQgMj4vdG1wL2VyclxcbnN0YXR1cz0kP1xcbnNldCAtZVxcbnRlc3QgXCIkc3RhdHVzXCIgPSAxXFxudGVzdCAhIC1zIC90bXAvb3V0XFxuZ3JlcCAtRnggXCJlcnJvcjogc3VtIGV4Y2VlZHMgdGhlIG1heGltdW0gdW5zaWduZWQgNjQtYml0IGludGVnZXJcIiAvdG1wL2VyclxcbnNldCArZVxcbk5PX0NPTE9SPTEgL2FydGlmYWN0cy9ydXN0LXJlZmVyZW5jZSBpbnZhbGlkIDIgPi90bXAvb3V0IDI+L3RtcC9lcnJcXG5zdGF0dXM9JD9cXG5zZXQgLWVcXG50ZXN0IFwiJHN0YXR1c1wiID0gMlxcbnRlc3QgISAtcyAvdG1wL291dFxcbmdyZXAgLUYgXCJpbnZhbGlkIGRpZ2l0IGZvdW5kIGluIHN0cmluZ1wiIC90bXAvZXJyJyxcbiAgICAgICAgICBdLFxuICAgICAgICAgIHRlbXBvcmFyeSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc29sZS5sb2coYFZlcmlmaWVkIHN0YXRpYyAke21hbmlmZXN0LnRhcmdldH0gYmVoYXZpb3Igb2ZmbGluZSBpbiAke2ltYWdlfS5gKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYXNzZXJ0LmVxdWFsKHJ1bihleGVjdXRhYmxlLCBbXCIyMFwiLCBcIjIyXCJdLCB0ZW1wb3JhcnkpLCBcIjQyXFxuXCIsIFwiU3RhbmRhbG9uZSByZWxlYXNlIHJlc3VsdFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChydW4oZXhlY3V0YWJsZSwgW1wiMFwiLCBcIjBcIl0sIHRlbXBvcmFyeSksIFwiMFxcblwiLCBcIlN0YW5kYWxvbmUgemVybyByZXN1bHRcIik7XG4gICAgICBjb25zdCBvdmVyZmxvdyA9IHNwYXduU3luYyhleGVjdXRhYmxlLCBbXCIxODQ0Njc0NDA3MzcwOTU1MTYxNVwiLCBcIjFcIl0sIHsgY3dkOiB0ZW1wb3JhcnksIGVuY29kaW5nOiBcInV0ZjhcIiB9KTtcbiAgICAgIGFzc2VydC5lcXVhbChvdmVyZmxvdy5zdGF0dXMsIDEsIFwiU3RhbmRhbG9uZSBvdmVyZmxvdyBzdGF0dXNcIik7XG4gICAgICBhc3NlcnQuZXF1YWwob3ZlcmZsb3cuc3Rkb3V0LCBcIlwiLCBcIlN0YW5kYWxvbmUgb3ZlcmZsb3cgb3V0cHV0XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBvdmVyZmxvdy5zdGRlcnIsXG4gICAgICAgIFwiZXJyb3I6IHN1bSBleGNlZWRzIHRoZSBtYXhpbXVtIHVuc2lnbmVkIDY0LWJpdCBpbnRlZ2VyXFxuXCIsXG4gICAgICAgIFwiU3RhbmRhbG9uZSBvdmVyZmxvdyBkaWFnbm9zdGljXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zb2xlLmxvZyhgVmVyaWZpZWQgcmVsZWFzZSBhcnRpZmFjdHMgZnJvbSAke3Jvb3R9IG91dHNpZGUgdGhlIHNvdXJjZSBjaGVja291dC5gKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuaWYgKHByb2Nlc3MuYXJndlsxXSAmJiByZXNvbHZlKHByb2Nlc3MuYXJndlsxXSkgPT09IGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSkge1xuICBjb25zdCByb290ID0gcmVzb2x2ZShwcm9jZXNzLmFyZ3ZbM10gPz8gcHJvY2Vzcy5jd2QoKSk7XG4gIHZlcmlmeVJ1c3RSZWxlYXNlKHJlc29sdmUocHJvY2Vzcy5hcmd2WzJdID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9ESVNUX0RJUiA/PyBqb2luKHJvb3QsIFwiZGlzdFwiKSksIHJvb3QpO1xufVxuIl0sIm1hcHBpbmdzIjoiOzs7QUFBQSxPQUFPLFlBQVk7QUFtQlosU0FBUyxVQUFVLE9BQThCO0FBQ3RELFNBQU8sR0FBRyxNQUFNLFVBQVUsSUFBSSxzQkFBc0I7QUFDcEQsU0FBTyxNQUFNLE1BQU0sU0FBUyxHQUFHLENBQUMsRUFBRSxTQUFTLEtBQUssR0FBRyxrQkFBa0IscUNBQXFDO0FBQzFHLFFBQU0sT0FBTyxNQUFNLGFBQWEsRUFBRSxHQUNoQyxVQUFVLE1BQU0sYUFBYSxFQUFFO0FBQ2pDLFNBQU8sR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLFNBQVMsSUFBSSxHQUFHLG1DQUFtQztBQUNwRSxTQUFPLEdBQUcsQ0FBQyxJQUFJLEdBQUcsRUFBRSxTQUFTLE9BQU8sR0FBRyx5QkFBeUI7QUFDaEUsU0FBTyxNQUFNLE1BQU0sYUFBYSxFQUFFLEdBQUcsR0FBRyxxQkFBcUI7QUFDN0QsU0FBTyxNQUFNLE1BQU0sYUFBYSxFQUFFLEdBQUcsSUFBSSx5QkFBeUI7QUFDbEUsUUFBTSxTQUFTLE9BQU8sTUFBTSxnQkFBZ0IsRUFBRSxDQUFDLEdBQzdDLE9BQU8sTUFBTSxhQUFhLEVBQUUsR0FDNUIsUUFBUSxNQUFNLGFBQWEsRUFBRTtB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QUFBLFFBQ1Q7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFDQSxZQUFRLElBQUksbUNBQW1DLGFBQUksZ0NBQStCO0FBQUEsRUFDcEYsVUFBRTtBQUNBLFdBQU8sV0FBVyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ3BEO0FBQ0Y7QUFFQSxJQUFJLFFBQVEsS0FBSyxDQUFDLEtBQUssUUFBUSxRQUFRLEtBQUssQ0FBQyxDQUFDLE1BQU0sY0FBYyxZQUFZLEdBQUcsR0FBRztBQUNsRixRQUFNLE9BQU8sUUFBUSxRQUFRLEtBQUssQ0FBQyxLQUFLLFFBQVEsSUFBSSxDQUFDO0FBQ3JELG9CQUFrQixRQUFRLFFBQVEsS0FBSyxDQUFDLEtBQUssUUFBUSxJQUFJLHNCQUFzQixLQUFLLE1BQU0sTUFBTSxDQUFDLEdBQUcsSUFBSTtBQUMxRzsiLCJuYW1lcyI6WyJhdCIsImFzc2VydCJdLCJmaWxlIjoiZXhhbXBsZXMvbGFuZ3VhZ2VzL3J1c3Qvc2NyaXB0cy9yZWxlYXNlLXZlcmlmeS5tanMifQ==
