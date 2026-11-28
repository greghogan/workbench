import { createElement, Fragment } from "preact";
import { renderToString } from "preact-render-to-string";
import { CacheTasks } from "../../../src/server/cache/cache-worker.ts";
import { parseDOM } from "../../fixtures/dom.mjs";
import { withProjectPaths } from "../../../src/server/routes/project-paths.ts";
import { linkButton, tabs } from "../../../src/server/views/render-links.js";
import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { hiddenValue } from "../../fixtures/web.mjs";
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
import { emptyInventory } from "../../../src/server/cache/cache-inventory.ts";
import { inventoryPresentation, inventoryPatch } from "../../../src/server/views/hub-pages.tsx";
import { ProjectDirectory, availableProjects } from "../../../src/server/projects/project-directory.ts";
import { WorkerGeneration } from "../../../src/server/workspace/worker-generation.ts";
import { WorkspaceMonitor } from "../../../src/server/workspace/live.ts";
import { configureDiagnostics, type DiagnosticEvent } from "../../../src/core/diagnostics/diagnostics.mjs";
import { createServer, get } from "node:http";
import { once } from "node:events";
import { updateUserOption } from "../../../src/core/configuration/user-config.ts";
import { closeLocalServer } from "../../../src/server/http/http-listener.ts";
import { distribution, projectHubFixtures } from "../../fixtures/project-hub.mjs";

const { start, project, signInHeader, browse, post, roots, servers } = projectHubFixtures();

test("the private hub skips an occupied port in the user's configured range", async () => {
  const reservation = createServer((_request, response) => response.end("unrelated listener"));
  try {
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    let address = reservation.address();
    while (address && typeof address !== "string" && address.port === 65535) {
      await closeLocalServer(reservation);
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      address = reservation.address();
    }
    if (!address || typeof address === "string") throw new Error("Expected a loopback port");
    const startingPort = address.port;
    updateUserOption("daemon.private_port", () => startingPort);

    const server = await startProjectHub(distribution);
    servers.push(server);
    const selected = Number(new URL(server.url).port);
    expect(selected).toBeGreaterThan(startingPort);
    expect(selected - startingPort).toBeLessThan(32);
    expect((await browse(server.url)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${String(startingPort)}`)).text()).toBe("unrelated listener");
  } finally {
    await closeLocalServer(reservation);
  }
});

test("private sign-in protects reads, events, and actions and expires on restart", async () => {
  const root = await project(),
    id = projectIdentity(root),
    web = await start();
  for (const route of ["/", "/events", "/metrics", `/projects/${id}/`, "/demonstration/"]) {
    const challenge = await fetch(web.url + route);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe('Basic realm="Workbench", charset="UTF-8"');
    expect(challenge.headers.get("cache-control")).toBe("no-store");
  }
  const dashboard = await (await browse(web.url)).text();
  const csrf = hiddenValue(dashboard, "csrf");
  const unauthorizedAction = await fetch(web.url + "/projects/remove", {
    method: "POST",
    body: new URLSearchParams({ csrf, project: id }),
    headers: { authorization: "Basic wrong-credential" },
  });
  expect(unauthorizedAction.status).toBe(401);
  expect(registeredProjects().some((entry) => entry.id === id)).toBe(true);
  expect((await post(web.url + "/projects/remove", { csrf: "wrong", project: id })).status).toBe(403);
  expect((await browse(web.url + "/metrics")).status).toBe(200);

  const expired = signInHeader(web);
  await web.close();
  const restarted = await start();
  expect((await fetch(restarted.url, { headers: { authorization: expired } })).status).toBe(401);
  expect((await browse(restarted.url)).status).toBe(200);
});

test("record bookmarks cold-load across service restarts and checkout relocation without old route aliases", async () => {
  const root = await project(),
    id = projectIdentity(root),
    web = await start();
  const bookmark = `/projects/${id}/records/demo:ADR-0`;
  const view = await browse(web.url + bookmark);
  expect(view.status).toBe(200);
  expect(await view.text()).toContain("Keep files authoritative");
  expect((await browse(web.url + `/p/${id}/record?id=demo:ADR-0`)).status).toBe(404);
  expect((await browse(web.url + `/projects/${id}/record?id=demo:ADR-0`)).status).toBe(404);
  expect((await browse(web.url + bookmark + "?id=demo:ADR-0")).status).toBe(400);
  const decision = join(root, "workbench/decisions/ADR-00.md");
  writeFileSync(decision, readFileSync(decision, "utf8") + "\nReview the relocated decision.\n");
  const moved = root + "-moved";
  renameSync(root, moved);
  roots.push(moved);
  await relocateConsumingProject(root, moved);
  expect((await browse(web.url + bookmark)).status).toBe(200);
  await web.close();
  const restarted = await start();
  const cold = await browse(restarted.url + bookmark + "/review?layout=unified");
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
  const request = get(web.url + `/projects/${projectIdentity(root)}/`, {
    headers: { authorization: signInHeader(web) },
  });
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
  expect((await browse(web.url + `/projects/${projectIdentity(root)}/`)).status).toBe(200);
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

test("the dashboard isolates same-namespace projects, routes forms, and verifies removal before changing registration", async () => {
  const first = await project(),
    second = await project(),
    web = await start();
  const dashboard = await (await browse(web.url)).text();
  const a = `/projects/${projectIdentity(first)}`,
    b = `/projects/${projectIdentity(second)}`;
  expect(dashboard).toContain(a);
  expect(dashboard).toContain(b);
  const page = await (await browse(web.url + a + "/records/demo:ADR-0?view=edit")).text();
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
  const preview = await (await browse(new URL(prepared.headers.get("location") ?? "", web.url))).text();
  expect(preview).toContain("Project files are preserved");
  expect(projectRegistration(first)).toBe(Registration.Registered);
  const token = hiddenValue(preview, "token");
  expect((await post(web.url + "/cleanup/apply", { csrf, token })).status).toBe(400);
  expect((await post(web.url + "/cleanup/apply", { csrf, token, reviewed: "yes" })).status).toBe(303);
  expect(projectRegistration(first)).toBe(Registration.Declined);
  expect(existsSync(join(first, "workbench/CHARTER.md"))).toBe(true);
  expect(projectRegistration(second)).toBe(Registration.Registered);
  expect((await browse(web.url + a + "/")).status).toBe(404);
  expect((await browse(web.url + b + "/")).status).toBe(200);
  expect((await browse(web.url + "/missing")).status).toBe(404);
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
  await browse(new URL("/projects", web.url));
  const second = await project();
  writeFileSync(join(second, "workbench/projects.toml"), '[[project]]\nid="demo"\nname="New Display Name"\npath="."\n');
  declineProject(first, "Removed fixture");
  for (const view of ["projects", "caches"]) {
    const response = await browse(web.url + `/inventory?view=${view}`);
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
  const page = await (await browse(new URL("/projects", web.url))).text();
  expect(page).toContain("New Display Name");
  expect(page).toContain("Project directory on the server");
});
