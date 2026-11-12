import { afterEach, expect, test, vi } from "vitest";
import { Command } from "commander";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheProjectFixture } from "../../fixtures/cache-project.mjs";
import {
  inspectKnownCacheOperations,
  recoverKnownCacheOperation,
} from "../../../src/core/storage/cache-operation-service.ts";
import { withCacheLock } from "../../../src/core/storage/cache-lock.ts";
import { registerCacheCommands } from "../../../src/cli/cache.ts";
import { inventoryContent, inventoryPresentation } from "../../../src/server/views/hub-pages.tsx";
import { emptyInventory } from "../../../src/server/cache/cache-inventory.ts";
import { renderToString } from "preact-render-to-string";
import { parseDOM } from "../../fixtures/dom.mjs";
import { measureCacheSize } from "../../../src/core/storage/cache-size.ts";
import { withBuildUse } from "../../../src/core/artifacts/builds.ts";

const fixtures: ReturnType<typeof cacheProjectFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() {
  const f = cacheProjectFixture();
  fixtures.push(f);
  const root = f.project("unknown-cache"),
    tool = f.install("4.0.1"),
    paths = f.result(root, tool);
  rmSync(join(paths.directory, ".workbench-build.json"));
  return { f, root, paths };
}
test("uncertain cache ownership is visible in both interfaces and the exact CLI confirmation removes only that selection", async () => {
  const { root, paths } = fixture();
  const entry = inspectKnownCacheOperations().entries.find((entry) => entry.directory === paths.directory);
  if (!entry) throw new Error("Missing uncertain cache");
  expect(entry).toMatchObject({ location: "unowned", state: "uncertain" });
  const view = inventoryPresentation(
    {
      ...emptyInventory(),
      inventory: { storageRoot: paths.storageRoot, checkout: null, entries: [], operations: [entry] },
      complete: true,
      refreshing: false,
      problem: "",
    },
    [],
    "csrf",
    "caches",
  );
  const document = parseDOM(renderToString(inventoryContent(view))).window.document;
  const row = document.querySelector('[data-cache-rows="operations"] tr');
  expect(row?.textContent).toContain(paths.directory);
  expect(row?.textContent).toContain("unowned build directory");
  expect(row?.querySelector("form")?.getAttribute("action")).toBe("/caches/recover");
  expect(row?.querySelector("button")?.textContent).toBe("Review deletion");
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value: unknown) => output.push(String(value)));
  const run = async (args: string[]) => {
    const program = new Command();
    registerCacheCommands(program, root);
    await program.parseAsync(["cache", "recover", paths.directory, ...args], { from: "user" });
  };
  await run([]);
  expect(output.join("\n")).toContain(entry.digest);
  await measureCacheSize({ directory: paths.directory, state: "pending" }, true);
  expect(inspectKnownCacheOperations().entries.find((current) => current.directory === entry.directory)?.digest).toBe(
    entry.digest,
  );
  await expect(run(["--apply"])).rejects.toThrow(/exact --confirm-delete digest/);
  expect(existsSync(join(paths.directory, "output"))).toBe(true);
  await run(["--confirm-delete", entry.digest]);
  expect(existsSync(paths.directory)).toBe(false);
  expect(existsSync(paths.dependencies)).toBe(true);
});
test("fresh confirmation rejects a changed selection and a known active cache cannot be removed", async () => {
  const { paths } = fixture();
  const original = inspectKnownCacheOperations().entries.find((entry) => entry.directory === paths.directory);
  if (!original) throw new Error("Missing original cache selection");
  writeFileSync(join(paths.directory, "new-output"), "new work");
  await expect(recoverKnownCacheOperation(original.directory, original.digest)).rejects.toThrow(/selection changed/);
  await withCacheLock(paths.directory, async () => {
    const active = inspectKnownCacheOperations().entries.find((entry) => entry.directory === paths.directory);
    if (!active) throw new Error("Missing active cache selection");
    expect(active.state).toBe("active");
    await expect(recoverKnownCacheOperation(active.directory, active.digest)).rejects.toThrow(/active/);
  });
  expect(readFileSync(join(paths.directory, "new-output"), "utf8")).toBe("new work");
});

test("confirmed uncertain cleanup preserves a live development session after its admission lock is released", async () => {
  const { paths } = fixture();
  await withBuildUse(paths, async () => {
    const entry = inspectKnownCacheOperations().entries.find((entry) => entry.directory === paths.directory);
    if (!entry) throw new Error("Missing uncertain cache");
    await expect(recoverKnownCacheOperation(entry.directory, entry.digest)).rejects.toThrow(
      /active or unresolved development session/,
    );
    expect(readFileSync(join(paths.directory, "output"), "utf8")).toBe("owned result");
  });
  const entry = inspectKnownCacheOperations().entries.find((entry) => entry.directory === paths.directory);
  if (!entry) throw new Error("Missing released cache");
  await recoverKnownCacheOperation(entry.directory, entry.digest);
  expect(existsSync(paths.directory)).toBe(false);
});
