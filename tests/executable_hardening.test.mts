import { expect, test } from "vitest";
import { inspectHardening } from "../scripts/executable-hardening.mjs";

function elf() {
  const bytes = Buffer.alloc(64 + 3 * 56 + 32);
  Buffer.from("7f454c46020101", "hex").copy(bytes);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(3, 56);
  bytes.writeUInt32LE(0x6474e551, 64);
  bytes.writeUInt32LE(6, 68);
  bytes.writeUInt32LE(0x6474e552, 120);
  bytes.writeUInt32LE(2, 176);
  bytes.writeBigUInt64LE(232n, 184);
  bytes.writeBigUInt64LE(32n, 208);
  bytes.writeBigUInt64LE(24n, 232);
  return bytes;
}
test("ELF hardening requires all three protections and validates metadata bounds", () => {
  expect(inspectHardening(elf()).protections).toHaveLength(3);
  const executableStack = elf();
  executableStack.writeUInt32LE(7, 68);
  expect(() => inspectHardening(executableStack)).toThrow(/Executable stack/);
  const lazyBinding = elf();
  lazyBinding.writeBigUInt64LE(0n, 232);
  expect(() => inspectHardening(lazyBinding)).toThrow(/RELRO/);
  const truncated = elf();
  truncated.writeBigUInt64LE(10000n, 184);
  expect(() => inspectHardening(truncated)).toThrow(/dynamic entries/);
});
test("PE requires ASLR, DEP and control-flow guard rather than accepting a format signature", () => {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(112, 84);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt16LE(0x4140, 158);
  expect(inspectHardening(bytes).format).toBe("PE");
  bytes.writeUInt16LE(0x140, 158);
  expect(() => inspectHardening(bytes)).toThrow(/control-flow guard/);
});
test("Mach-O requires PIE and rejects executable stacks; malformed formats remain failures", () => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(0x200000, 24);
  expect(inspectHardening(bytes).format).toBe("Mach-O");
  bytes.writeUInt32LE(0x220000, 24);
  expect(() => inspectHardening(bytes)).toThrow(/non-executable stack/);
  expect(() => inspectHardening(Buffer.alloc(12))).toThrow(/Truncated/);
  expect(() => inspectHardening(Buffer.alloc(64))).toThrow(/Unsupported/);
});

test("ELF decoding rejects invalid identity, machine, segment bounds and unterminated dynamic metadata", () => {
  for (const mutate of [
    (bytes: Buffer) => bytes.writeUInt16LE(1, 16),
    (bytes: Buffer) => bytes.writeUInt16LE(0, 18),
    (bytes: Buffer) => bytes.writeUInt32LE(0, 20),
    (bytes: Buffer) => bytes.writeUInt16LE(0, 52),
    (bytes: Buffer) => bytes.writeBigUInt64LE(999999n, 64 + 8),
    (bytes: Buffer) => bytes.writeBigUInt64LE(24n, 248),
  ]) {
    const bytes = elf();
    mutate(bytes);
    expect(() => inspectHardening(bytes)).toThrow(/ELF/);
  }
});
