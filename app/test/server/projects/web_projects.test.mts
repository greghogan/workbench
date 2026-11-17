import { readProjects } from "../../../src/core/projects/project-configuration.ts";
import { createElement, Fragment } from "preact";
import { renderToString } from "preact-render-to-string";
import { CacheTasks } from "../../../src/server/cache/cache-worker.ts";
import { parseDOM } from "../../fixtures/dom.mjs";
import { withProjectPaths } from "../../../src/server/routes/project-paths.ts";
import { linkButton, tabs } from "../../../src/server/views/render-links.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { captureOwnedChild } from "../../../src/core/runtime/owned-child.mjs";
import { webFixture, hiddenValue } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { startProjectHub, projectHubEnvironment } from "../../../src/server/projects/project-hub.ts";
import {
  registerConsumingProject,
  registeredProjectGroups,
  relocateConsumingProject,
} from "../../../src/core/projects/project-registration.ts";
import {
  registeredProjects,
  projectIdentity,
  projectRegistration,
  declineProject,
  Registration,
} from "../../../src/core/projects/project-registry.ts";
import { buildPaths, prepareBuild, buildLockDirectory } from "../../../src/core/artifacts/builds.ts";
import { collectCacheInventory, emptyInventory } from "../../../src/server/cache/cache-inventory.ts";
import { inventoryPresentation, inventoryPatch } from "../../../src/server/views/hub-pages.tsx";
import { inspectBuildCache, pruneBuildCache } from "../../../src/core/storage/build-cache.ts";
import * as builderCache from "../../../src/core/storage/builder-cache.ts";
import { CacheBusy } from "../../../src/core/storage/cache-lock.ts";
import { reviewStatus, approveReviewFiles, ReviewSource } from "../../../src/core/review/review-service.ts";
import { formatPendingReviews } from "../../../src/core/review/review-formatting.ts";
import { ProjectDirectory, availableProjects } from "../../../src/server/projects/project-directory.ts";
import { WorkerGeneration } from "../../../src/server/workspace/worker-generation.ts";
import { WorkspaceMonitor } from "../../../src/server/workspace/live.ts";
import { configureDiagnostics, type DiagnosticEvent } from "../../../src/core/diagnostics/diagnostics.mjs";
import { get } from "node:http";
const distribution = resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startProjectHub>>[] = [];
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "workbench-project-browser-"));
  roots.push(home);
  for (const kind of ["CONFIG", "CACHE", "DATA", "STATE"])
    vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(home, kind.toLowerCase()));
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  configureDiagnostics();
});
async function start(demo = false) {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const server = await startProjectHub(distribution, { port: 0, demo });
  servers.push(server);
  return server;
}
async function project() {
  const root = webFixture();
  roots.push(root);
  await registerConsumingProject(root);
  return root;
}
function post(url: string, values: Record<string, string>) {
  return fetch(url, { method: "POST", body: new URLSearchParams(values), redirect: "manual" });
}
test("record bookmarks cold-load across service restarts and checkout relocation without old route aliases", async () => {
  const root = await project(),
    id = projectIdentity(root),
    web = await start();
  const bookmark = `/projects/${id}/records/demo:ADR-0`;
  const view = await fetch(web.url + bookmark);
  expect(view.status).toBe(200);
  expect(await view.text()).toContain("Keep files authoritative");
  expect((await fetch(web.url + `/p/${id}/record?id=demo:ADR-0`)).status).toBe(404);
  expect((await fetch(web.url + `/projects/${id}/record?id=demo:ADR-0`)).status).toBe(404);
  expect((await fetch(web.url + bookmark + "?id=demo:ADR-0")).status).toBe(400);
  const decision = join(root, "workbench/decisions/ADR-00.md");
  writeFileSync(decision, readFileSync(decision, "utf8") + "\nReview the relocated decision.\n");
  const moved = root + "-moved";
  renameSync(root, moved);
  roots.push(moved);
  await relocateConsumingProject(root, moved);
  expect((await fetch(web.url + bookmark)).status).toBe(200);
  await web.close();
  const restarted = await start();
  const cold = await fetch(restarted.url + bookmark + "/review?layout=unified");
  expect(cold.status).toBe(200);
  const document = parseDOM(await cold.text()).window.document;
  expect(document.querySelector('nav[aria-label="Difference layout"] [aria-current="page"]')?.textContent).toBe(
    "Unified",
  );
  expect(document.body.dataset.eventsUrl).toBe(`/projects/${id}/events?scope=demo`);
});

