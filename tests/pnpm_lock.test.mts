import { expect, test } from "vitest";
import { pnpmPackages, pnpmIdentity } from "../scripts/pnpm-lock.mjs";

test("shared pnpm decoding merges documents, preserves every own key and rejects malformed input", () => {
  const packages = pnpmPackages(
    'packages:\n  "package@1.0.0": {}\n---\npackages:\n  "@scope/other@2.0.0": {}\n  __proto__: {}\n',
  );
  expect(Object.keys(packages)).toEqual(["package@1.0.0", "@scope/other@2.0.0", "__proto__"]);
  expect(pnpmIdentity("@scope/other@2.0.0(peer@1.0.0)")).toEqual({ name: "@scope/other", version: "2.0.0" });
  expect(() => pnpmIdentity("__proto__")).toThrow("unsupported npm lock identity");
  expect(() => pnpmPackages("packages: [")).toThrow();
  expect(() => pnpmPackages("packages: 1")).toThrow("Invalid pnpm packages");
});
