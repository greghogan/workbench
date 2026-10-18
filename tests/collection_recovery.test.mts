import { required } from "../src/invariants.ts";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { reconcileCollection } from "../src/collection-reconcile.ts";
import { readConfig } from "../src/core.ts";
import { provider, git } from "./fixtures/adoption.mjs";
import { collectionFixture, adopt, working, options } from "./fixtures/collection-scenarios.mjs";

const { fixture, temporary } = collectionFixture();

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
afterEach(() => vi.mocked(renameSync).mockReset());

test.each(["first replacement", "configuration"])(
  "a failed %s rolls back without a false recovery conflict",
  async (failure) => {
    const root = await fixture(),
      source = provider(root);
    adopt(root, source);
    const map = join(root, "workbench/collections/company/decision-map.md"),
      config = join(root, "workbench/config.toml");
    const before = new Map(
      [working(root), map, config, join(root, ".gitmodules")].map((path) => [path, readFileSync(path)]),
    );
    const index = git(root, "write-tree");
    const next = provider(root, "company", "2", ["Updated rule.", "Added rule."]);
    const actual = required(vi.mocked(renameSync).getMockImplementation(), "Installed rename implementation");
    const target = failure === "configuration" ? config : working(root);
    let failed = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === target && !failed) {
        failed = true;
        throw new Error("simulated publication failure");
      }
      actual(from, to);
    });
    expect(() => reconcileCollection(root, next.directory, options(next), "company")).toThrow(
      /simulated publication failure/,
    );
    expect(failed).toBe(true);
    for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(working(root, "company", "01"))).toBe(false);
    expect(existsSync(join(root, ".git/workbench/collection-recovery"))).toBe(false);
    expect(git(root, "write-tree")).toBe(index);
    reconcileCollection(root, next.directory, options(next), "company");
    expect(
      required(
        required(
          required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
          "Expected fixture value: readConfig(root).collections.sources",
        )[0],
        "Expected fixture value: readConfig(root).collections.sources[0]",
      ).commit,
    ).toBe(next.commit);
  },
);

test("rollback preserves a concurrent edit and retains the recovery journal", async () => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  const next = provider(root, "company", "2", ["Updated rule."]);
  const config = join(root, "workbench/config.toml"),
    before = readFileSync(config);
  const actual = required(vi.mocked(renameSync).getMockImplementation(), "Installed rename implementation");
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (to === config) {
      writeFileSync(working(root), "concurrent user work\n");
      throw new Error("simulated publication failure");
    }
    actual(from, to);
  });
  let failure;
  try {
    reconcileCollection(root, next.directory, options(next), "company");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  const proposal = /proposal retained at (.+)$/.exec(failure instanceof Error ? failure.message : String(failure))?.[1];
  expect(proposal).toBeTruthy();
  temporary.push(required(proposal, "Fixture value proposal"));
  expect(readFileSync(working(root), "utf8")).toBe("concurrent user work\n");
  expect(readFileSync(config)).toEqual(before);
  expect(existsSync(join(root, ".git/workbench/collection-recovery/intent.json"))).toBe(true);
});
