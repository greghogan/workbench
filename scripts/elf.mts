import assert from "node:assert/strict";

export interface ElfSegment {
  type: number;
  flags: number;
  offset: number;
  length: number;
}
export interface ElfDynamicEntry {
  tag: bigint;
  value: bigint;
}
export interface ElfExecutable {
  type: number;
  machine: number;
  segments: ElfSegment[];
  dynamic: ElfDynamicEntry[];
}
/** Decode the supported ELF64 little-endian subset once; consumers apply their own release policies. */
export function decodeElf(bytes: Buffer): ElfExecutable {
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
  const segments: ElfSegment[] = [],
    dynamic: ElfDynamicEntry[] = [];
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
      for (let at = segment.offset; at < segment.offset + segment.length; at += 16) {
        const tag = bytes.readBigUInt64LE(at),
          value = bytes.readBigUInt64LE(at + 8);
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
