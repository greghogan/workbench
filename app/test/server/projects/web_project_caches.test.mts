import { cacheTask, CacheTasks } from "../../../src/server/cache/cache-worker.ts";
import { parseDOM } from "../../fixtures/dom.mjs";
import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hiddenValue } from "../../fixtures/web.mjs";
import {
  registeredProjects,
  projectIdentity,
  projectRegistration,
  Registration,
} from "../../../src/core/projects/project-registry.ts";
import { buildPaths, prepareBuild, buildLockDirectory } from "../../../src/core/artifacts/builds.ts";
import { collectCacheInventory } from "../../../src/server/cache/cache-inventory.ts";
import { inventoryPresentation, inventoryPatch } from "../../../src/server/views/hub-pages.tsx";
import { inspectBuildCache, pruneBuildCache } from "../../../src/core/storage/build-cache.ts";
import * as builderCache from "../../../src/core/storage/builder-cache.ts";
import { CacheBusy } from "../../../src/core/storage/cache-lock.ts";
import { reviewStatus, approveReviewFiles, ReviewSource } from "../../../src/core/review/review-service.ts";
import { formatPendingReviews } from "../../../src/core/review/review-formatting.ts";
import { projectHubFixtures } from "../../fixtures/project-hub.mjs";

const { start, project, browse, post, roots } = projectHubFixtures();

test("cache generation keeps protect owned products until explicitly released", async () => {
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const root = await project(),
    paths = buildPaths(root, root, "native", {}, false);
  prepareBuild(paths);
  writeFileSync(join(paths.directory, "output"), "regenerable product");
  const web = await start();
  const page = await (await browse(web.url + "/caches?refresh=1")).text();
  const csrf = hiddenValue(page, "csrf");
  expect(page).toContain("Keep generation");
  expect((await post(web.url + "/caches/keep", { csrf, identity: paths.directory, keep: "yes" })).status).toBe(303);
  const preview = await post(web.url + "/projects/remove", { csrf, project: projectIdentity(root) });
  const contents = await (await browse(new URL(preview.headers.get("location") ?? "", web.url))).text();
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
      page = await (await browse(web.url + "/caches")).text();
      expect(page).toContain("unowned build directory");
    },
    { timeout: 30000 },
  );
  const csrf = hiddenValue(page, "csrf");
  const preview = async () => {
    const response = await post(web.url + "/caches/recover", { csrf, directory: paths.directory });
    expect(response.status).toBe(303);
    const content = await (await browse(new URL(response.headers.get("location") ?? "", web.url))).text();
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
  const page = await (await browse(new URL("/projects", web.url))).text();
  for (const root of [first, second]) expect(page).toContain(`/projects/${projectIdentity(root)}/`);
  const response = await browse(web.url + "/inventory?view=projects");
  expect(response.status).toBe(200);
  const update = (await response.json()) as { sections: { projects: string }; refreshing: boolean };
  expect(update.refreshing).toBe(true);
  for (const root of [first, second]) expect(update.sections.projects).toContain(`/projects/${projectIdentity(root)}/`);
  expect(update.sections.projects).toContain("Calculating…");
  expect(scan).toHaveBeenCalledOnce();
});

test("filesystem totals are available while another project's Docker usage is pending", async () => {
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const first = await project(),
    second = await project();
  for (const root of [first, second]) {
    const paths = buildPaths(root, root, "native", {}, false);
    prepareBuild(paths);
    writeFileSync(join(paths.directory, "output"), Buffer.alloc(8000));
  }

  const builders = Promise.withResolvers<builderCache.BuilderCacheReport>();
  vi.spyOn(builderCache, "inspectBuilderCache").mockImplementation((_checkout, _signal, _measure, _held, owners) => {
    owners?.([second]);
    return builders.promise;
  });
  vi.spyOn(CacheTasks.prototype, "run").mockImplementation((task, progress, signal) =>
    cacheTask(task, progress, signal),
  );
  const web = await start();
  const totals = async () => {
    const response = await browse(web.url + "/inventory?view=projects");
    const update = (await response.json()) as { sections: { projects: string }; refreshing: boolean };
    const document = parseDOM(`<table><tbody>${update.sections.projects}</tbody></table>`).window.document;
    return [first, second].map(
      (root) =>
        document
          .querySelector(`a[href="/projects/${projectIdentity(root)}/"]`)
          ?.closest("tr")
          ?.querySelector('[data-cache-cell$="-owned"]')?.textContent,
    );
  };
  try {
    await vi.waitFor(async () => {
      const [local, docker] = await totals();
      expect(local).toMatch(/^\d+(?:\.\d+)? kB$/);
      expect(docker).toBe("Calculating…");
    });
  } finally {
    builders.resolve({
      entries: [
        { key: "docker", checkout: second, builder: "buildkit", volumes: [], bytes: 1_000_000 },
        { key: "shared-profile", checkout: first, builder: "guix", volumes: [], bytes: undefined },
      ],
      issues: [],
    });
  }
  await vi.waitFor(async () => {
    const [local, docker] = await totals();
    expect(local).toMatch(/^\d+(?:\.\d+)? kB$/);
    expect(docker).toMatch(/^\d+(?:\.\d+)? MB$/);
  });
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
  const initial = parseDOM(await (await browse(web.url + "/projects")).text()).window.document;
  expect([...initial.querySelectorAll("table th")].map((heading) => heading.textContent)).toEqual([
    "Project",
    "Reviews",
    "Cache",
    "Actions",
  ]);
  const counts = async () => {
    const response = await browse(web.url + "/inventory?view=projects");
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
