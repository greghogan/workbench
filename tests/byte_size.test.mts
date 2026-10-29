import { expect, test } from "vitest";
import { formatBytes, formatByteCount } from "../src/byte-size.ts";

test.each([
  [0, "0 B"],
  [999, "999 B"],
  [1000, "1.0 kB"],
  [1_234_500, "1.2 MB"],
  [1_000_000_000, "1.0 GB"],
  [1_000_000_000_000, "1.0 TB"],
])("decimal size %i is %s", (bytes, expected) => {
  expect(formatBytes(bytes)).toBe(expected);
});

test("exact limits retain every byte and use stable decimal grouping", () => {
  expect(formatByteCount(1024 * 1024)).toBe("1,048,576");
  expect(formatByteCount(2 ** 30)).toBe("1,073,741,824");
});
