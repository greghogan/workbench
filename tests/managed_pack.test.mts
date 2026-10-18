import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareManagedPackage } from "../scripts/package-managed.mjs";

const state = vi.hoisted(() => ({ calls: [] as string[][], fail: false }));
vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    state.calls.push([command, ...args]);
    if (state.fail) return { status: 1, stderr: "builder failed" };
    return {
      status: 0,
      stdout: args.includes("pack")
        ? `/gnu/store/${"b".repeat(32)}-pack.tar.gz`
        : `/gnu/store/${"a".repeat(32)}-application`,
    };
  },
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    copyFileSync: (source: string, target: string) => {
      if (!source.startsWith("/gnu/store/")) throw new Error("unexpected artifact source");
      actual.writeFileSync(target, "verified pack fixture");
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  state.calls = [];
  state.fail = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  check: { site: string; commands?: never } | { commands: { argv: string[]; stdout: string }[]; site?: never },
) {
  const root = mkdtempSync(join(tmpdir(), "workbench-guix-pack-"));
  roots.push(root);
  const output = join(root, "output");
  mkdirSync(output);
  writeFileSync(join(root, "managed-release-check.json"), JSON.stringify(check));
  vi.stubEnv("WORKBENCH_CPUS", "2");
  return { root, output };
}
test.each([false, true])("Guix packs declare only applicable top-level links (static site: %s)", (site) => {
  const check = site ? { site: "share/site" } : { commands: [{ argv: ["{bin}/count", "a", "banana"], stdout: "3\n" }] };
  const { root, output } = fixture(check);
  vi.stubEnv("WORKBENCH_PROJECT_ROOT", join(root, "project"));
  prepareManagedPackage("guix", undefined, output, root);
  const pack = state.calls.find((args) => args.includes("pack"));
  expect(
    required(pack, "Expected fixture value: pack")[required(pack, "Expected fixture value: pack").indexOf("-C") + 1],
  ).toBe(join(root, "project", "channels.scm"));
  const links = required(pack, "Expected fixture value: pack").flatMap((value: string, index: number) =>
    value === "-S" ? [required(pack, "Expected fixture value: pack")[index + 1]] : [],
  );
  expect(links).toEqual(site ? [] : ["/bin=bin"]);
  expect(pack).toContain("-RR");
  expect(readFileSync(join(output, "package.tar.gz"), "utf8")).toBe("verified pack fixture");
  expect((JSON.parse(readFileSync(join(output, "managed-release.json"), "utf8")) as { check: unknown }).check).toEqual(
    check,
  );
});
test("failed managed builds never produce accepted package metadata", () => {
  const { root, output } = fixture({ site: "share/site" });
  state.fail = true;
  expect(() => {
    prepareManagedPackage("guix", undefined, output, root);
  }).toThrow(/builder failed/);
  expect(existsSync(join(output, "managed-release.json"))).toBe(false);
});
