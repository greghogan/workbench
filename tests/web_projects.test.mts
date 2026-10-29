import { readProjects } from "../src/project-configuration.ts";
import { createElement, Fragment } from "preact";
import { renderToString } from "preact-render-to-string";
import { CacheTasks } from "../src/web/cache-worker.ts";
import { parseDOM } from "./fixtures/dom.mjs";
import { withProjectPaths } from "../src/web/project-paths.ts";
import { linkButton, tabs } from "../src/web/render-links.js";
import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { captureOwnedChild } from "../scripts/owned-child.mjs";
import { webFixture, hiddenValue } from "./fixtures/web.mjs";
import { startProjectHub, projectHubEnvironment } from "../src/web/project-hub.ts";
import { registerConsumingProject } from "../src/project-registration.ts";
import {
  registeredProjects,
  projectIdentity,
  projectRegistration,
  declineProject,
  Registration,
} from "../src/project-registry.ts";
import { buildPaths, prepareBuild, buildLockDirectory } from "../src/builds.ts";
import { collectCacheInventory, emptyInventory } from "../src/web/cache-inventory.ts";
import { inventoryPresentation, inventoryPatch } from "../src/web/hub-pages.tsx";
import { inspectBuildCache, pruneBuildCache } from "../src/build-cache.ts";
import * as builderCache from "../src/builder-cache.ts";
import { CacheBusy } from "../src/cache-lock.ts";
const distribution = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startProjectHub>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function start(demo = false) {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const server = await startProjectHub(distribution, { port: 0, demo });
  servers.push(server);
  return server;
}
function project() {
  const root = webFixture();
  roots.push(root);
  registerConsumingProject(root);
  return root;
}
function post(url: string, values: Record<string, string>) {
  return fetch(url, { method: "POST", body: new URLSearchParams(values), redirect: "manual" });
}
test("project browsing does not inherit another checkout's configuration, build destinations, or approval context", () => {
  const user = {
    WORKBENCH_STATE_HOME: "/personal/state",
    WORKBENCH_CACHE_HOME: "/personal/cache",
    WORKBENCH_LOCAL_CONFIG_ROOT: "/other",
    WORKBENCH_POLICY_REVIEW: "other-policy",
    WORKBENCH_STORAGE_PROJECT: "/other",
    WORKBENCH_STORAGE_ROOT: "/other/cache",
    WORKBENCH_BUILD_DIR: "/other/build",
    WORKBENCH_TOOLCHAIN: "other-profile",
  };
  expect(projectHubEnvironment(user)).toEqual({
    WORKBENCH_STATE_HOME: "/personal/state",
    WORKBENCH_CACHE_HOME: "/personal/cache",
  });
  expect(user.WORKBENCH_LOCAL_CONFIG_ROOT).toBe("/other");
  expect(projectHubEnvironment({ WORKBENCH_STORAGE_ROOT: "/explicit/shared" })).toEqual({
    WORKBENCH_STORAGE_ROOT: "/explicit/shared",
  });
});
test("cache generation keeps protect owned products until explicitly released", async () => {
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const root = project(),
    paths = buildPaths(root, root, "native", {}, false);
  prepareBuild(paths);
  writeFileSync(join(paths.directory, "output"), "regenerable product");
  const web = await start();
  const page = await (await fetch(web.url + "/caches?refresh=1")).text();
  const csrf = hiddenValue(page, "csrf");
  expect(page).toContain("Keep generation");
  expect((await post(web.url + "/caches/keep", { csrf, identity: paths.directory, keep: "yes" })).status).toBe(303);
  const preview = await post(web.url + "/projects/remove", { csrf, project: projectIdentity(root) });
  const contents = await (await fetch(new URL(preview.headers.get("location") ?? "", web.url))).text();
  const token = hiddenValue(contents, "token");
  expect((await post(web.url + "/cleanup/apply", { csrf, token, reviewed: "yes" })).status).toBe(409);
  expect(projectRegistration(root)).toBe(Registration.Registered);
  expect(existsSync(paths.directory)).toBe(true);
  expect((await post(web.url + "/caches/keep", { csrf, identity: paths.directory, keep: "no" })).status).toBe(303);
});
test("the dashboard isolates same-namespace projects, routes forms, and verifies removal before changing registration", async () => {
  const first = project(),
    second = project(),
    web = await start();
  const dashboard = await (await fetch(web.url)).text();
  const a = `/p/${projectIdentity(first)}`,
    b = `/p/${projectIdentity(second)}`;
  expect(dashboard).toContain(a);
  expect(dashboard).toContain(b);
  const page = await (await fetch(web.url + a + "/record?id=demo:ADR-0&view=edit")).text();
  expect(page).toContain(`action="${a}/actions/save"`);
  const document = parseDOM(page, { url: web.url }).window.document;
  expect(document.querySelector(".topbar .project-switch")?.getAttribute("href")).toBe("/projects");
  expect(document.querySelector(".topbar .project-switch")?.textContent).toContain("Switch project");
  expect(document.querySelector('.sidebar a[href="/projects"]')).toBeNull();
  expect(document.querySelector(".brand-mark")).not.toBeNull();
  const csrf = hiddenValue(dashboard, "csrf");
  expect((await post(web.url + "/projects/remove", { csrf: "invalid", project: projectIdentity(first) })).status).toBe(
    403,
  );
  const prepared = await post(web.url + "/projects/remove", { csrf, project: projectIdentity(first) });
  expect(prepared.status).toBe(303);
  const preview = await (await fetch(new URL(prepared.headers.get("location") ?? "", web.url))).text();
  expect(preview).toContain("Project files are preserved");
  expect(projectRegistration(first)).toBe(Registration.Registered);
  const token = hiddenValue(preview, "token");
  expect((await post(web.url + "/cleanup/apply", { csrf, token })).status).toBe(400);
  expect((await post(web.url + "/cleanup/apply", { csrf, token, reviewed: "yes" })).status).toBe(303);
  expect(projectRegistration(first)).toBe(Registration.Declined);
  expect(existsSync(join(first, "workbench/CHARTER.md"))).toBe(true);
  expect(projectRegistration(second)).toBe(Registration.Registered);
  expect((await fetch(web.url + a + "/")).status).toBe(404);
  expect((await fetch(web.url + b + "/")).status).toBe(200);
  expect((await fetch(web.url + "/missing")).status).toBe(404);
});
test("the demonstration is offline, editable, reset by restart, and isolated from the personal registry", async ({
  signal,
}) => {
  const real = project(),
    before = registeredProjects(),
    web = await start(true);
  const html = await (await fetch(web.url)).text();
  expect(html).toContain("Demonstration");
  expect(html).not.toContain(real);
  expect(parseDOM(html).window.document.querySelector(".project-switch")?.getAttribute("href")).toBe("/projects");
  const records = await (await fetch(web.url + "/records")).text();
  for (const type of ["ADR", "TSK", "EXP", "ENV", "CIT", "REL"]) expect(records).toContain(`demo:${type}-0`);
  const listed = parseDOM(records).window.document;
  for (const type of ["ADR", "TSK", "EXP", "ENV", "CIT", "REL"])
    expect(listed.querySelectorAll(`[data-record-id^="demo:${type}-"]`).length).toBeGreaterThan(1);
  const declaredName = readProjects(join(distribution, "demo"))[0]?.name;
  if (!declaredName) throw new Error("Missing demonstration display name");
  expect(parseDOM(html).window.document.querySelector(".project-switch-name")?.textContent).toBe(declaredName);
  const queue = parseDOM(await (await fetch(web.url + "/review")).text(), { url: web.url }).window.document;
  const reviewLinks = [...queue.querySelectorAll("article.record-row a[data-card-link]")];
  const paths = reviewLinks.map((link) => new URL(link.getAttribute("href") ?? "", web.url).searchParams.get("id"));
  expect(paths).toEqual(["demo:ADR-0", "demo:EXP-0", "demo:EXP-1"]);
  const pdfPage = await (await fetch(web.url + "/record?id=demo:CIT-0")).text();
  expect(pdfPage).toContain("File present locally");
  const href = /href="([^"]+)">View PDF/.exec(pdfPage)?.[1]?.replaceAll("&amp;", "&");
  expect(href).toBeTruthy();
  const pdf = await fetch(new URL(href ?? "", web.url));
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect((await pdf.text()).startsWith("%PDF-")).toBe(true);
  for (const id of ["demo:CIT-1", "demo:CIT-2"])
    expect(await (await fetch(web.url + "/record?id=" + id)).text()).toContain("File missing locally");
  const collection = await (await fetch(web.url + "/collections")).text();
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
  const original = readFileSync(join(real, "workbench/decisions/ADR-00.md"), "utf8");
  const editor = await (await fetch(web.url + "/record?id=demo:ADR-0&view=edit")).text();
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
  expect(await (await fetch(restarted.url + "/record?id=demo:ADR-0")).text()).not.toContain("Disposable human edit");
});