test("linked worktrees share one dashboard entry while retaining independent navigation and cache ownership", async () => {
  const main = await project(),
    independent = await project(),
    checkout = main + "-linked worktree";
  roots.push(checkout);
  git(main, "worktree", "add", "--detach", checkout, "HEAD");
  await registerConsumingProject(checkout);
  const projects = registeredProjects(),
    data = { ...emptyInventory(), complete: true, refreshing: false, problem: "" };
  const render = (page: "projects" | "caches") =>
    parseDOM(
      `<table><tbody>${inventoryPatch(inventoryPresentation(data, projects, "csrf", page)).sections.projects ?? ""}</tbody></table>`,
    ).window.document;
  const dashboard = render("projects"),
    mainLink = dashboard.querySelector(`a[href="/projects/${projectIdentity(main)}/"]`),
    worktrees = mainLink?.closest("tr")?.querySelector("details");
  expect(dashboard.querySelectorAll("tr")).toHaveLength(2);
  expect(worktrees?.open).toBe(false);
  expect(worktrees?.querySelector(`a[href="/projects/${projectIdentity(checkout)}/"]`)?.textContent).toBe(
    basename(checkout),
  );
  expect(worktrees?.querySelector(`a[href="/caches?project=${projectIdentity(checkout)}"]`)).not.toBeNull();
  expect(dashboard.querySelector(`a[href="/projects/${projectIdentity(independent)}/"]`)?.closest("tr")).not.toBe(
    mainLink?.closest("tr"),
  );
  expect(render("caches").querySelectorAll("tr")).toHaveLength(3);
  expect(registeredProjects()).toEqual(projects);

  const linked = projects.find((entry) => entry.path === checkout),
    primary = projects.find((entry) => entry.path === main);
  if (!linked || !primary) throw new Error("Missing registered fixture checkouts");
  expect(registeredProjectGroups([linked, primary])).toEqual([{ project: primary, worktrees: [linked] }]);
  expect(registeredProjectGroups([linked])).toEqual([{ project: linked, worktrees: [] }]);
  const generation = new WorkerGeneration(distribution),
    directory = new ProjectDirectory(generation.path);
  try {
    const before = await directory.read();
    expect(availableProjects(before)).toContainEqual(linked);
    const saved = checkout + "-saved";
    roots.push(saved);
    renameSync(checkout, saved);
    const absent = await directory.read();
    expect(absent.groups.find((group) => group.project.id === primary.id)?.worktrees).toContainEqual(linked);
    expect(availableProjects(absent)).not.toContainEqual(linked);
    const page = parseDOM(
      `<table>${inventoryPatch(inventoryPresentation(data, projects, "csrf", "projects", undefined, undefined, absent)).sections.projects ?? ""}</table>`,
    ).window.document;
    expect(page.querySelectorAll("tr")).toHaveLength(2);
    expect(page.querySelector(`[data-project-reviews="${linked.id}"]`)).toBeNull();
    expect(page.querySelector("[data-worktree-list]")?.textContent).toContain("Unavailable");
    expect(registeredProjects()).toEqual(projects);
    mkdirSync(checkout);
    writeFileSync(join(checkout, "workbench-placeholder"), "restored checkout location");
    // Availability requires a Workbench project, rather than an unrelated directory reusing the path.
    expect(availableProjects(await directory.read())).not.toContainEqual(linked);
    rmSync(checkout, { recursive: true });
    renameSync(saved, checkout);
    expect(availableProjects(await directory.read())).toContainEqual(linked);
  } finally {
    await directory.close();
    generation.close();
  }
  rmSync(main, { recursive: true, force: true });
  expect(registeredProjectGroups([primary, linked])).toHaveLength(2);
});

