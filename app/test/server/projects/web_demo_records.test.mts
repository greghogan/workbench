import { readProjects } from "../../../src/core/projects/project-configuration.ts";
import { parseDOM } from "../../fixtures/dom.mjs";
import { expect, test } from "vitest";
import { join, dirname } from "node:path";
import { captureOwnedChild } from "../../../src/core/runtime/owned-child.mjs";
import { hiddenValue } from "../../fixtures/web.mjs";
import { registeredProjects } from "../../../src/core/projects/project-registry.ts";
import { distribution, projectHubFixtures } from "../../fixtures/project-hub.mjs";

const { start, project, browse, post } = projectHubFixtures();

test("the demonstration exposes its records and citations offline without using the personal registry", async ({
  signal,
}) => {
  const real = await project(),
    before = registeredProjects(),
    web = await start(true);
  const html = await (await browse(web.url)).text();
  expect(html).toContain("Demonstration");
  expect(html).not.toContain(real);
  expect(parseDOM(html).window.document.querySelector(".project-switch")?.getAttribute("href")).toBe("/projects");
  const hubAuthority = new URL(web.url).host;
  expect((await browse(`${web.url}//${hubAuthority}/projects`)).status).toBe(400);
  const records = await (await browse(web.url + "/records")).text();
  for (const type of ["ADR", "TSK", "EXP", "ENV", "CIT", "REL"]) expect(records).toContain(`demo:${type}-0`);
  const listed = parseDOM(records).window.document;
  for (const type of ["ADR", "TSK", "EXP", "ENV", "CIT", "REL"])
    expect(listed.querySelectorAll(`[data-record-id^="demo:${type}-"]`).length).toBeGreaterThan(1);
  const declaredName = readProjects(join(distribution, "demo"))[0]?.name;
  if (!declaredName) throw new Error("Missing demonstration display name");
  expect(parseDOM(html).window.document.querySelector(".project-switch-name")?.textContent).toBe(declaredName);
  const queue = parseDOM(await (await browse(web.url + "/reviews")).text(), { url: web.url }).window.document;
  const reviewLinks = [
    ...queue.querySelectorAll('.review-group:not([data-task-group^="task:"]) article.record-row a[data-card-link]'),
  ];
  const paths = reviewLinks.map((link) => link.closest("[data-record-id]")?.getAttribute("data-record-id"));
  expect(paths).toEqual(["demo:ADR-0", "demo:EXP-0"]);
  expect(
    [...queue.querySelectorAll('[data-task-group="task:demo:TSK-7"] [data-record-id]')].map((node) =>
      node.getAttribute("data-record-id"),
    ),
  ).toEqual(["demo:ADR-1", "demo:TSK-7"]);
  const pdfPage = await (await browse(web.url + "/records/demo:CIT-0")).text();
  expect(pdfPage).toContain("File present locally");
  const href = [...parseDOM(pdfPage).window.document.querySelectorAll(".citation-source .actions a")]
    .find((link) => link.textContent === "Read")
    ?.getAttribute("href");
  expect(href).toBeTruthy();
  const pdf = await browse(new URL(href ?? "", web.url));
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect((await pdf.text()).startsWith("%PDF-")).toBe(true);
  for (const id of ["demo:CIT-1", "demo:CIT-2"])
    expect(await (await browse(web.url + "/records/" + id)).text()).toContain("File missing locally");
  const collection = await (await browse(web.url + "/collections")).text();
  expect(collection).toContain(web.demonstration()?.source);
  expect(process.env.WORKBENCH_DEMONSTRATION_ROOT).toBeUndefined();
  const rejected = await post(web.url + "/actions/collection-preview", {
    csrf: hiddenValue(collection, "csrf"),
    source: "https://example.invalid/repo",
    commit: "a".repeat(40),
    visibility: "public",
  });
  expect(rejected.status).toBe(400);
  const root = web.demonstration()?.root ?? "";
  const validated = await captureOwnedChild(
    process.execPath,
    [join(distribution, "bundle/main.cjs"), "validate"],
    {
      cwd: root,
      env: {
        ...process.env,
        ...Object.fromEntries(
          ["STATE", "DATA", "CONFIG", "CACHE"].map((kind) => [
            `WORKBENCH_${kind}_HOME`,
            join(dirname(root), kind.toLowerCase()),
          ]),
        ),
        WORKBENCH_PROJECT_ROOT: root,
        WORKBENCH_LOCAL_CONFIG_ROOT: root,
        WORKBENCH_DEMONSTRATION_ROOT: root,
      },
      signal,
    },
    1024 * 1024,
  );
  expect(validated.status, validated.stdout + validated.stderr).toBe(0);
  expect(registeredProjects()).toEqual(before);
});