test("the demo header returns to Projects and reopening preserves its isolated session", async () => {
  const real = project(),
    web = await start(true);
  const demoRoot = web.demonstration()?.root;
  const editor = await (await fetch(web.url + "/record?id=demo:ADR-0&view=edit")).text();
  const saved = await post(web.url + "/actions/save", {
    csrf: hiddenValue(editor, "csrf"),
    expected: hiddenValue(editor, "expected"),
    id: "demo:ADR-0",
    contents: "# ADR-0: Retained demo edit\n\nKeep this session when switching projects.\n",
  });
  expect(saved.status).toBe(303);
  const current = await (await fetch(web.url)).text();
  expect(parseDOM(current).window.document.querySelector(".project-switch")?.getAttribute("href")).toBe("/projects");
  const dashboard = await (await fetch(web.url + "/projects")).text();
  expect(web.demonstration()).toBeUndefined();
  expect(dashboard).toContain(real);
  expect(dashboard).not.toContain("Retained demo edit");
  expect(readFileSync(join(real, "workbench/decisions/ADR-00.md"), "utf8")).not.toContain("Retained demo edit");
  const entered = await post(web.url + "/demonstration", { csrf: hiddenValue(dashboard, "csrf") });
  expect(entered.status).toBe(303);
  expect(web.demonstration()?.root).toBe(demoRoot);
  expect(await (await fetch(web.url + "/record?id=demo:ADR-0")).text()).toContain("Retained demo edit");
});

