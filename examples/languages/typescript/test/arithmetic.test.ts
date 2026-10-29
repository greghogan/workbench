import assert from "node:assert/strict";
import { test } from "vitest";
import { sum } from "../src/arithmetic.js";

test("sums an immutable input", () => {
  assert.equal(sum([1, 2, 3]), 6);
});