test("canceling a cold project navigation records cancellation without a spurious server failure", async () => {
  const events: DiagnosticEvent[] = [];
  configureDiagnostics({
    level: "debug",
    format: "json",
    sink: (text) => events.push(JSON.parse(text) as DiagnosticEvent),
  });
  const root = await project(),
    web = await start();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = vi.spyOn(WorkspaceMonitor.prototype, "ready");
  ready.mockImplementationOnce(async function (this: WorkspaceMonitor) {
    entered();
    await gate;
    ready.mockRestore();
    await this.ready();
  });
  const request = get(web.url + `/projects/${projectIdentity(root)}/`);
  const disconnected = new Promise<void>((resolve) => {
    request.once("error", () => {
      resolve();
    });
  });
  try {
    await waiting;
    request.destroy();
    await disconnected;
    await vi.waitFor(() => {
      expect(events.some((event) => event.operation === "web.request" && event.outcome === "cancelled")).toBe(true);
    });
    expect(events.filter((event) => event.operation === "web.request" && event.outcome === "failed")).toEqual([]);
  } finally {
    release();
  }
  expect((await fetch(web.url + `/projects/${projectIdentity(root)}/`)).status).toBe(200);
});
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
  const root = await project(),
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
test("clearing caches refreshes the project total and preserves another project's measured size", async () => {
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const first = await project(),
    second = await project();
  for (const [root, bytes] of [
    [first, 8000],
    [second, 2000],
  ] as const) {
    const paths = buildPaths(root, root, "native", {}, false);
    prepareBuild(paths);
    writeFileSync(join(paths.directory, "output"), Buffer.alloc(bytes));
  }
  const web = await start();
  const dashboard = await (await browse(web.url + "/projects")).text();
  const csrf = hiddenValue(dashboard, "csrf");
  const totals = async () => {
    const patch = (await (await browse(web.url + "/inventory?view=projects")).json()) as {
      sections: { projects: string };
    };
    const table = parseDOM(`<table><tbody>${patch.sections.projects}</tbody></table>`).window.document;
    return [first, second].map(
      (root) =>
        table
          .querySelector(`a[href="/projects/${projectIdentity(root)}/"]`)
          ?.closest("tr")
          ?.querySelector('[data-cache-cell$="-owned"]')?.textContent,
    );
  };
  let previous: (string | undefined)[] = [];
  await vi.waitFor(async () => {
    previous = await totals();
    expect(previous[0]).toMatch(/^\d+(?:\.\d+)? kB$/);
    expect(previous[1]).toMatch(/^\d+(?:\.\d+)? kB$/);
  });
  const prepared = await post(web.url + "/caches/prepare", { csrf, project: projectIdentity(first) });
  expect(prepared.status).toBe(303);
  const preview = await (await browse(new URL(prepared.headers.get("location") ?? "", web.url))).text();
  const token = hiddenValue(preview, "token");
  expect((await post(web.url + "/cleanup/apply", { csrf, token, reviewed: "yes" })).status).toBe(303);
  await vi.waitFor(async () => {
    expect(await totals()).toEqual(["0 B", previous[1]]);
  });
});
test("uncertain cache cleanup previews the exact selection and rejects stale confirmation before a fresh review", async () => {
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const root = await project(),
    paths = buildPaths(root, root, "native", {}, false);
  prepareBuild(paths);
  writeFileSync(join(paths.directory, "output"), "unowned generated data");
  rmSync(join(paths.directory, ".workbench-build.json"));
  const web = await start();
  let page = "";
  await vi.waitFor(
    async () => {
      page = await (await fetch(web.url + "/caches")).text();
      expect(page).toContain("unowned build directory");
    },
    { timeout: 30000 },
  );
  const csrf = hiddenValue(page, "csrf");
  const preview = async () => {
    const response = await post(web.url + "/caches/recover", { csrf, directory: paths.directory });
    expect(response.status).toBe(303);
    const content = await (await fetch(new URL(response.headers.get("location") ?? "", web.url))).text();
    expect(content).toContain("Delete uncertain cache files");
    expect(content).toContain(paths.directory);
    return hiddenValue(content, "token");
  };
  const token = await preview();
  expect(existsSync(paths.directory)).toBe(true);
  writeFileSync(join(paths.directory, "later-output"), "preserve new work");
  expect((await post(web.url + "/cleanup/apply", { csrf, token, reviewed: "yes" })).status).toBe(409);
  expect(readFileSync(join(paths.directory, "later-output"), "utf8")).toBe("preserve new work");
  // The new preview must observe the changed files, independently of the stale page's cached inventory.
  const fresh = await preview();
  expect((await post(web.url + "/cleanup/apply", { csrf, token: fresh, reviewed: "yes" })).status).toBe(303);
  expect(existsSync(paths.directory)).toBe(false);
  expect(existsSync(paths.dependencies)).toBe(true);
});
test("the dashboard isolates same-namespace projects, routes forms, and verifies removal before changing registration", async () => {
  const first = await project(),
    second = await project(),
    web = await start();
  const dashboard = await (await fetch(web.url)).text();
  const a = `/projects/${projectIdentity(first)}`,
    b = `/projects/${projectIdentity(second)}`;
  expect(dashboard).toContain(a);
  expect(dashboard).toContain(b);
  const page = await (await fetch(web.url + a + "/records/demo:ADR-0?view=edit")).text();
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
  const real = await project(),
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
  const queue = parseDOM(await (await fetch(web.url + "/reviews")).text(), { url: web.url }).window.document;
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
  const pdfPage = await (await fetch(web.url + "/records/demo:CIT-0")).text();
  expect(pdfPage).toContain("File present locally");
  const href = [...parseDOM(pdfPage).window.document.querySelectorAll(".citation-source .actions a")]
    .find((link) => link.textContent === "Read")
    ?.getAttribute("href");
  expect(href).toBeTruthy();
  const pdf = await fetch(new URL(href ?? "", web.url));
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect((await pdf.text()).startsWith("%PDF-")).toBe(true);
  for (const id of ["demo:CIT-1", "demo:CIT-2"])
    expect(await (await fetch(web.url + "/records/" + id)).text()).toContain("File missing locally");
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
  const editor = await (await fetch(web.url + "/records/demo:ADR-0?view=edit")).text();
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
  expect(await (await fetch(restarted.url + "/records/demo:ADR-0")).text()).not.toContain("Disposable human edit");
});

