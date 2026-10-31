import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { importManagedImage } from "../scripts/managed-image-import.mjs";
import type { ManagedProcessScope } from "../scripts/managed-process.mjs";
import { promised } from "./fixtures/promised.mjs";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-image-import-"));
  directories.push(root);
  mkdirSync(join(root, "cache"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  const id = `sha256:${"a".repeat(64)}`;
  const source = `workbench-nix-prepared:${"a".repeat(32)}`;
  const state = { existing: "", loaded: `Loaded image: ${source}`, id, failTag: false, failRemove: false, source };
  const calls: { command: string; args: readonly string[] }[] = [];
  const scope: ManagedProcessScope = {
    defer: () => undefined,
    run: (command, args) =>
      promised(() => {
        calls.push({ command, args });
        if (command === "bash") return state.loaded;
        if (args[0] === "info") return "engine";
        if (args[0] === "image" && args[1] === "ls") return state.existing;
        if (args[0] === "image" && args[1] === "inspect") return state.id;
        if (args[0] === "tag" && state.failTag) throw new Error("tagging failed");
        if (args[1] === "rm" && state.failRemove) throw new Error("cleanup failed");
        return "";
      }),
  };
  return { state, scope, calls };
}
test.each([false, true])(
  "new managed source tags are released only after immutable staging succeeds (container=%s)",
  async (container) => {
    const f = fixture();
    await importManagedImage(
      f.scope,
      "/store/archive with spaces",
      "workbench:operation",
      container ? "builder" : undefined,
    );
    expect(f.calls.filter((call) => call.args[0] === "tag").map((call) => call.args)).toEqual([
      ["tag", f.state.id, "workbench:operation"],
    ]);
    expect(f.calls.at(-1)?.args).toEqual(["image", "rm", f.state.source]);
    expect(f.calls.findIndex((call) => call.args[0] === "tag")).toBeLessThan(
      f.calls.findIndex((call) => call.args[1] === "rm"),
    );
    expect(f.calls.find((call) => call.command === "bash")?.args.slice(-1)).toEqual(["/store/archive with spaces"]);
  },
);
test("preexisting and unrelated tags remain caller-owned", async () => {
  for (const existing of [true, false]) {
    const f = fixture();
    if (existing) f.state.existing = f.state.source;
    else f.state.loaded = "Loaded image: unrelated:latest";
    await importManagedImage(f.scope, "/archive", "workbench:operation");
    expect(f.calls.some((call) => call.args[1] === "rm")).toBe(false);
  }
});
test("failed staging and ambiguous archives never authorize source deletion", async () => {
  const f = fixture();
  f.state.failTag = true;
  await expect(importManagedImage(f.scope, "/archive", "workbench:operation")).rejects.toThrow(/tagging failed/);
  expect(f.calls.some((call) => call.args[1] === "rm")).toBe(false);
  f.state.loaded += "\nLoaded image: unexpected:second";
  await expect(importManagedImage(f.scope, "/archive", "workbench:operation")).rejects.toThrow(/one imported image/);
});
test("a bare immutable import identity is staged without tag cleanup", async () => {
  const f = fixture();
  f.state.loaded = `Loaded image ID: ${f.state.id}`;
  await importManagedImage(f.scope, "/archive", "workbench:operation");
  expect(f.calls.at(-1)?.args).toEqual(["tag", f.state.id, "workbench:operation"]);
});

test("a temporary source cleanup failure preserves successful staging", async () => {
  const f = fixture();
  f.state.failRemove = true;
  await expect(importManagedImage(f.scope, "/archive", "workbench:operation")).resolves.toBeUndefined();
  expect(f.calls.some((call) => call.args[0] === "tag")).toBe(true);
});

test("two imports on the same engine finish staging and cleanup before the next consumes the shared source tag", async () => {
  const f = fixture(),
    events: string[] = [];
  let start: () => void = () => undefined,
    release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scope = (name: string): ManagedProcessScope => ({
    defer: () => undefined,
    run: async (command, args) => {
      if (name === "b" && args[0] === "info") release();
      const operation = args[1];
      if (args[0] === "image" && operation && ["ls", "rm"].includes(operation)) events.push(`${name}:${operation}`);
      if (name === "a" && command === "bash") {
        start();
        await released;
      }
      return f.scope.run(command, args);
    },
  });
  const first = importManagedImage(scope("a"), "/archive", "workbench:first");
  await started;
  await Promise.all([first, importManagedImage(scope("b"), "/archive", "workbench:second")]);
  expect(events).toEqual(["a:ls", "a:rm", "b:ls", "b:rm"]);
});
