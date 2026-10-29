import { decodeElf } from "./elf.mjs";
import assert from "node:assert/strict";

/** Inspect the declared native formats without depending on host binutils. */
export function inspectHardening(bytes: Buffer): { format: string; protections: string[] } {
  assert.ok(bytes.length >= 64, "Truncated executable header");
  if (bytes.subarray(0, 4).toString("hex") === "7f454c46") {
    const elf = decodeElf(bytes);
    const stack = elf.segments.find((segment) => segment.type === 0x6474e551);
    if (stack) assert.equal(stack.flags & 1, 0, "Executable stack is enabled");
    const relro = elf.segments.some((segment) => segment.type === 0x6474e552);
    const immediate = elf.dynamic.some(
      ({ tag, value }) =>
        tag === 24n || (tag === 30n && (value & 8n) !== 0n) || (tag === 0x6ffffffbn && (value & 1n) !== 0n),
    );
    assert.ok(stack && relro && immediate, "ELF requires a non-executable stack and full RELRO");
    return { format: "ELF", protections: ["non-executable stack", "RELRO", "immediate binding"] };
  }
  if (bytes.toString("ascii", 0, 2) === "MZ") {
    const header = bytes.readUInt32LE(60);
    assert.ok(header >= 64 && header + 96 <= bytes.length, "Invalid PE headers");
    assert.equal(bytes.toString("hex", header, header + 4), "50450000", "Invalid PE signature");
    assert.ok(
      bytes.readUInt16LE(header + 20) >= 72 &&
        header + 24 + bytes.readUInt16LE(header + 20) <= bytes.length &&
        [0x10b, 0x20b].includes(bytes.readUInt16LE(header + 24)),
      "Invalid PE optional header",
    );
    const flags = bytes.readUInt16LE(header + 24 + 70);
    assert.equal(flags & 0x4140, 0x4140, "PE requires ASLR, DEP, and control-flow guard");
    return { format: "PE", protections: ["ASLR", "DEP", "control-flow guard"] };
  }
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, "Unsupported executable format");
  const flags = bytes.readUInt32LE(24);
  assert.ok((flags & 0x200000) !== 0 && (flags & 0x20000) === 0, "Mach-O requires PIE and a non-executable stack");
  return { format: "Mach-O", protections: ["PIE", "non-executable stack"] };
}