test("the demo header returns to Projects and reopening preserves its isolated session", async () => {
  const real = await project(),
    web = await start(true);
  const demoRoot = web.demonstration()?.root;
  const editor = await (await fetch(web.url + "/records/demo:ADR-0?view=edit")).text();
  const saved = await post(web.url + "/actions/save", {
    csrf: hiddenValue(editor, "csrf"),
    expected: hiddenValue(editor, "expected"),
    id: "demo:ADR-0",
    contents: "# ADR-0: Retained demo edit\n\nKeep this session when switching projects.\n",
  });
  expect(saved.status).toBe(303);
  const current = await (await fetch(web.url)).text();
  expect(parseDOM(current).window.document.querySelector(".project-switch")?.getAttribute("href")).toBe("/projects");
  const dashboard = await (await fetch(new URL("/projects", web.url))).text();
  expect(web.demonstration()?.root).toBe(demoRoot);
  expect(dashboard).toContain(real);
  expect(dashboard).not.toContain("Retained demo edit");
  expect(readFileSync(join(real, "workbench/decisions/ADR-00.md"), "utf8")).not.toContain("Retained demo edit");
  const entered = await post(new URL("/demonstration", web.url).href, { csrf: hiddenValue(dashboard, "csrf") });
  expect(entered.status).toBe(303);
  expect(web.demonstration()?.root).toBe(demoRoot);
  expect(await (await fetch(web.url + "/records/demo:ADR-0")).text()).toContain("Retained demo edit");
});

test("scoped link helpers include PDF routes and tabs without leaking URL context between requests", async () => {
  const [first, second] = await Promise.all(
    ["first", "second"].map((id) =>
      withProjectPaths(`/projects/${id}`, async () => {
        await Promise.resolve();
        return renderToString(
          createElement(Fragment, null, [
            linkButton("PDF", "/records/demo:CIT-0/document"),
            tabs([{ label: "Review", href: "/reviews", current: false }], "Views"),
            linkButton("Projects", "/projects"),
            linkButton("External", "https://example.invalid/page"),
          ]),
        );
      }),
    ),
  );
  expect(first).toContain('href="/projects/first/records/demo:CIT-0/document"');
  expect(first).toContain('href="/projects/first/reviews"');
  expect(first).toContain('href="/projects"');
  expect(first).toContain('href="https://example.invalid/page"');
  expect(second).toContain('href="/projects/second/records/demo:CIT-0/document"');
  expect(renderToString(linkButton("PDF", "/citation-document"))).toContain('href="/citation-document"');
});

test("inventory updates preserve current project navigation while cache discovery is still pending", async () => {
  const first = await project(),
    second = await project();
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
  const page = await (await fetch(new URL("/projects", web.url))).text();
  for (const root of [first, second]) expect(page).toContain(`/projects/${projectIdentity(root)}/`);
  const response = await fetch(web.url + "/inventory?view=projects");
  expect(response.status).toBe(200);
  const update = (await response.json()) as { sections: { projects: string }; refreshing: boolean };
  expect(update.refreshing).toBe(true);
  for (const root of [first, second]) expect(update.sections.projects).toContain(`/projects/${projectIdentity(root)}/`);
  expect(update.sections.projects).toContain("Calculating…");
  expect(scan).toHaveBeenCalledOnce();
});

