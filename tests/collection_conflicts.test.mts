import { required } from "../src/invariants.ts";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { expect, test } from "vitest";
import { reconcileCollection } from "../src/collection-reconcile.ts";
import { readConfig } from "../src/core.ts";
import { provider } from "./fixtures/adoption.mjs";
import { collectionFixture, adopt, working, options } from "./fixtures/collection-scenarios.mjs";

const { fixture, temporary } = collectionFixture();

test("conflicts leave the checkout and pin unchanged and a reviewed proposal can resolve them", async () => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  writeFileSync(working(root), readFileSync(working(root), "utf8").replace("bounded retry", "project retry"));
  const next = provider(root, "company", "2", ["Use an upstream retry budget."]);
  const before = readFileSync(working(root)),
    config = readFileSync(join(root, "workbench/config.toml"));
  let proposal: string | undefined;
  try {
    reconcileCollection(root, next.directory, options(next), "company");
  } catch (error) {
    const match = /Resolve files in (.+), then repeat/.exec(error instanceof Error ? error.message : String(error));
    if (!match) throw error;
    proposal = match[1];
  }
  expect(proposal).toBeTruthy();
  temporary.push(dirname(required(proposal, "Fixture value proposal")));
  expect(readFileSync(working(root))).toEqual(before);
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(config);
  expect(() => reconcileCollection(root, next.directory, options(next), "company", proposal)).toThrow(/merge markers/);
  writeFileSync(join(required(proposal, "Fixture value proposal"), "decisions/ADR-00.md"), before);
  reconcileCollection(root, next.directory, options(next), "company", proposal);
  expect(readFileSync(working(root))).toEqual(before);
  expect(
    required(
      required(
        required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
        "Expected fixture value: readConfig(root).collections.sources",
      )[0],
      "Expected fixture value: readConfig(root).collections.sources[0]",
    ).revision,
  ).toBe("2");
});

test.each(["edit", "add", "remove"])("resolved proposals reject a subsequent project %s", async (change) => {
  const root = await fixture(),
    source = provider(root);
  adopt(root, source);
  writeFileSync(working(root), readFileSync(working(root), "utf8").replace("bounded retry", "project retry"));
  const next = provider(root, "company", "2", ["Use an upstream retry budget."]);
  let proposal: string | undefined;
  try {
    reconcileCollection(root, next.directory, options(next), "company");
  } catch (error) {
    const match = /Resolve files in (.+), then repeat/.exec(error instanceof Error ? error.message : String(error));
    if (!match) throw error;
    proposal = match[1];
  }
  expect(proposal).toBeTruthy();
  temporary.push(dirname(required(proposal, "Fixture value proposal")));
  const resolution = readFileSync(working(root));
  writeFileSync(join(required(proposal, "Fixture value proposal"), "decisions/ADR-00.md"), resolution);
  const additional = join(root, "workbench/collections/company/decisions/ADR-00/addition.txt");
  if (change === "edit")
    writeFileSync(working(root), Buffer.concat([resolution, Buffer.from("\nFurther project work.\n")]));
  else if (change === "remove") rmSync(working(root));
  else {
    mkdirSync(dirname(additional), { recursive: true });
    writeFileSync(additional, "new project evidence");
  }
  const config = readFileSync(join(root, "workbench/config.toml"));
  const policy = existsSync(working(root)) ? readFileSync(working(root)) : undefined;
  expect(() => reconcileCollection(root, next.directory, options(next), "company", proposal)).toThrow(
    /project files changed/,
  );
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(config);
  expect(existsSync(working(root)) ? readFileSync(working(root)) : undefined).toEqual(policy);
  expect(readFileSync(join(required(proposal, "Fixture value proposal"), "decisions/ADR-00.md"))).toEqual(resolution);
  if (change === "add") expect(readFileSync(additional, "utf8")).toBe("new project evidence");
});
