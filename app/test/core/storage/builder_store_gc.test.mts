import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { partialManagedStorePin } from "../../../src/core/execution/environments/managed/managed-contract.mjs";
import { releaseStoreRoots, retainStoreRoots } from "../../../../scripts/builder-store-gc.mjs";

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
  const publish = (inputs: string, targets = [first, second]) => {
    retainStoreRoots({ store, directory, inputs, targets });
  };
  return { root, store, directory, first, second, publish };
}
test("missing accepted-profile evidence preserves old roots and identical input publications are idempotent", () => {
  const f = fixture(),
    old = "a".repeat(64),
    next = "b".repeat(64);
  f.publish(old);
  f.publish(next);
  f.publish(next);
  expect(readlinkSync(join(f.directory, old, "1"))).toBe(f.second);
  expect(existsSync(join(f.directory, next))).toBe(true);
});

test("both architecture closures remain rooted after temporary preparation links are removed", () => {
  const f = fixture();
  const output = join(f.root, "temporary-output");
  mkdirSync(output);
  symlinkSync(f.first, join(output, "native"), "junction");
  symlinkSync(f.second, join(output, "foreign"), "junction");
  const native = "a".repeat(64),
    foreign = "b".repeat(64);
  f.publish(native, [join(output, "native")]);
  f.publish(foreign, [join(output, "foreign")]);
  rmSync(output, { recursive: true });
  for (const identity of [native, foreign])
    expect(readFileSync(join(f.directory, identity, "0", "payload"), "utf8")).toBe("preserve");
});

test("retry publishes an interrupted root set only when its existing links still match", () => {
  const f = fixture(),
    old = "a".repeat(64),
    next = "b".repeat(64);
  f.publish(old);
  const stage = join(f.directory, partialManagedStorePin(next));
  mkdirSync(stage);
  symlinkSync(f.second, join(stage, "0"), "junction");
  expect(() => {
    f.publish(next);
  }).toThrow(/Incomplete builder GC targets changed/);
  expect(readlinkSync(join(stage, "0"))).toBe(f.second);
  expect(readlinkSync(join(f.directory, old, "0"))).toBe(f.first);
  rmSync(join(stage, "0"));
  symlinkSync(f.first, join(stage, "0"), "junction");
  f.publish(next);
  expect(existsSync(stage)).toBe(false);
  expect(readlinkSync(join(f.directory, next, "0"))).toBe(f.first);
  expect(readlinkSync(join(f.directory, next, "1"))).toBe(f.second);
});
test("invalid or missing replacements cannot release existing working roots", () => {
  const f = fixture(),
    old = "a".repeat(64),
    next = "b".repeat(64);
  f.publish(old);
  for (const targets of [[join(f.root, "outside")], [join(f.store, "c".repeat(32) + "-missing")]]) {
    if (targets[0]?.endsWith("outside")) mkdirSync(targets[0]);
    expect(() => {
      f.publish(next, targets);
    }).toThrow();
    expect(existsSync(join(f.directory, old))).toBe(true);
  }
  expect(() => {
    f.publish("../foreign");
  }).toThrow(/identity/);
});
test("changed inputs and unexpected files prevent destructive root replacement", () => {
  const f = fixture(),
    old = "a".repeat(64),
    archive = join(f.store, "unused");
  f.publish(old);
  expect(() => {
    f.publish(old, [f.second]);
  }).toThrow(/targets changed/);
  writeFileSync(join(f.directory, old, "user-data"), "preserve");
  expect(() => {
    releaseStoreRoots(f.directory, old, { roots: [f.first, f.second], archive }, "generation");
  }).toThrow(/unexpected files/);
  expect(readFileSync(join(f.directory, old, "user-data"), "utf8")).toBe("preserve");
});
test("unowned and redirected GC namespaces cannot authorize collection", () => {
  const f = fixture();
  mkdirSync(f.directory, { recursive: true });
  writeFileSync(join(f.directory, "user-data"), "preserve");
  expect(() => {
    f.publish("a".repeat(64));
  }).toThrow(/not owned/);
  rmSync(f.directory, { recursive: true });
  symlinkSync(f.first, f.directory, "junction");
  expect(() => {
    f.publish("a".repeat(64));
  }).toThrow(/real directory/);
  expect(readFileSync(join(f.first, "payload"), "utf8")).toBe("preserve");
});

test.skipIf(process.platform !== "linux")(
  "a verified archive can be released while live and neighboring profile roots remain pinned",
  () => {
    const f = fixture();
    const archive = join(f.store, `${"c".repeat(32)}-image.tar`);
    writeFileSync(archive, "archive");
    const inputs = "a".repeat(64);
    const neighboringProfile = join(f.directory, "another-profile");
    const prepare = (directory: string) =>
      retainStoreRoots({ store: f.store, directory, inputs, targets: [f.first, f.second], archive });
    prepare(neighboringProfile);
    const { roots } = prepare(join(f.directory, "owned"));
    const owner = join(f.directory, "owned");
    const pin = { roots, archive };
    releaseStoreRoots(owner, inputs, pin, "archive");
    releaseStoreRoots(owner, inputs, pin, "archive");
    expect(existsSync(join(owner, inputs, "archive"))).toBe(false);
    expect(readlinkSync(join(owner, inputs, "0"))).toBe(f.first);
    expect(readlinkSync(join(neighboringProfile, inputs, "archive"))).toBe(archive);

    // Simulate an interruption after the old generation was retired and one link removed.
    const retired = join(owner, `.retiring-${inputs}`);
    renameSync(join(owner, inputs), retired);
    rmSync(join(retired, "0"));
    expect(() => {
      releaseStoreRoots(owner, inputs, { ...pin, roots: [f.first, f.first] }, "generation");
    }).toThrow(/retirement contents changed/);
    expect(readlinkSync(join(retired, "1"))).toBe(f.second);
    releaseStoreRoots(owner, inputs, pin, "generation");
    expect(existsSync(retired)).toBe(false);
    expect(readlinkSync(join(neighboringProfile, inputs, "0"))).toBe(f.first);
  },
);