test("project review counts load independently of cache sizes, group supporting files, and follow acknowledgments", async () => {
  const first = await project(),
    second = await project();
  const decision = join(first, "workbench/decisions/ADR-00.md");
  writeFileSync(decision, readFileSync(decision, "utf8") + "\nA pending decision.\n");
  mkdirSync(join(first, "workbench/decisions/ADR-00"));
  writeFileSync(join(first, "workbench/decisions/ADR-00/evidence.txt"), "Supporting evidence.\n");
  mkdirSync(join(first, "workbench/environments"), { recursive: true });
  writeFileSync(join(first, "workbench/environments/ENV-00.md"), "---\n{}\n---\n\n# ENV-0: Review environment\n");
  await formatPendingReviews(first);
  vi.spyOn(CacheTasks.prototype, "run").mockImplementation((task, _progress, signal) => {
    if (task.kind !== "inventory") throw new Error("Unexpected cache mutation in review-count fixture");
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new DOMException("Cancelled fixture scan", "AbortError"));
        },
        {
          once: true,
        },
      );
    });
  });
  const web = await start();
  const initial = parseDOM(await (await fetch(web.url + "/projects")).text()).window.document;
  expect([...initial.querySelectorAll("table th")].map((heading) => heading.textContent)).toEqual([
    "Project",
    "Reviews",
    "Cache",
    "Actions",
  ]);
  const counts = async () => {
    const response = await fetch(web.url + "/inventory?view=projects");
    expect(response.status).toBe(200);
    const update = (await response.json()) as { sections: { projects: string } };
    return parseDOM(`<table><tbody>${update.sections.projects}</tbody></table>`).window.document;
  };
  const count = (document: Document, root: string) =>
    document.querySelector(`[data-cache-cell$="-reviews"] a[href="/projects/${projectIdentity(root)}/reviews"]`)
      ?.textContent;
  await vi.waitFor(
    async () => {
      const document = await counts();
      expect(count(document, first)).toBe("2");
      expect(count(document, second)).toBe("0");
      expect(document.querySelector('[data-cache-cell$="-owned"]')?.textContent).toBe("Calculating…");
    },
    { timeout: 15_000 },
  );
  const pending = reviewStatus(first, ReviewSource.Working).changes.filter((change) => !change.approved);
  approveReviewFiles(first, pending, true, ReviewSource.Working);
  await vi.waitFor(
    async () => {
      expect(count(await counts(), first)).toBe("0");
    },
    { timeout: 15_000 },
  );
});

test("current registration and display names govern navigation while an older cache snapshot is retained", async () => {
  const first = await project();
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
  await fetch(new URL("/projects", web.url));
  const second = await project();
  writeFileSync(join(second, "workbench/projects.toml"), '[[project]]\nid="demo"\nname="New Display Name"\npath="."\n');
  declineProject(first, "Removed fixture");
  for (const view of ["projects", "caches"]) {
    const response = await fetch(web.url + `/inventory?view=${view}`);
    const update = (await response.json()) as { sections: { projects: string } };
    expect(update.sections.projects).not.toContain(`/projects/${projectIdentity(first)}/`);
    const document = parseDOM(`<table><tbody>${update.sections.projects}</tbody></table>`).window.document;
    const link = document.querySelector(`a[href="/projects/${projectIdentity(second)}/"]`);
    expect(link?.textContent).toBe("New Display Name");
    expect(link?.closest("tr")?.querySelector('[data-cache-cell$="-owned"]')?.textContent).toBe("Calculating…");
    expect(
      link?.closest("tr")?.querySelector('[data-cache-cell$="-owned"]')?.getAttribute("data-cache-uncertain"),
    ).toBe("true");
  }
  const page = await (await fetch(new URL("/projects", web.url))).text();
  expect(page).toContain("New Display Name");
  expect(page).toContain("Project directory on the server");
});

test("unresolved cache locks protect deletion while allowing reusable measurements and explicit refresh", async () => {
  vi.spyOn(builderCache, "inspectBuilderCache").mockResolvedValue({ entries: [], issues: [] });
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const root = await project(),
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
      .querySelector(`a[href="/projects/${projectIdentity(root)}/"]`)
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
  const cell = `a[href="/projects/${projectIdentity(root)}/"]`;
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