test("scoped link helpers include PDF routes and tabs without leaking URL context between requests", async () => {
  const [first, second] = await Promise.all(
    ["first", "second"].map((id) =>
      withProjectPaths(`/p/${id}`, async () => {
        await Promise.resolve();
        return renderToString(
          createElement(Fragment, null, [
            linkButton("PDF", "/citation-document?id=demo%3ACIT-0"),
            tabs([{ label: "Review", href: "/review", current: false }], "Views"),
            linkButton("Projects", "/projects"),
            linkButton("External", "https://example.invalid/page"),
          ]),
        );
      }),
    ),
  );
  expect(first).toContain('href="/p/first/citation-document?id=demo%3ACIT-0"');
  expect(first).toContain('href="/p/first/review"');
  expect(first).toContain('href="/projects"');
  expect(first).toContain('href="https://example.invalid/page"');
  expect(second).toContain('href="/p/second/citation-document?id=demo%3ACIT-0"');
  expect(renderToString(linkButton("PDF", "/citation-document"))).toContain('href="/citation-document"');
});

test("inventory updates preserve current project navigation while cache discovery is still pending", async () => {
  const first = project(),
    second = project();
  const scan = vi.spyOn(CacheTasks.prototype, "run").mockImplementation((task, _progress, signal) => {
    if (task.kind !== "inventory") throw new Error("Unexpected cache mutation in navigation fixture");
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new DOMException("Cancelled fixture scan", "AbortError"));
        },
        { once: true },
      );
    });
  });
  const web = await start();
  const page = await (await fetch(web.url + "/projects")).text();
  for (const root of [first, second]) expect(page).toContain(`/p/${projectIdentity(root)}/`);
  const response = await fetch(web.url + "/inventory?view=projects");
  expect(response.status).toBe(200);
  const update = (await response.json()) as { sections: { projects: string }; refreshing: boolean };
  expect(update.refreshing).toBe(true);
  for (const root of [first, second]) expect(update.sections.projects).toContain(`/p/${projectIdentity(root)}/`);
  expect(update.sections.projects).toContain("Calculating…");
  expect(scan).toHaveBeenCalledOnce();
});

