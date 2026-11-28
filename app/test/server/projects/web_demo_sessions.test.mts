import { parseDOM } from "../../fixtures/dom.mjs";
import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hiddenValue } from "../../fixtures/web.mjs";
import { registeredProjects } from "../../../src/core/projects/project-registry.ts";
import { projectHubFixtures } from "../../fixtures/project-hub.mjs";

const { start, project, browse, post } = projectHubFixtures();

test("demo edits are isolated and discarded when the service restarts", async () => {
  const real = await project(),
    before = registeredProjects(),
    web = await start(true);
  const root = web.demonstration()?.root ?? "";
  const original = readFileSync(join(real, "workbench/decisions/ADR-00.md"), "utf8");
  const editor = await (await browse(web.url + "/records/demo:ADR-0?view=edit")).text();
  const saved = await post(web.url + "/actions/save", {
    csrf: hiddenValue(editor, "csrf"),
    expected: hiddenValue(editor, "expected"),
    id: "demo:ADR-0",
    contents: "# Disposable human edit\n",
  });
  expect(saved.status).toBe(303);
  await web.close();
  expect(existsSync(root)).toBe(false);
  expect(registeredProjects()).toEqual(before);
  expect(readFileSync(join(real, "workbench/decisions/ADR-00.md"), "utf8")).toBe(original);
  const restarted = await start(true);
  expect(await (await browse(restarted.url + "/records/demo:ADR-0")).text()).not.toContain("Disposable human edit");
});

test("the demo header returns to Projects and reopening preserves its isolated session", async () => {
  const real = await project(),
    web = await start(true);
  const demoRoot = web.demonstration()?.root;
  const editor = await (await browse(web.url + "/records/demo:ADR-0?view=edit")).text();
  const saved = await post(web.url + "/actions/save", {
    csrf: hiddenValue(editor, "csrf"),
    expected: hiddenValue(editor, "expected"),
    id: "demo:ADR-0",
    contents: "# ADR-0: Retained demo edit\n\nKeep this session when switching projects.\n",
  });
  expect(saved.status).toBe(303);
  const current = await (await browse(web.url)).text();
  expect(parseDOM(current).window.document.querySelector(".project-switch")?.getAttribute("href")).toBe("/projects");
  const dashboard = await (await browse(new URL("/projects", web.url))).text();
  expect(web.demonstration()?.root).toBe(demoRoot);
  expect(dashboard).toContain(real);
  expect(dashboard).not.toContain("Retained demo edit");
  expect(readFileSync(join(real, "workbench/decisions/ADR-00.md"), "utf8")).not.toContain("Retained demo edit");
  const entered = await post(new URL("/demonstration", web.url).href, { csrf: hiddenValue(dashboard, "csrf") });
  expect(entered.status).toBe(303);
  expect(web.demonstration()?.root).toBe(demoRoot);
  expect(await (await browse(web.url + "/records/demo:ADR-0")).text()).toContain("Retained demo edit");
});
