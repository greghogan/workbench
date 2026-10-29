import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";
import { userDirectory } from "../src/storage.ts";
import {
  imageProfileLock,
  imageProfileMaintenanceLock,
  imageProfileReceipt,
  preparedImageTag,
  parsePreparedTag,
  imageDisplayTag,
  localPreparedReference,
  imageProtection,
} from "../src/image-contract.ts";

test.each(["x64", "arm64"])(
  "prepared %s identities round-trip with architecture-owned operation locks",
  (architecture) => {
    const inputs = "a".repeat(64),
      tag = preparedImageTag(architecture, inputs);
    expect(tag).toBe(`linux-${architecture}-${inputs}`);
    expect(parsePreparedTag(tag)).toEqual({ architecture, inputs });
    expect(imageDisplayTag(`ghcr.io:443/owner/project:${tag}`)).toBe(`linux-${architecture}-${"a".repeat(12)}`);
    const local = `workbench-prepared-${"b".repeat(24)}:${tag}`;
    expect(localPreparedReference(local)).toBe(true);
    expect(localPreparedReference(local + ":extra")).toBe(false);
    expect(imageProfileLock("/checkout", "guix", architecture)).toBe(
      join(
        userDirectory("cache"),
        "offline-profiles",
        createHash("sha256").update("/checkout").digest("hex"),
        `guix.${architecture}.operation`,
      ),
    );
  },
);
test("invalid prepared identities are rejected and protection codes retain distinct display messages", () => {
  expect(() => preparedImageTag("other", "a".repeat(64))).toThrow(/identity/);
  expect(() => preparedImageTag("x64", "short")).toThrow(/identity/);
  expect(parsePreparedTag("latest")).toBeUndefined();
  expect(imageDisplayTag("project:latest")).toBe("latest");
  expect(imageProtection("locked")).toEqual({
    blockedReason: "locked",
    blockedBy: "active or recovery-required preparation lock",
  });
  expect(imageProtection()).toEqual({});
});

test("accepted platform receipts and operation locks are independent", () => {
  const native = process.arch === "arm64" ? "arm64" : "x64",
    foreign = native === "arm64" ? "x64" : "arm64";
  expect(imageProfileReceipt("/checkout", "guix", native)).toBe(imageProfileMaintenanceLock("/checkout", "guix"));
  expect(imageProfileLock("/checkout", "guix", native)).not.toBe(imageProfileLock("/checkout", "guix", foreign));
  expect(imageProfileReceipt("/checkout", "guix", foreign)).not.toBe(imageProfileReceipt("/checkout", "guix", native));
  expect(() => imageProfileReceipt("/checkout", "guix", "invalid")).toThrow(/architecture/);
});