test("current registration and display names govern navigation while an older cache snapshot is retained", async () => {
  const first = project();
  const previous = { ...emptyInventory(), projects: registeredProjects() };
  vi.spyOn(CacheTasks.prototype, "run").mockImplementation((task, progress, signal) => {
    if (task.kind !== "inventory") throw new Error("Unexpected cache mutation in navigation fixture");
    progress?.({ kind: "metadata", value: previous });
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new DOMException("Cancelled fixture scan", "AbortError"));
        },
        { once: true },
      );
    });
  });
  const web = await start();
  await fetch(web.url + "/projects");
  const second = project();
  writeFileSync(join(second, "workbench/projects.toml"), '[[project]]\nid="demo"\nname="New Display Name"\npath="."\n');
  declineProject(first, "Removed fixture");
  for (const view of ["projects", "caches"]) {
    const response = await fetch(web.url + `/inventory?view=${view}`);
    const update = (await response.json()) as { sections: { projects: string } };
    expect(update.sections.projects).not.toContain(`/p/${projectIdentity(first)}/`);
    const document = parseDOM(`<table><tbody>${update.sections.projects}</tbody></table>`).window.document;
    const link = document.querySelector(`a[href="/p/${projectIdentity(second)}/"]`);
    expect(link?.textContent).toBe("New Display Name");
    expect(link?.closest("tr")?.querySelector('[data-cache-cell$="-owned"]')?.textContent).toBe("Calculating…");
    expect(
      link?.closest("tr")?.querySelector('[data-cache-cell$="-owned"]')?.getAttribute("data-cache-uncertain"),
    ).toBe("true");
  }
  const page = await (await fetch(web.url + "/projects")).text();
  expect(page).toContain("New Display Name");
  expect(page).toContain("Project directory on the server");
});

test("unresolved cache locks protect deletion while allowing reusable measurements and explicit refresh", async () => {
  vi.spyOn(builderCache, "inspectBuilderCache").mockResolvedValue({ entries: [], issues: [] });
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const root = project(),
    paths = buildPaths(root, root, "native", {}, false);
  prepareBuild(paths);
  writeFileSync(join(paths.directory, "output"), "regenerable product");
  const lock = buildLockDirectory(paths.identity);
  roots.push(lock);
  mkdirSync(lock, { recursive: true });
  const ownership = JSON.stringify({ pid: process.pid, token: "legacy owner without host provenance" });
  writeFileSync(join(lock, "owner.json"), ownership);
  const measured = await collectCacheInventory();
  const size = measured.sizes.find((entry) => entry.directory === paths.directory);
  expect(size).toMatchObject({ state: "ready" });
  expect(size?.bytes).toBeGreaterThan(0);
  expect(measured.inventory.entries.find((entry) => entry.directory === paths.directory)?.blockedBy).toBe(lock);
  await expect(pruneBuildCache({ report: inspectBuildCache(undefined, false, root), apply: true })).rejects.toThrow(
    CacheBusy,
  );
  expect(readFileSync(join(paths.directory, "output"), "utf8")).toBe("regenerable product");
  const render = (value: typeof measured) =>
    inventoryPresentation(
      { ...value, complete: true, refreshing: false, problem: "" },
      registeredProjects(),
      "csrf",
      "projects",
    );
  const initial = inventoryPatch(render(measured));
  const document = parseDOM(`<table><tbody>${initial.sections.projects ?? ""}</tbody></table>`).window.document;
  expect(
    document
      .querySelector(`a[href="/p/${projectIdentity(root)}/"]`)
      ?.closest("tr")
      ?.querySelector('[data-cache-cell$="-retained"]')?.textContent,
  ).toMatch(/^\d+(?:\.\d+)? (?:B|kB|MB|GB)$/);

  writeFileSync(join(paths.directory, "extra"), "more data");
  const retained = await collectCacheInventory();
  expect(retained.sizes.find((entry) => entry.directory === paths.directory)).toMatchObject({
    state: "ready",
    bytes: size?.bytes,
  });
  const retainedPage = inventoryPatch(render(retained));
  const retainedDocument = parseDOM(`<table><tbody>${retainedPage.sections.projects ?? ""}</tbody></table>`).window
    .document;
  const cell = `a[href="/p/${projectIdentity(root)}/"]`;
  expect(
    retainedDocument.querySelector(cell)?.closest("tr")?.querySelector('[data-cache-cell$="-retained"]')?.textContent,
  ).toBe(document.querySelector(cell)?.closest("tr")?.querySelector('[data-cache-cell$="-retained"]')?.textContent);
  const refreshed = await collectCacheInventory(undefined, true);
  expect(refreshed.sizes.find((entry) => entry.directory === paths.directory)).toMatchObject({
    state: "ready",
    bytes: (size?.bytes ?? 0) + 9,
  });
  expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(ownership);

  const failed = retained.sizes.find((entry) => entry.directory === paths.directory);
  if (!failed) throw new Error("Missing fixture measurement");
  failed.state = "error";
  failed.problem = "Fixture permission error";
  delete failed.bytes;
  expect(inventoryPatch(render(retained)).sections.projects).toContain("Unavailable");
});
