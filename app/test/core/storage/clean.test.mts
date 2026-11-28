import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { artifacts, cleanupFixtures, dependencies, preserved } from "../../fixtures/project-cleanup.mjs";

const { fixture, make } = cleanupFixtures();

test.skipIf(process.platform === "win32")("clean cleans all examples without deleting maintained files", () => {
  const { project, external } = fixture();
  make(project, "clean", external);
  for (const path of artifacts) expect(existsSync(join(project, path)), path).toBe(false);
  for (const path of dependencies) expect(existsSync(join(project, path)), path).toBe(true);
  for (const path of preserved) expect(existsSync(join(project, path)), path).toBe(true);
  expect(existsSync(join(external, "keep"))).toBe(true);
});
