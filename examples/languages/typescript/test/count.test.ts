import { describe, expect, it } from "vitest";
import { countByte } from "../src/arithmetic.js";

describe("countByte", () => {
  it("counts exact bytes in empty, mixed, and high-bit inputs", () => {
    expect(countByte(new Uint8Array(), 0)).toBe(0);
    expect(countByte(new TextEncoder().encode("banana"), 97)).toBe(3);
    expect(countByte(new Uint8Array(65).fill(255), 255)).toBe(65);
  });
  it.each([-1, 256, 0.5, NaN, Infinity])("rejects invalid needle %s", (needle) => {
    expect(() => countByte(new Uint8Array(), needle)).toThrow(RangeError);
  });
});
