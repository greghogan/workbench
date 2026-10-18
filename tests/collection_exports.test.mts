import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { inspectCollection } from "../src/collections.ts";
import { exportCollection } from "../src/collection-commands.ts";
import { provider } from "./fixtures/adoption.mjs";
import { collectionFixture } from "./fixtures/collection-scenarios.mjs";

const { fixture } = collectionFixture();

test("provider exports are self-contained and omit configuration and unrelated records", async () => {
  const root = await fixture();
  mkdirSync(join(root, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(root, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Own rule.\n---\n\n# ADR-0: Own rule\n\nA rule.\n",
  );
  const output = join(root, "export");
  const pin = await exportCollection(root, output, "consumer", "1", [], undefined, true, "public");
  expect(inspectCollection(output).pin.sha256).toBe(pin.sha256);
  expect(readFileSync(join(output, "workbench/CHARTER.md"))).toEqual(readFileSync(join(root, "workbench/CHARTER.md")));
  expect(existsSync(join(output, "workbench/config.toml"))).toBe(false);
  await expect(exportCollection(root, output, "consumer", "1", [], undefined, true, "public")).rejects.toThrow(
    /already exists/,
  );
});

test("collection verification rejects external dependencies, unresolved references, links and symlinked records", async () => {
  const root = await fixture();
  expect(() => provider(root, "company", "bad", ["See workbench:ADR-0."])).toThrow(/self-contained/);
  expect(() => provider(root, "company", "later", ["See ADR-1.", "Rule."])).toThrow(/earlier/);
  expect(() => provider(root, "company", "link", ["See [file](../../external.md)."])).toThrow(/outside/);
  const source = provider(root);
  const record = join(source.directory, "workbench/decisions/ADR-00.md");
  rmSync(record);
  symlinkSync(resolve(import.meta.dirname, "fixtures/records/ADR-00.md"), record);
  expect(() => inspectCollection(source.directory)).toThrow(/symlinks/);
});
