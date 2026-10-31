import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { retainStoreRoots } from "../scripts/builder-store-gc.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-store-gc-")));
  temporary.push(root);
  const store = join(root, "store"),
    directory = join(root, "gcroots/workbench");
  const first = join(store, "a".repeat(32) + "-runtime"),
    second = join(store, "b".repeat(32) + "-profile");
  for (const path of [first, second]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "payload"), "preserve");
  }
  const publish = (inputs: string, retained: string[] | undefined, targets = [first, second]) => {
    retainStoreRoots({ store, directory, inputs, retained, targets });
  };
  return { root, store, directory, first, second, publish };
}
test("accepted, kept and current profile closures retain roots while superseded generations become collectible", () => {
  const f = fixture(),
    old = "a".repeat(64),
    kept = "b".repeat(64),
    current = "c".repeat(64);
  f.publish(old, undefined);
  f.publish(kept, [old]);
  f.publish(current, [kept]);
  expect(existsSync(join(f.directory, old))).toBe(false);
  for (const input of [kept, current]) expect(realpathSync(join(f.directory, input, "0"))).toBe(f.first);
  expect(readFileSync(join(f.second, "payload"), "utf8")).toBe("preserve");
  // Root retirement itself never removes manager-owned package payloads.
  expect(readFileSync(join(f.first, "payload"), "utf8")).toBe("preserve");
});
test("missing accepted-profile evidence preserves old roots and identical input publications are idempotent", () => {
  const f = fixture(),
    old = "a".repeat(64),
    next = "b".repeat(64);
  f.publish(old, undefined);
  f.publish(next, undefined);
  f.publish(next, undefined);
  expect(readlinkSync(join(f.directory, old, "1"))).toBe(f.second);
  expect(existsSync(join(f.directory, next))).toBe(true);
});
test("invalid or missing replacements cannot release existing working roots", () => {
  const f = fixture(),
    old = "a".repeat(64),
    next = "b".repeat(64);
  f.publish(old, undefined);
  for (const targets of [[join(f.root, "outside")], [join(f.store, "c".repeat(32) + "-missing")]]) {
    if (targets[0]?.endsWith("outside")) mkdirSync(targets[0]);
    expect(() => {
      f.publish(next, [], targets);
    }).toThrow();
    expect(existsSync(join(f.directory, old))).toBe(true);
  }
  expect(() => {
    f.publish(next, ["../foreign"]);
  }).toThrow(/identity/);
});
test("changed inputs and unexpected files prevent destructive root replacement", () => {
  const f = fixture(),
    old = "a".repeat(64),
    next = "b".repeat(64);
  f.publish(old, undefined);
  expect(() => {
    f.publish(old, [], [f.second]);
  }).toThrow(/targets changed/);
  writeFileSync(join(f.directory, old, "user-data"), "preserve");
  expect(() => {
    f.publish(next, []);
  }).toThrow(/unexpected files/);
  expect(readFileSync(join(f.directory, old, "user-data"), "utf8")).toBe("preserve");
});
test("unowned and redirected GC namespaces cannot authorize collection", () => {
  const f = fixture();
  mkdirSync(f.directory, { recursive: true });
  writeFileSync(join(f.directory, "user-data"), "preserve");
  expect(() => {
    f.publish("a".repeat(64), []);
  }).toThrow(/not owned/);
  rmSync(f.directory, { recursive: true });
  symlinkSync(f.first, f.directory, "junction");
  expect(() => {
    f.publish("a".repeat(64), []);
  }).toThrow(/real directory/);
  expect(readFileSync(join(f.first, "payload"), "utf8")).toBe("preserve");
});
