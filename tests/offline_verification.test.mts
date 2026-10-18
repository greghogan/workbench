import { join } from "node:path";
import { expect, test } from "vitest";
import { sameVerification, verificationProof } from "../src/offline-verification.ts";

test("verification reuse binds artifact, frozen source, verifier, effective environment and container settings", () => {
  const input = {
    image: "sha256:a",
    trees: [{ path: ".", tree: "tree-a" }],
    verifier: ["check"],
    environment: { CI: "false", daemon: "host-a" },
    container: { user: "node" },
  };
  const proof = verificationProof(input);
  expect(sameVerification(proof, verificationProof(input))).toBe(true);
  for (const change of [
    { image: "sha256:b" },
    { trees: [{ path: ".", tree: "tree-b" }] },
    { verifier: ["other"] },
    { environment: { ...input.environment, daemon: "host-b" } },
    { container: { user: "root" } },
  ]) {
    expect(sameVerification(proof, verificationProof({ ...input, ...change }))).toBe(false);
  }
  expect(sameVerification(undefined, proof)).toBe(false);
  expect(sameVerification(proof, undefined)).toBe(false);
  expect(sameVerification({ version: 1, key: "invalid" }, proof)).toBe(false);
});

test("external distribution evidence changes with frozen bytes and rejects uncertain links", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import("node:fs");
  const os = await import("node:os");
  const { frozenDistributionTree } = await import("../src/offline-verification.ts");
  const root = mkdtempSync(join(os.tmpdir(), "workbench-frozen-distribution-"));
  try {
    mkdirSync(join(root, "bundle"));
    writeFileSync(join(root, "bundle/main.cjs"), "first");
    const first = await frozenDistributionTree(root);
    expect(await frozenDistributionTree(root)).toBe(first);
    writeFileSync(join(root, "bundle/main.cjs"), "second");
    expect(await frozenDistributionTree(root)).not.toBe(first);
    if (process.platform !== "win32") {
      symlinkSync("main.cjs", join(root, "bundle/link"));
      await expect(frozenDistributionTree(root)).rejects.toThrow("uncertain file type");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
