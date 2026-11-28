export const BrowserScenario = {
  Diagrams: "Offline Mermaid diagrams and safe source fallback",
  Accessibility: "Automated accessibility evidence",
  Projects: "Projects dashboard, cache inventory, and accessible reference previews",
  Search: "Search and ADR differences",
  Paragraphs: "Paragraph differences ignore soft wrapping",
  Reviews: "Drafts and record review",
  Collections: "Collection preview and adaptations",
  Compatibility: "Policy incompatibility proposals in the unified review queue",
  Metadata: "Bibliographic and record metadata",
  Citations: "Retained citation documents",
  Performance: "Document loading performance",
  Tasks: "Human task decisions and local execution queue",
  Windows: "Incremental record windows",
  Live: "Live updates and focus",
  Responsive: "Narrow windows and accessibility preferences",
  Sources: "Nested project names, source hierarchy, and global search",
  Demonstration: "Isolated demonstration and bundled collection preview",
} as const;
import { accessibilityEvidence } from "./web-accessibility.mjs";
import axe from "axe-core";
import type { BrowserContext, BrowserContextOptions, Locator, Page } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { citationPdf, citationImage } from "../../../src/core/verification/document-fixtures.mjs";
import { dirname, join } from "node:path";
import { required } from "../../../src/core/runtime/values.mjs";
import assert from "node:assert/strict";
interface BrowserScenarioContext {
  distribution: string;
  page: Page;
  browserVersion: string;
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  root: string;
  provider: string;
  commit: string;
  adr: string;
  staged: string;
  directory: string;
  base: string;
  git: (where: string, ...args: string[]) => string;
  workbench: (...args: string[]) => string;
}
export function webBrowserScenarios(context: BrowserScenarioContext): { name: string; run: () => Promise<void> }[] {
  const {
    page,
    browserVersion,
    newContext,
    root,
    provider,
    commit,
    adr,
    staged,
    directory,
    base,
    git,
    workbench,
    distribution,
  } = context;
  const documentNavigation = async () => {
    const content = await page.locator(".record-pane-content > .panel").first().boundingBox();
    assert(content, "The document pane is visible");
    const controls = await page.locator(".record-step").all();
    assert.equal(controls.length, 2);
    for (const [index, control] of controls.entries()) {
      const bounds = await control.boundingBox();
      assert(bounds, "The navigation control is visible");
      assert(Math.abs(bounds.y - content.y) <= 1, "Navigation starts at the document panel's top edge");
      assert(
        Math.abs(bounds.y + bounds.height - content.y - content.height) <= 1,
        "Navigation ends at the document panel's bottom edge",
      );
      assert(
        index === 0 ? bounds.x + bounds.width <= content.x + 1 : bounds.x >= content.x + content.width - 1,
        "Navigation stays beside the document",
      );
    }
    return content;
  };
  return [
    {
      name: BrowserScenario.Diagrams,
      run: async () => {
        const requests: string[] = [];
        const record = join(root, "workbench/decisions/ADR-0Z.md");
        const graph =
          "flowchart LR\n  Profile[Artifact profile] --> Toolchain[Toolchain artifact]\n  Toolchain --> CI[CI with separately acquired project dependencies]\n  Toolchain --> Development[Offline development artifact]\n  Toolchain --> Release[Application release artifact]\n  Development --> Verify[Verify actual outputs and intended use]\n  Release --> Verify\n  Verify --> Deliver[Export, transfer, import, or publish]\n";
        const unsafe =
          "flowchart LR\n  A[\"<img src='https://example.invalid/leak' onerror='alert(1)'>\"] --> B[Safe]\n";
        const contents =
          "---\nsummary: Workflow diagrams.\n---\n\n# ADR-Z: Workflow diagrams\n\n## Artifact workflow\n\n```mermaid\n" +
          graph +
          "```\n\n## Invalid diagram\n\n```mermaid\nflowchart LR\n  A[Unclosed\n```\n\n## Untrusted labels\n\n```mermaid\n" +
          unsafe +
          "```\n";
        await page.route("**/*", async (route) => {
          const url = route.request().url();
          requests.push(url);
          assert(
            url.startsWith("blob:") || new URL(url).origin === new URL(base).origin,
            "Diagrams work without external requests",
          );
          await route.continue();
        });
        try {
          await page.goto(base + "/records/demo:ADR-0");
          assert(
            !requests.some((url) => url.includes("/assets/diagrams.html")),
            "Ordinary pages do not load the renderer",
          );
          writeFileSync(record, contents);
          await page.goto(base + "/records/demo:ADR-Z");
          await page.locator(".diagram-viewport img").nth(1).waitFor();
          const diagrams = page.locator("[data-diagram-comparison]");
          await diagrams.nth(1).locator("output").filter({ hasText: "source is shown" }).waitFor();
          assert.equal(await page.locator(".diagram-renderer").count(), 1, "One renderer serves all diagrams");
          assert.equal(await page.locator(".diagram-renderer").getAttribute("sandbox"), "allow-scripts");
          assert.equal(await page.locator(".diagram-viewport img").count(), 2);
          assert(
            (await page.locator(".diagram-viewport img").first().getAttribute("alt"))?.includes("Artifact profile"),
          );
          assert(
            await page
              .locator(".diagram-viewport img")
              .first()
              .evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 1),
          );
          assert.equal(await diagrams.nth(1).locator("output").textContent(), "Diagram unavailable; source is shown.");
          assert.equal(
            await page
              .locator(".diagram-renderer")
              .evaluate((frame) => frame instanceof HTMLIFrameElement && frame.contentDocument === null),
            true,
            "The renderer cannot access the parent document",
          );
          await diagrams.first().getByRole("button", { name: "Source", exact: true }).click();
          assert.equal(await diagrams.first().locator("[data-diagram-source] pre").textContent(), graph);
          assert(await diagrams.first().locator("[data-diagram-graphics]").isHidden());
          await diagrams.first().getByRole("button", { name: "Diagram", exact: true }).click();
          assert(await diagrams.first().locator("[data-diagram-source]").isHidden());
          await diagrams.nth(1).getByRole("button", { name: "Retry diagram" }).click();
          await diagrams.nth(1).locator("output").filter({ hasText: "source is shown" }).waitFor();
          await page.screenshot({ path: join(directory, "diagrams.png"), fullPage: true });
          await page.evaluate(axe.source);
          const accessibility = await page.evaluate<import("axe-core").AxeResults>("axe.run(document)");
          writeFileSync(join(directory, "diagrams-accessibility.json"), JSON.stringify(accessibility, null, 2));
          assert.deepEqual(
            accessibility.violations,
            [],
            "Diagram accessibility violations; see diagrams-accessibility.json",
          );
          await page.setViewportSize({ width: 375, height: 800 });
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            "Wide diagrams scroll within the document",
          );
          const plain = await newContext({ javaScriptEnabled: false });
          try {
            const fallback = await plain.newPage();
            await fallback.goto(base + "/records/demo:ADR-Z");
            assert.equal(await fallback.locator("[data-diagram-source] code").first().textContent(), graph);
            assert.equal(await fallback.getByRole("button", { name: "Diagram", exact: true }).count(), 0);
            assert.equal(await fallback.locator(".diagram-renderer").count(), 0);
          } finally {
            await plain.close();
          }
          git(root, "add", "workbench/decisions/ADR-0Z.md");
          git(root, "commit", "-qm", "Diagram fixture");
          writeFileSync(record, contents.replace("Toolchain artifact", "Prepared toolchain"));
          for (const layout of ["unified", "split"]) {
            await page.goto(base + "/records/demo:ADR-Z/review?layout=" + layout);
            const comparison = page.locator(".document-diff"),
              removed = comparison.locator(".diagram-removed"),
              added = comparison.locator(".diagram-added"),
              paired = comparison
                .locator("[data-diagram-comparison]")
                .filter({ has: page.locator(".diagram-removed,.diagram-added") });
            await removed.locator("img").waitFor();
            await added.locator("img").waitFor();
            assert.equal(await removed.count(), 1);
            assert.equal(await added.count(), 1);
            assert.equal(await paired.getByRole("group", { name: "Diagram view" }).count(), 1);
            assert((await removed.locator("img").getAttribute("alt"))?.includes("Toolchain artifact"));
            assert((await added.locator("img").getAttribute("alt"))?.includes("Prepared toolchain"));
            await paired.getByRole("button", { name: "Source", exact: true }).click();
            assert(await removed.isHidden());
            assert(await added.isHidden());
            assert.equal(await comparison.locator("del").textContent(), "Toolchain artifact");
            assert.equal(await comparison.locator("ins").textContent(), "Prepared toolchain");
            await paired.getByRole("button", { name: "Diagram", exact: true }).click();
            assert(await removed.isVisible());
            assert(await added.isVisible());
            assert(
              await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
              "Diagram comparisons remain within the page on narrow screens",
            );
            await page.evaluate(axe.source);
            const checked = await page.evaluate<import("axe-core").AxeResults>("axe.run(document)");
            writeFileSync(join(directory, `diagrams-${layout}-accessibility.json`), JSON.stringify(checked, null, 2));
            assert.deepEqual(checked.violations, [], `Diagram ${layout} accessibility violations`);
            await page.screenshot({ path: join(directory, `diagrams-${layout}.png`), fullPage: true });
          }
        } finally {
          await page.unroute("**/*");
        }
      },
    },
    {
      name: BrowserScenario.Performance,
      run: async () => {
        // Playwright disables Chromium's cache while intercepting authentication challenges.
        // The browser has signed in and can now use its native credentials and cache.
        await page.context().setHTTPCredentials(null);
        const samples: { name: string; durationMs: number; ttfbMs: number; timing: string | undefined }[] = [];
        const navigate = async (name: string, path: string) => {
          const response = await page.goto(base + path, { waitUntil: "load" });
          assert.equal(response?.status(), 200);
          const navigation = await page.evaluate(() => {
            const timing = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
            return { durationMs: timing.loadEventEnd, ttfbMs: timing.responseStart };
          });
          samples.push({ name, ...navigation, timing: response.headers()["server-timing"] });
        };
        await navigate("first-project-record", "/records/demo:ADR-0");
        for (const [name, path] of [
          ["record", "/records/demo:ADR-0"],
          ["unified-review", "/records/demo:ADR-0/review?layout=unified"],
          ["split-review", "/records/demo:ADR-0/review?layout=split"],
        ] as const) {
          for (let run = 0; run < 5; run++) await navigate(name, path);
        }
        const resources = await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .filter((entry) => /\/assets\/(style\.css|client\.js)\?v=/.test(entry.name))
            .map((entry) => ({ name: entry.name, bytes: (entry as PerformanceResourceTiming).transferSize })),
        );
        assert.equal(resources.length, 2);
        assert(
          resources.every((entry) => entry.bytes === 0),
          "Unchanged assets are served from the browser cache",
        );
        const concurrent = await page.evaluate(
          async (paths) =>
            Promise.all(
              paths.map(async (path) => {
                const started = performance.now();
                const response = await fetch(path);
                const text = await response.text();
                if (!response.ok || !text.includes("Working-only phrase")) throw new Error("Concurrent review failed");
                return { durationMs: performance.now() - started, timing: response.headers.get("server-timing") };
              }),
            ),
          Array.from(
            { length: 4 },
            (_, index) =>
              base +
              (index % 2 ? "/records/demo:ADR-0/review?layout=split" : "/records/demo:ADR-0/review?layout=unified"),
          ),
        );
        const summarize = (values: number[]) => {
          const sorted = [...values].sort((a, b) => a - b),
            middle = Math.floor(sorted.length / 2);
          return {
            count: sorted.length,
            medianMs:
              sorted.length % 2
                ? required(sorted[middle], "Missing middle timing")
                : (required(sorted[middle - 1], "Missing adjacent timing") +
                    required(sorted[middle], "Missing middle timing")) /
                  2,
            minMs: required(sorted[0], "Missing minimum timing"),
            maxMs: required(sorted.at(-1), "Missing maximum timing"),
          };
        };
        writeFileSync(adr, readFileSync(adr, "utf8") + "\nFresh content invalidates the document cache.\n");
        await navigate("changed-review", "/records/demo:ADR-0/review?layout=unified");
        await page.getByText("Fresh content invalidates the document cache.", { exact: true }).waitFor();
        writeFileSync(
          join(directory, "performance.json"),
          JSON.stringify(
            {
              version: 2,
              kind: "workbench-web-performance",
              environment: {
                platform: process.platform,
                arch: process.arch,
                node: process.version,
                browser: browserVersion,
                userAgent: await page.evaluate(() => navigator.userAgent),
              },
              workload: {
                name: "document-navigation",
                version: 1,
                records: readdirSync(join(root, "workbench"), { recursive: true }).filter((name) =>
                  /(?:ADR|TSK|EXP|ENV|CIT|REL)-[^/]+\.(md|json)$/.test(String(name)),
                ).length,
                warmSamples: 5,
                concurrentReaders: concurrent.length,
              },
              summary: Object.fromEntries(
                [...new Set(samples.map((sample) => sample.name))].map((name) => [
                  name,
                  summarize(samples.filter((sample) => sample.name === name).map((sample) => sample.durationMs)),
                ]),
              ),
              samples,
              concurrent,
              concurrentSummary: summarize(concurrent.map((sample) => sample.durationMs)),
              resources,
              note: "Advisory timings include browser and instrumentation cost; behavioral checks verify cache reuse and content freshness.",
            },
            null,
            2,
          ),
        );
      },
    },
    {
      name: BrowserScenario.Accessibility,
      run: async () => accessibilityEvidence(page, base, directory, distribution),
    },
    {
      name: BrowserScenario.Projects,
      run: async () => {
        const origin = new URL(base).origin;
        await page.goto(origin + "/projects");
        await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
        assert.deepEqual(await page.locator("table th").allTextContents(), ["Project", "Reviews", "Cache", "Actions"]);
        const cache = page.locator("button[data-cache-preview]").first();
        await cache.hover();
        const breakdown = page.locator(".cache-breakdown:popover-open");
        await breakdown.waitFor();
        assert.deepEqual(await breakdown.locator("dt").allTextContents(), [
          "Owned",
          "Eligible",
          "Retained",
          "Tools",
          "Shared",
          "Images",
        ]);
        await breakdown.getByRole("link", { name: "Cache details" }).hover();
        await breakdown.waitFor();
        await page.screenshot({ path: join(directory, "cache-breakdown.png"), fullPage: true });
        await page.keyboard.press("Escape");
        await breakdown.waitFor({ state: "hidden" });
        const viewport = page.viewportSize();
        await page.setViewportSize({ width: 390, height: 240 });
        await cache.click();
        await breakdown.waitFor();
        await page.waitForFunction(() => {
          const box = document.querySelector(".cache-breakdown:popover-open")?.getBoundingClientRect();
          return !!box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
        });
        const bounds = await breakdown.boundingBox();
        assert(
          bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 240,
          "Cache breakdown stays inside a narrow, short viewport",
        );
        await breakdown.getByRole("link", { name: "Cache details" }).focus();
        await page.keyboard.press("Escape");
        await breakdown.waitFor({ state: "hidden" });
        if (viewport) await page.setViewportSize(viewport);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await breakdown.waitFor();
        await page.keyboard.press("Escape");
        await breakdown.waitFor({ state: "hidden" });
        assert.equal(
          await page
            .getByRole("navigation", { name: "Workbench", exact: true })
            .getByRole("link", { name: "Projects", exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        await page.screenshot({ path: join(directory, "projects-desktop.png"), fullPage: true });
        await page.goto(origin + "/caches");
        await page.getByRole("heading", { name: "Shared tool installations", exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("navigation", { name: "Workbench", exact: true })
            .getByRole("link", { name: "Caches", exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        await page.goto(base + "/records/demo:TSK-0");
        const reference = page.getByRole("link", { name: "the governing decision", exact: true });
        await reference.focus();
        await page.getByRole("tooltip").waitFor();
        assert.match(
          await page.getByRole("tooltip").innerText(),
          /demo:ADR-0[\s\S]*Authoritative files[\s\S]*Preserve authoritative files/,
        );
        await page.keyboard.press("Escape");
        await page.getByRole("tooltip").waitFor({ state: "hidden" });
        await reference.blur();
        await reference.hover();
        await page.getByRole("tooltip").waitFor();
        await page.screenshot({ path: join(directory, "reference-preview.png"), fullPage: true });
        await page.keyboard.press("Escape");
        const implicit = page.locator('.document a[data-record-reference="demo:ADR-0"]').filter({ hasText: /^ADR-0$/ });
        await implicit.hover();
        await page.getByRole("tooltip").waitFor();
        assert.match(await page.getByRole("tooltip").innerText(), /demo:ADR-0[\s\S]*Authoritative files/);
        await page.keyboard.press("Escape");
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await documentNavigation();
          await page.screenshot({ path: join(directory, `record-navigation-${String(width)}.png`), fullPage: true });
        }
        const task = join(root, "workbench/tasks/TSK-00.md");
        const initial = readFileSync(task, "utf8");
        try {
          writeFileSync(
            task,
            initial +
              "\n" +
              Array.from({ length: 60 }, (_, index) => `Long document paragraph ${String(index)}.\n\n`).join(""),
          );
          await page.reload();
          await page.getByText("Long document paragraph 59.", { exact: true }).waitFor();
          const content = await documentNavigation();
          assert(content.height > 1500, "The long document extends beyond the viewport");
          await page.evaluate(
            (y) => {
              window.scrollTo(0, y);
            },
            content.y + content.height / 2,
          );
          for (const icon of await page.locator(".record-step svg").all()) {
            const bounds = await icon.boundingBox();
            assert(
              bounds && bounds.y >= 0 && bounds.y + bounds.height <= 1000,
              "Navigation arrows remain visible while scrolling",
            );
          }
          await page.screenshot({ path: join(directory, "record-navigation-long.png"), fullPage: false });
        } finally {
          writeFileSync(task, initial);
        }
      },
    },
    {
      name: BrowserScenario.Search,
      run: async () => {
        await page.goto(base);
        await page.getByRole("heading", { name: "Charters", exact: true }).waitFor();
        assert.equal(await page.locator(".metric,.metrics").count(), 0);
        assert.equal(await page.locator('.sidebar a[href="/projects"]').count(), 0);
        assert.equal(await page.locator("[data-preview-error]").count(), 0);
        const summary = page.locator('[data-record-id="demo:CHARTER"] p').first();
        assert.equal(await summary.locator("xpath=ancestor::a").count(), 0);
        await page.getByRole("link", { name: /Switch project/ }).click();
        await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
        await page.goto(base);
        await page.screenshot({ path: join(directory, "charters-desktop.png"), fullPage: true });
        assert.equal(await page.getByLabel("Record type", { exact: true }).inputValue(), "");
        await page.getByLabel("Search project records").fill("distinctive search phrase");
        await page.getByLabel("Record type", { exact: true }).selectOption("TSK");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: "TSK-0: Inspect the interface", exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get("type"), "TSK");
        assert.equal(await page.locator('main input[name="q"],main select[name="type"]').count(), 0);
        assert.equal(await page.getByLabel("Search project records").inputValue(), "distinctive search phrase");
        await page.getByLabel("Record type", { exact: true }).selectOption("ADR");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByText("No matching records.", { exact: true }).waitFor();
        await page.getByLabel("Record type", { exact: true }).selectOption("");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: "TSK-0: Inspect the interface", exact: true }).waitFor();
        await page.goto(base + "/records/demo:ADR-0");
        await page.getByText("Working-only phrase.", { exact: true }).waitFor();
        await page.getByRole("link", { name: "Changes", exact: true }).click();
        await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
        assert(await page.locator(".document-diff.split").count());
        for (const layout of ["unified", "split"] as const) {
          await page.getByRole("link", { name: layout === "split" ? "Side-by-side" : "Unified", exact: true }).click();
          const spacing = await page
            .locator(".document-diff .record-metadata")
            .first()
            .evaluate((metadata) => {
              const field = metadata.lastElementChild;
              if (!field) throw new Error("Missing summary field");
              return {
                gap: metadata.getBoundingClientRect().bottom - field.getBoundingClientRect().bottom,
                line: Number.parseFloat(globalThis.getComputedStyle(field).lineHeight),
              };
            });
          assert(spacing.gap <= spacing.line, "The summary divider should sit within one line of its content");
          await page.screenshot({ path: join(directory, `adr-diff-${layout}.png`), fullPage: true });
        }
        await page.screenshot({ path: join(directory, "adr-diff-desktop.png"), fullPage: true });
      },
    },
    {
      name: BrowserScenario.Paragraphs,
      run: async () => {
        const original = readFileSync(adr, "utf8"),
          baseline = git(root, "show", "HEAD:workbench/decisions/ADR-00.md") + "\n";
        const rewrite = JSON.parse(
          readFileSync(join(distribution, "app/test/fixtures/paragraph-diff.json"), "utf8"),
        ) as { before: string; after: string };
        try {
          writeFileSync(
            adr,
            baseline.replace("Keep project documents in plain files.", "Keep project documents\nin plain files."),
          );
          await page.goto(base + "/records/demo:ADR-0?view=changes");
          await page.getByText(/Only source formatting or comments changed/).waitFor({ timeout: 10000 });
          assert.equal(await page.locator(".document-diff ins, .document-diff del").count(), 0);
          writeFileSync(
            adr,
            baseline.replace("Keep project documents in plain files.", "Store project documents\nin plain files."),
          );
          await page.locator(".document-diff p ins").filter({ hasText: "Store" }).waitFor({ timeout: 10000 });
          assert.equal(await page.locator(".document-diff p del").count(), 1);
          assert.equal(await page.locator(".document-diff p ins").count(), 1);
          assert.equal(
            await page
              .locator(".document-diff")
              .getByText(/diff --git|index [a-f0-9]+/)
              .count(),
            0,
          );
          await page.screenshot({ path: join(directory, "adr-paragraph-diff-desktop.png"), fullPage: true });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.evaluate(() => globalThis.document.fonts.ready);
          await page.screenshot({ path: join(directory, "adr-paragraph-diff-mobile.png"), fullPage: true });
          assert(
            await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
            `Inline paragraph diff overflows on a narrow window: ${JSON.stringify(
              await page.evaluate(() => ({
                width: globalThis.innerWidth,
                scrollWidth: globalThis.document.documentElement.scrollWidth,
                elements: [...globalThis.document.querySelectorAll("body *")]
                  .filter((element) => element.getBoundingClientRect().right > globalThis.innerWidth)
                  .map((element) => ({
                    tag: element.tagName,
                    class: element.className,
                    right: element.getBoundingClientRect().right,
                  }))
                  .slice(0, 20),
              })),
            )}`,
          );
          await page.setViewportSize({ width: 1440, height: 1000 });
          writeFileSync(adr, baseline.replace("Keep project documents in plain files.", rewrite.after.trim()));
          await page.goto(base + "/review?path=workbench%2Fdecisions%2FADR-00.md&view=diff");
          await page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin });
          const paragraph = page.locator(".document-diff p").first();
          const rendered = await paragraph.evaluate((element) => {
            const project = (side: "before" | "after") => {
              const copy = element.cloneNode(true) as Element;
              for (const node of copy.querySelectorAll(`${side === "before" ? "ins" : "del"},.diff-separator`))
                node.remove();
              return copy.textContent;
            };
            return { text: element.textContent, before: project("before"), after: project("after") };
          });
          assert.equal(rendered.before, "Keep project documents in plain files.");
          assert.equal(rendered.after, rewrite.after.trim().replace(/\n/g, " "));
          assert(!/End added|End removed|Previous|Revised/.test(rendered.text));
          assert.deepEqual(
            await paragraph.locator("del,ins").evaluateAll((elements) => elements.map((element) => element.tagName)),
            ["DEL", "INS"],
          );
          for (const forcedColors of ["active", "none"] as const) {
            await page.emulateMedia({ forcedColors });
            const annotations = await paragraph.locator("del,ins").evaluateAll((elements) =>
              elements.map((element) => ({
                decoration: getComputedStyle(element).textDecorationLine,
                prefix: getComputedStyle(element, "::before").content,
              })),
            );
            assert(annotations.every(({ prefix }) => prefix === "none" || prefix === "normal"));
            assert.deepEqual(
              annotations.map(({ decoration }) => decoration),
              forcedColors === "active" ? ["line-through", "underline"] : ["none", "none"],
            );
          }
          assert.equal(await page.locator(".diff-legend,.diff-change-label").count(), 0);
          await paragraph.evaluate((element) => {
            const range = globalThis.document.createRange();
            range.selectNodeContents(element);
            const selection = globalThis.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          });
          await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
          assert.equal(await page.evaluate(() => globalThis.navigator.clipboard.readText()), rendered.text);
          await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
          const crumbs = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
          assert.deepEqual(await crumbs.getByRole("link").allTextContents(), ["demo", "Reviews"]);
          assert.equal(
            await page.locator(".panel-controls").getByRole("navigation", { name: "Difference layout" }).count(),
            1,
          );
          assert.equal(await page.getByText("Layout", { exact: true }).count(), 0);
          assert.equal(await page.getByRole("link", { name: "Download committed file", exact: true }).count(), 0);
          await page.screenshot({ path: join(directory, "adr-grouped-paragraph-diff.png"), fullPage: true });
          await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
          const comparison = new URL(page.url());
          assert.equal(comparison.searchParams.has("review_source"), false);
          assert.equal(comparison.searchParams.has("baseline"), false);
          assert.match(await page.locator("h1").innerText(), /ADR-0/);
          assert.deepEqual(
            await page
              .getByRole("navigation", { name: "Difference layout", exact: true })
              .getByRole("link")
              .allTextContents(),
            ["Unified", "Side-by-side"],
          );
          assert.equal(await page.getByRole("navigation", { name: "Reviewed file views", exact: true }).count(), 0);
          assert.equal(await page.locator("[data-review-file]").getByText("Needs review", { exact: true }).count(), 0);
          assert.equal(
            await page.locator(".column-labels").evaluate((element) => element.getBoundingClientRect().height),
            0,
          );
          assert.equal(await page.getByRole("columnheader", { name: "Previous", exact: true }).count(), 1);
          assert.equal(await page.getByRole("columnheader", { name: "Current", exact: true }).count(), 1);
          for (const cell of await page.locator(".document-diff-table > tbody > tr > td").all())
            assert.equal(
              await cell.evaluate((element) => globalThis.getComputedStyle(element).borderBottomWidth),
              "0px",
            );
          for (const section of await page.locator(".document-diff-table .record-metadata").all())
            assert.equal(
              await section.evaluate((element) => globalThis.getComputedStyle(element).borderBottomWidth),
              "1px",
            );
          assert.equal(await page.getByText("Inspect source", { exact: true }).count(), 0);
          assert.equal(await page.locator(".source-comparison,.diff-row").count(), 0);
          const contextParagraphs = Array.from(
            { length: 40 },
            (_, index) => `Context paragraph ${String(index)} stays readable.`,
          );
          const unchanged = "Keep [platform guidance](https://example.invalid/storage) unchanged.";
          const complete =
            baseline +
            "\n" +
            contextParagraphs.join("\n\n") +
            `\n\nPreserve old state. ${unchanged} Use the old guide.\n`;
          writeFileSync(adr, complete);
          git(root, "add", "workbench/decisions/ADR-00.md");
          git(root, "commit", "-qm", "Long document comparison fixture");
          writeFileSync(adr, complete.replace("paragraph 20 stays", "paragraph 20 remains").replaceAll("old", "new"));
          for (const layout of ["unified", "split"]) {
            await page.goto(base + "/records/demo:ADR-0/review?layout=" + layout);
            const comparison = page.locator(".document-diff");
            const sides = layout === "split" ? ["before", "after"] : [""];
            for (const side of sides) {
              const region = side ? comparison.locator(`[data-diff-side="${side}"]`) : comparison;
              await region.getByText(contextParagraphs[0] ?? "", { exact: true }).waitFor();
              await region.getByText(contextParagraphs[39] ?? "", { exact: true }).waitFor();
              assert.equal(
                await region
                  .locator("p")
                  .filter({ hasText: /^Context paragraph \d+ / })
                  .count(),
                contextParagraphs.length,
              );
            }
            assert.deepEqual(await comparison.locator("del").allTextContents(), ["stays", "old", "old"]);
            assert.deepEqual(await comparison.locator("ins").allTextContents(), ["remains", "new", "new"]);
            const guidance = comparison.locator('a[href="https://example.invalid/storage"]');
            assert.equal(await guidance.count(), layout === "split" ? 2 : 1);
            assert(await guidance.evaluateAll((links) => links.every((link) => !link.closest("ins,del"))));
          }
          await page.screenshot({ path: join(directory, "adr-full-context-side-by-side.png"), fullPage: true });
        } finally {
          writeFileSync(adr, original);
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
      },
    },
    {
      name: BrowserScenario.Reviews,
      run: async () => {
        const original = readFileSync(adr, "utf8");
        const unformatted =
          original + "\n" + "Review preparation preserves the document contents. ".repeat(12).trim() + "\n";
        const receiptPath = join(root, ".git/workbench/review.json");
        const receiptBefore = existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null;
        writeFileSync(adr, unformatted);
        const coldContext = await newContext({ javaScriptEnabled: false });
        try {
          const cold = await coldContext.newPage();
          const response = await cold.goto(base + "/records/demo:ADR-0/review?layout=unified");
          assert.equal(response?.status(), 200);
          await cold.getByRole("button", { name: "Review file", exact: true }).waitFor();
          const trail = cold.getByRole("navigation", { name: "Breadcrumb" });
          assert.equal(
            new URL((await trail.getByRole("link", { name: "Reviews", exact: true }).getAttribute("href")) ?? "", base)
              .pathname,
            new URL(base + "/reviews").pathname,
          );
          assert.equal(readFileSync(adr, "utf8"), unformatted, "GET must not format the file");
          await cold.getByRole("button", { name: "Review file", exact: true }).click();
          await cold.locator("form[data-review]").waitFor();
          assert.notEqual(readFileSync(adr, "utf8"), unformatted);
          assert.deepEqual(readFileSync(adr, "utf8").split(/\s+/), unformatted.split(/\s+/));
          await cold.getByRole("link", { name: "Side-by-side", exact: true }).click();
          assert.equal(new URL(cold.url()).searchParams.get("layout"), "split");
          await cold.locator(".document-diff").first().waitFor();
        } finally {
          await coldContext.close();
        }
        writeFileSync(adr, unformatted);
        await page.goto(base + "/records/demo:ADR-0/review?layout=split");
        await page.locator("form[data-review]").waitFor();
        assert.equal(new URL(page.url()).searchParams.get("layout"), "split");
        assert.notEqual(readFileSync(adr, "utf8"), unformatted);
        assert.equal(existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null, receiptBefore);
        writeFileSync(adr, original);
        await page.goto(base + "/records/demo:ADR-0?view=edit");
        assert.deepEqual(await page.locator("form[data-editor] .actions").locator("a, button").allTextContents(), [
          "Cancel",
          "Save draft",
        ]);
        await page.getByLabel("ADR source").fill("Unsaved browser draft <retained>");
        writeFileSync(adr, staged + "\nExternal concurrent edit.\n");
        await page.locator("#live-status:not([hidden])").waitFor();
        assert.equal(await page.getByLabel("ADR source").inputValue(), "Unsaved browser draft <retained>");
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await page.getByText(/file changed since this editor opened/).waitFor();
        assert.equal(await page.getByLabel("ADR source").inputValue(), "Unsaved browser draft <retained>");
        await page.screenshot({ path: join(directory, "stale-editor-desktop.png"), fullPage: true });
        await page.goto(base + "/records/demo:ADR-0?view=edit");
        const edited = staged + "\nSaved browser draft. See ADR-0.\n";
        await page.getByLabel("ADR source").fill(edited);
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await page.waitForURL(/saved=1/);
        assert.equal(readFileSync(adr, "utf8"), edited);
        assert.equal(git(root, "show", ":workbench/decisions/ADR-00.md"), staged.trim());
        await page.goto(base + "/review?path=workbench/decisions/ADR-00.md");
        await page
          .getByRole("navigation", { name: "Difference layout" })
          .locator('a[aria-current="page"]')
          .filter({ hasText: "Unified" })
          .waitFor();
        assert.equal(await page.getByRole("navigation", { name: "Reviewed file views" }).count(), 0);
        await page.locator('.document-diff a[data-record-reference="demo:ADR-0"]').first().hover();
        await page.getByRole("tooltip").waitFor();
        assert.match(await page.getByRole("tooltip").innerText(), /demo:ADR-0[\s\S]*Authoritative files/);
        await page.keyboard.press("Escape");
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await documentNavigation();
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: join(directory, "review-default-changes-desktop.png"), fullPage: true });
        await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
        await page.locator(".document-diff.split").waitFor();
        await page.locator('[data-diff-side="after"] a[data-record-reference="demo:ADR-0"]').first().focus();
        await page.getByRole("tooltip").waitFor();
        assert.match(await page.getByRole("tooltip").innerText(), /demo:ADR-0[\s\S]*Authoritative files/);
        await page.keyboard.press("Escape");
        await documentNavigation();
        assert.match(
          (await page.locator('[data-diff-side="before"] .document').allInnerTexts()).join(" "),
          /Keep project documents in plain files/,
        );
        assert.match(
          (await page.locator('[data-diff-side="after"] .document').allInnerTexts()).join(" "),
          /Saved browser draft/,
        );
        assert.equal(await page.locator("form[data-review]").count(), 1);
        const nextReview = await page.getByRole("link", { name: "Next review", exact: true }).getAttribute("href");
        if (!nextReview) throw new Error("Expected the next protected record");
        await page.getByRole("button", { name: "Confirm changes", exact: true }).click();
        await page.waitForURL(new URL(nextReview, base).href);
        assert.equal(new URL(page.url()).searchParams.get("layout"), "split");
        assert.equal(new URL(page.url()).searchParams.has("review_source"), false);
        const receipt = JSON.parse(readFileSync(join(root, ".git/workbench/review.json"), "utf8")) as {
          changes: unknown[];
        };
        assert.equal(receipt.changes.length, 1);
        await page.goto(base + "/records/demo:ADR-0?view=changes");
        assert.equal(await page.getByRole("link", { name: "Compare with committed HEAD", exact: true }).count(), 0);
        await page.getByText("No changes.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: "Changes", exact: true }).count(), 0);
        assert.equal(await page.locator(".document-diff ins,.document-diff del").count(), 0);
        writeFileSync(adr, edited + "\nAfter the last review.\n");
        await page.locator(".document-diff p ins").filter({ hasText: "After the last review." }).waitFor();
        assert.equal(await page.locator(".document-diff p del").count(), 0);
        await page.screenshot({ path: join(directory, "since-last-review-desktop.png"), fullPage: true });
        const shown = edited + "\nAfter the last review.\n";
        await page.goto(base + "/records/demo:ADR-0/review");
        const digest = await page.locator('form[data-review] input[name="digest"]').inputValue();
        const refreshReview = page.getByRole("link", { name: "Refresh displayed version", exact: true });
        assert.equal(await refreshReview.isVisible(), false);
        assert.equal(
          await page.getByRole("button", { name: "Confirm changes", exact: true }).innerText(),
          "Confirm changes",
        );
        writeFileSync(adr, shown + "\nA later edit on disk.\n");
        await page.getByText("File changed on disk. Refresh to view the latest version.", { exact: true }).waitFor();
        await refreshReview.waitFor();
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await refreshReview.scrollIntoViewIfNeeded();
          const refreshBounds = await refreshReview.boundingBox();
          assert(refreshBounds && refreshBounds.x >= 0 && refreshBounds.x + refreshBounds.width <= width);
          assert.equal(await page.getByRole("button", { name: "Confirm changes", exact: true }).isVisible(), true);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(await page.locator('form[data-review] input[name="digest"]').inputValue(), digest);
        assert.equal(await page.getByRole("button", { name: "Confirm changes", exact: true }).isEnabled(), true);
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/actions/approve") &&
              response.status() === 200,
          ),
          page.getByRole("button", { name: "Confirm changes", exact: true }).click(),
        ]);
        await page.locator(".document-diff p ins").filter({ hasText: "A later edit on disk." }).waitFor();
        assert.match(await page.locator("h1").innerText(), /ADR-0/);
        assert.equal(await refreshReview.isVisible(), false);
        writeFileSync(adr, shown + "\nA further edit for reload.\n");
        await refreshReview.waitFor();
        const beforeRefresh = readFileSync(join(root, ".git/workbench/review.json"), "utf8");
        await refreshReview.click();
        await page.locator(".document-diff p ins").filter({ hasText: "A further edit for reload." }).waitFor();
        assert.equal(await refreshReview.isVisible(), false);
        assert.equal(readFileSync(join(root, ".git/workbench/review.json"), "utf8"), beforeRefresh);
        assert.equal(await page.locator('form[data-review] input[type="checkbox"]').count(), 0);
        const action = page.getByRole("button", { name: "Confirm changes", exact: true });
        for (const width of [1920, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          const bounds = await action.boundingBox(),
            documentBounds = await page.locator("[data-review-file] .panel").boundingBox();
          assert(bounds && documentBounds);
          assert(bounds.width < documentBounds.width);
          assert(
            Math.abs(bounds.x + bounds.width / 2 - (documentBounds.x + documentBounds.width / 2)) < 2,
            "The confirmation button is centered under the document panel",
          );
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(base + "/records/demo:TSK-0");
        assert.equal(await page.getByRole("link", { name: "Edit", exact: true }).count(), 0);
        const added = "workbench/decisions/ADR-01.md";
        const contents = "# ADR-1: New record\n\nRead the complete new record before approval.\n";
        writeFileSync(join(root, added), contents);
        await page.goto(base + "/review?path=" + encodeURIComponent(added));
        const views = page.getByRole("navigation", { name: "Reviewed file views" });
        assert.equal(await views.count(), 0);
        await page.getByText("Read the complete new record before approval.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: "Raw", exact: true }).count(), 0);
        assert.equal(await page.locator("[data-review-file] > .file-path .badge").textContent(), "New file");
        assert.equal(await page.locator("[data-file-mode]").count(), 0);
        assert.equal(await page.getByRole("button", { name: "Confirm new file", exact: true }).isEnabled(), true);
        await page.screenshot({ path: join(directory, "new-file-review.png"), fullPage: true });
        const projects = join(root, "workbench/projects.toml");
        const entries = readFileSync(projects, "utf8");
        const charter = "example/workbench/CHARTER.md";
        mkdirSync(join(root, "example/workbench"), { recursive: true });
        writeFileSync(join(root, charter), "# Charter\n\nExample application.\n");
        writeFileSync(projects, entries + '\n[[project]]\nid = "example"\npath = "example"\n');
        const leftInset = async (path: string) => {
          await page.goto(base + "/review?path=" + encodeURIComponent(path));
          const panel = page.locator("[data-review-file] .panel");
          const outer = await panel.boundingBox();
          const prose = await panel.locator(".document p").first().boundingBox();
          assert(outer && prose);
          return prose.x - outer.x;
        };
        try {
          for (const width of [1920, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            const charterInset = await leftInset(charter);
            assert(charterInset < 40, "The charter starts at the panel's standard left padding");
            assert.equal(charterInset, await leftInset(added));
            assert.equal(charterInset, await leftInset("workbench/decisions/ADR-00.md"));
          }
        } finally {
          writeFileSync(projects, entries);
          rmSync(join(root, "example"), { recursive: true, force: true });
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
        const task = "workbench/tasks/TSK-00.md";
        writeFileSync(join(root, task), "---\nstatus: Canceled\n---\n\n# TSK-0: Inspect the interface\n");
        git(root, "add", "workbench/decisions/ADR-00.md", added, task);
        git(root, "commit", "-qm", "Retained policy updates\n\nWorkbench-Provisional: true");
        const revision = git(root, "rev-parse", "HEAD");
        await page.goto(base + "/reviews");
        const unit = page.locator(`[data-review-commit="${revision}"]`);
        await unit.waitFor();
        assert.equal(await unit.locator(".panel-heading a").count(), 0);
        await unit
          .locator(".commit-review-context")
          .getByText(/demo:TSK-0/)
          .waitFor();
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          const metadata = await unit.locator(".commit-review-context > p").last().boundingBox(),
            title = await unit.getByRole("heading", { name: "Retained policy updates", exact: true }).boundingBox(),
            path = await unit.locator(".record-row > .file-path").first().boundingBox();
          assert(metadata && title && path);
          assert(Math.abs(metadata.x - path.x) <= 1, "Review counts align with record text");
          assert(Math.abs(title.x - path.x) <= 1, "Commit headings align with record text");
          assert(metadata.x + metadata.width <= width, "Commit context fits the viewport");
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: join(directory, "commit-review-queue.png"), fullPage: true });
        await unit.locator("[data-review-record] a[data-card-link]").first().click();
        await page.locator("form[data-review]").waitFor();
        assert.match(
          await page.locator(".commit-review-context").innerText(),
          /demo:TSK-0[\s\S]*Retained policy updates/,
        );
        assert.equal(await page.getByText(/\d+ changed files/, { exact: true }).count(), 0);
        await documentNavigation();
      },
    },
    {
      name: BrowserScenario.Collections,
      run: async () => {
        await page.goto(base + "/collections");
        await page.getByLabel("Git repository", { exact: true }).fill(provider);
        await page.getByLabel("Full immutable Git commit").fill(commit);
        await page.getByLabel("Audience", { exact: true }).selectOption("public");
        await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
        await page.waitForURL(/collection-proposal/, { timeout: 30000 });
        assert(!existsSync(join(root, "workbench/collections/company")));
        await page.screenshot({ path: join(directory, "collection-preview-desktop.png"), fullPage: true });
        await page.getByRole("button", { name: "Adopt for review", exact: true }).click();
        await page.waitForURL(base + "/reviews?collection_applied=company", { timeout: 30000 });
        const applicationResult = page.getByLabel("Collection application result");
        await applicationResult.waitFor();
        assert.match(await applicationResult.innerText(), /Project context synchronized and validation passed\./);
        await page.locator('main a[data-card-link][href*="/records/company:ADR-0/review"]').waitFor();
        assert(existsSync(join(root, "workbench/collections/company/decisions/ADR-00.md")));
        await page.goto(base + "/records?type=ADR");
        assert.equal(await page.locator('#record-list [data-record-id="company:ADR-0"]').count(), 0);
        await page
          .getByRole("navigation", { name: "Record sources" })
          .getByRole("link", { name: "company", exact: true })
          .click();
        await page.waitForURL(/collection=company/);
        assert.equal(await page.locator('#record-list [data-record-id="demo:ADR-0"]').count(), 0);
        await page.locator('#record-list [data-record-id="company:ADR-0"]').waitFor();
        const adapted = join(root, "workbench/collections/company/decisions/ADR-00.md");
        writeFileSync(adapted, readFileSync(adapted, "utf8") + "\nA committed project adaptation.\n");
        git(root, "add", "workbench/collections/company");
        git(root, "commit", "-qm", "Adapted fixture");
        await page.goto(base + "/records/company:ADR-0?view=changes");
        await page
          .getByText("Pinned upstream → project copy (working file). This includes committed adaptations.", {
            exact: true,
          })
          .waitFor();
        await page
          .locator(".badge")
          .filter({ hasText: /^Adapted$/ })
          .waitFor();
        assert.equal(
          await page
            .locator(".badge")
            .filter({ hasText: /^Adapted$/ })
            .count(),
          1,
        );
        await page.getByRole("link", { name: "Compare with reviewed record", exact: true }).click();
        await page.getByText("No changes.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: "Changes", exact: true }).count(), 1);
        await page.getByRole("link", { name: "Compare with pinned upstream", exact: true }).waitFor();
        await page
          .getByRole("navigation", { name: "Record sources" })
          .getByRole("link", { name: "demo", exact: true })
          .click();
        await page.waitForURL(
          (url) => !url.searchParams.has("collection") || url.searchParams.get("collection") === "",
        );
      },
    },
    {
      name: BrowserScenario.Compatibility,
      run: async () => {
        await page.goto(base + "/reviews");
        await page
          .locator("[data-compatibility-item]")
          .getByRole("link", { name: "Resolve policy incompatibilities" })
          .click();
        await page.waitForURL((url) => url.searchParams.get("compatibility") === "1");
        await page.getByRole("heading", { name: "Proposed resolution", exact: true }).waitFor();
        assert.deepEqual(await page.locator("main .actions button").allTextContents(), [
          "Dismiss finding",
          "Approve resolution",
        ]);
        await page.getByText("Permit the host scheduler to wrap project build commands.", { exact: true }).waitFor();
        assert.equal(await page.locator('a[href*="/records/hostrules:ADR-0"]').count(), 1);
        await page.screenshot({ path: join(directory, "compatibility-proposal.png"), fullPage: true });
        const before = readFileSync(adr, "utf8");
        await page.getByRole("button", { name: "Approve resolution", exact: true }).click();
        await page.waitForURL((url) => !url.searchParams.has("compatibility"));
        assert.equal(readFileSync(adr, "utf8"), before);
        await page.goto(base + "/reviews");
        assert.equal(await page.locator("[data-compatibility-item]").count(), 0);
        await page.goto(base + "/collections");
        await page
          .getByText("Approved resolutions await policy changes and a fresh agent assessment.", { exact: true })
          .waitFor();
        await page.getByRole("link", { name: "Inspect compatibility", exact: true }).click();
        await page.getByText("Resolution approved", { exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Approve resolution", exact: true }).count(), 0);
      },
    },
    {
      name: BrowserScenario.Metadata,
      run: async () => {
        await page.goto(base + "/records/demo:CIT-0");
        await page.getByRole("heading", { name: "Authors", exact: true }).waitFor();
        await page.getByText("Ada Lovelace", { exact: true }).waitFor();
        await page.getByText("2026-11-08", { exact: true }).waitFor();
        assert.equal(await page.getByText("Date parts", { exact: true }).count(), 0);
        await page.screenshot({ path: join(directory, "citation-desktop.png"), fullPage: true });
        const citationPath = join(root, "workbench/citations/CIT-00.json");
        const bibliography = JSON.parse(readFileSync(citationPath, "utf8")) as { issued: unknown }[];
        const citation = bibliography[0];
        assert(citation);
        citation.issued = { literal: "n.d." };
        writeFileSync(citationPath, JSON.stringify(bibliography));
        await page.goto(base + "/records/demo:CIT-0");
        await page.waitForFunction(
          () => ![...document.querySelectorAll("h2")].some((heading) => heading.textContent === "Year"),
        );
        assert.equal(await page.getByText("n.d.", { exact: true }).count(), 0);
        await page.screenshot({ path: join(directory, "citation-undated.png"), fullPage: true });
        await page.goto(base + "/records/demo:ADR-0");
        await page.getByRole("heading", { name: "Summary", exact: true }).waitFor();
        await page.getByRole("heading", { name: "Agent instructions", exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "decision-metadata-desktop.png"), fullPage: true });
        const supporting = join(root, "workbench/tasks/TSK-00");
        mkdirSync(join(supporting, "notes"), { recursive: true });
        writeFileSync(
          join(supporting, "review.md"),
          "# Source review\n\n## Findings\n\n**Verified** behavior follows ADR-0.\n",
        );
        writeFileSync(join(supporting, "notes/ordering.json"), '{"order": [1, 2]}\n');
        await page.goto(base + "/records/demo:TSK-0/files?path=workbench/tasks/TSK-00/review.md");
        await page.getByRole("heading", { name: "Source review", exact: true }).waitFor();
        await page.locator(".document strong").getByText("Verified", { exact: true }).waitFor();
        await page
          .getByRole("navigation", { name: "Breadcrumb", exact: true })
          .getByRole("link", { name: "Supporting files", exact: true })
          .click();
        await page.getByRole("link", { name: "notes/", exact: true }).click();
        await page.getByRole("link", { name: /ordering.json/ }).click();
        assert.equal(await page.locator("pre.source").innerText(), '{"order": [1, 2]}\n');
        await page
          .getByRole("navigation", { name: "Breadcrumb", exact: true })
          .getByRole("link", { name: "notes", exact: true })
          .click();
        await page.screenshot({ path: join(directory, "supporting-folder.png"), fullPage: true });
      },
    },
    {
      name: BrowserScenario.Citations,
      run: async () => {
        const pdf = citationPdf();
        mkdirSync(join(root, "workbench/citations/CIT-00"), { recursive: true });
        mkdirSync(join(root, "library/citations"), { recursive: true });
        writeFileSync(
          join(root, "workbench/citations/CIT-00/acquisition.yaml"),
          `sources:\n  - kind: published\n    status: acquired\n    landing-url: https://example.invalid/paper\n    sha256: ${createHash("sha256").update(pdf).digest("hex")}\n  - kind: arxiv\n    status: pending\n    landing-url: https://example.invalid/preprint\n`,
        );
        const path = join(root, "library/citations/CIT-00-published.pdf");
        writeFileSync(path, pdf);
        await page.goto(base + "/records/demo:CIT-0");
        await page.getByText("File present locally", { exact: true }).waitFor();
        await page.getByText("File missing locally", { exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "citation-documents-desktop.png"), fullPage: true });
        const viewLink = page.locator(".citation-source .actions").getByRole("link", { name: "Read", exact: true });
        const downloadLink = page.getByRole("link", { name: "Download", exact: true });
        const href = await viewLink.getAttribute("href"),
          download = await downloadLink.getAttribute("href");
        assert(href && download);
        const view = await page.request.get(new URL(href, base).href);
        assert.equal(view.status(), 200);
        assert.equal(view.headers()["content-type"], "application/pdf");
        assert.match(view.headers()["content-disposition"] ?? "", /^inline/);
        assert.deepEqual(await view.body(), pdf);
        const range = await page.request.get(new URL(href, base).href, { headers: { Range: "bytes=0-4" } });
        assert.equal(range.status(), 206);
        assert.equal(range.headers()["content-range"], `bytes 0-4/${String(pdf.length)}`);
        assert.equal(await range.text(), "%PDF-");
        const attachment = await page.request.get(new URL(download, base).href);
        assert.match(attachment.headers()["content-disposition"] ?? "", /^attachment/);
        assert.deepEqual(await attachment.body(), pdf);
        writeFileSync(path, "%PDF-1.7\nChanged PDF bytes.\n");
        assert.equal((await page.request.get(new URL(href, base).href)).status(), 409);
        rmSync(path);
        await page
          .getByText("Acquisition is recorded, but this checkout has no local copy.", { exact: true })
          .waitFor();
        assert.equal(
          await page.locator(".citation-source .actions").getByRole("link", { name: "Read", exact: true }).count(),
          0,
        );
        const article = `<html><head><title>Retained web source</title></head><body><h1>Retained web source</h1><p>Readable article content.</p><figure><img alt="Retained figure" src="data:image/png;base64,${citationImage.toString("base64")}"><figcaption>Figure caption</figcaption></figure></body></html>`;
        const original = article
          .replace(
            "</head>",
            '<script src="https://example.invalid/script.js"></script><link rel="stylesheet" href="https://example.invalid/source.css"></head>',
          )
          .replace(
            "</body>",
            '<aside>Original source context</aside><a href="#source-details">Jump to source details</a><h2 id="source-details">Source details</h2><img alt="Remote source figure" src="https://example.invalid/remote.png"><a href="https://example.invalid/details">Online details</a><iframe src="https://example.invalid/frame"></iframe></body>',
          );
        const compressed = brotliCompressSync(article);
        writeFileSync(join(root, "library/citations/CIT-00-web.original.html.br"), brotliCompressSync(original));
        writeFileSync(join(root, "library/citations/CIT-00-web.html.br"), compressed);
        const metadata = join(root, "workbench/citations/CIT-00/acquisition.yaml");
        writeFileSync(
          metadata,
          readFileSync(metadata, "utf8") +
            `  - kind: web\n    format: html\n    status: acquired\n    landing-url: https://example.invalid/article\n    sha256: ${createHash("sha256").update(original).digest("hex")}\n    extracted-sha256: ${createHash("sha256").update(compressed).digest("hex")}\n`,
        );
        await page.goto(base + "/records/demo:CIT-0");
        const local = page.locator(".citation-source .actions").getByRole("link", { name: "Read", exact: true });
        await local.waitFor();
        await local.evaluate((anchor) => {
          if (!(anchor instanceof HTMLAnchorElement)) throw new Error("Read must remain a native link");
          const save = document.createElement("a");
          save.id = "save-read-link";
          save.href = anchor.href;
          save.download = "";
          save.textContent = "Save read link";
          anchor.after(save);
        });
        const [saved] = await Promise.all([page.waitForEvent("download"), page.locator("#save-read-link").click()]);
        assert.equal(saved.suggestedFilename(), "CIT-00-web.html");
        const savedPath = await saved.path();
        assert(savedPath);
        assert.equal(readFileSync(savedPath, "utf8"), article);
        await page.locator("#save-read-link").evaluate((link) => {
          link.remove();
        });
        await local.click();
        await page.getByRole("heading", { name: "Retained web source" }).waitFor();
        await page.getByAltText("Retained figure").waitFor();
        assert.equal(
          await page
            .getByAltText("Retained figure")
            .evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1),
          true,
        );
        await page.screenshot({ path: join(directory, "citation-html.png"), fullPage: true });
        const external: string[] = [];
        await page.route("https://example.invalid/**", async (route) => {
          external.push(route.request().url());
          assert.equal(route.request().headers().referer, undefined);
          await route.fulfill({ contentType: "image/png", body: citationImage });
        });
        await page.goto(base + "/records/demo:CIT-0");
        await page.getByRole("link", { name: "Original", exact: true }).click();
        const frame = page.frameLocator('iframe[title="Original source document"]');
        await frame.getByText("Original source context", { exact: true }).waitFor();
        assert.deepEqual(external, []);
        await frame.getByRole("link", { name: "Jump to source details" }).click();
        assert.equal(await frame.locator("#source-details").evaluate((element) => element.matches(":target")), true);
        assert.equal(await frame.locator("script,iframe,link[rel=stylesheet]").count(), 0);
        assert.equal(
          await frame.getByRole("link", { name: "Online details" }).getAttribute("href"),
          "https://example.invalid/details",
        );
        await Promise.all([
          page.waitForRequest("https://example.invalid/remote.png"),
          page.getByRole("link", { name: "Enable images", exact: true }).click(),
        ]);
        await frame.getByAltText("Remote source figure").evaluate(
          (image) =>
            new Promise<void>((resolve, reject) => {
              if (!(image instanceof HTMLImageElement)) {
                reject(new Error("Expected source image"));
                return;
              }
              if (image.complete && image.naturalWidth) resolve();
              else {
                image.addEventListener(
                  "load",
                  () => {
                    resolve();
                  },
                  { once: true },
                );
                image.addEventListener(
                  "error",
                  () => {
                    reject(new Error("Image did not load"));
                  },
                  { once: true },
                );
              }
            }),
        );
        assert.deepEqual(external, ["https://example.invalid/remote.png"]);
        await page.screenshot({ path: join(directory, "citation-original.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        const sourceBounds = await page.locator('iframe[title="Original source document"]').boundingBox();
        assert(
          sourceBounds &&
            sourceBounds.x >= 0 &&
            sourceBounds.width <= 390 &&
            sourceBounds.y + sourceBounds.height <= 845,
        );
        await page.screenshot({ path: join(directory, "citation-original-narrow.png"), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.unroute("https://example.invalid/**");
      },
    },
    {
      name: BrowserScenario.Tasks,
      run: async () => {
        const alignedControls = async (row: Locator, pane: Locator) => {
          const buttons = row.getByRole("group").getByRole("button");
          assert.equal(await buttons.count(), 2);
          const boxes = await Promise.all((await buttons.all()).map((button) => button.boundingBox())),
            [up, down] = boxes,
            bounds = await pane.boundingBox();
          assert(up && down && bounds);
          assert(Math.abs(up.y - bounds.y) <= 1, "Move up aligns with the pane's top");
          assert(
            Math.abs(down.y + down.height - bounds.y - bounds.height) <= 1,
            "Move down aligns with the pane's bottom",
          );
          assert(
            boxes.every((box) => box && Math.abs(box.width - up.width) <= 1),
            "Queue buttons have equal widths",
          );
          assert(up.x + up.width <= bounds.x, "Controls stay beside their task");
          return bounds.height;
        };
        const path = join(root, "workbench/tasks/TSK-ZZ.md");
        const taskSource =
          "---\nstatus: Planned\n---\n\n# TSK-ZZ: Deliver the task workflow\n\n## Overview\n\n" +
          "Preserve user work while reviewing the delivered behavior and recovering interrupted operations. "
            .repeat(6)
            .trim() +
          "\n\n## Details\n\n- [x] Check the browser workflow.\n";
        writeFileSync(path, taskSource);
        const taskEvidence = "workbench/tasks/TSK-ZZ/evidence.txt";
        mkdirSync(dirname(join(root, taskEvidence)), { recursive: true });
        writeFileSync(join(root, taskEvidence), "Browser workflow evidence.\n");
        const plain = await newContext({ javaScriptEnabled: false });
        try {
          const review = await plain.newPage();
          await review.goto(base + "/records/demo:TSK-ZZ");
          await review.getByRole("button", { name: "Review plan", exact: true }).waitFor();
          assert.equal(readFileSync(path, "utf8"), taskSource, "Reading a plan does not write formatting");
          await review.getByRole("button", { name: "Review plan", exact: true }).click();
          await review.getByRole("button", { name: "Approve plan", exact: true }).waitFor();
          assert.notEqual(readFileSync(path, "utf8"), taskSource, "Review preparation saves canonical formatting");
          assert.match(readFileSync(path, "utf8"), /status: Planned/, "Formatting does not grant approval");
        } finally {
          await plain.close();
        }
        writeFileSync(path, taskSource);
        const preparation = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith("/actions/review-prepare") &&
            response.status() === 200,
        );
        await page.goto(base + "/records/demo:TSK-ZZ");
        await preparation;
        await page.getByRole("button", { name: "Approve plan", exact: true }).waitFor();
        assert.notEqual(
          readFileSync(path, "utf8"),
          taskSource,
          "Browser enhancement prepares formatting automatically",
        );
        assert.equal(await page.getByRole("checkbox", { name: "Approve plan", exact: true }).count(), 0);
        assert.equal(await page.locator('main textarea[name="reason"]').count(), 0);
        const primary = page.getByRole("button", { name: "Approve plan", exact: true });
        const placement = () =>
          primary.evaluate((button) => {
            const surface = button.closest(".task-decision-actions")?.getBoundingClientRect();
            const bounds = button.getBoundingClientRect();
            if (!surface) throw new Error("Missing task decision surface");
            return { x: bounds.x - surface.x, y: bounds.y - surface.y };
          });
        const collapsedPosition = await placement();
        const toggle = page.locator(".task-decision-actions summary");
        await toggle.focus();
        await toggle.press("Space");
        await page.getByText("Hide plan actions", { exact: true }).waitFor();
        assert.deepEqual(await placement(), collapsedPosition, "Opening secondary actions keeps approval in place");
        assert.equal(await page.getByRole("link", { name: "Revert work", exact: true }).count(), 0);
        await page.getByRole("link", { name: "Cancel plan", exact: true }).click();
        assert.equal(await page.getByRole("button", { name: "Approve plan", exact: true }).count(), 0);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          const reason = await page.getByLabel("Reason (optional)").boundingBox(),
            back = await page.getByRole("link", { name: "Back", exact: true }).boundingBox(),
            confirm = await page.getByRole("button", { name: "Confirm cancellation", exact: true }).boundingBox(),
            pane = await page.locator("main").boundingBox();
          assert(reason && back && confirm && pane);
          assert(reason.height < 130, "Short reasons must not inherit document-editor height");
          assert(Math.abs(back.y - confirm.y) < 2, "Confirmation controls share a row");
          assert(
            Math.abs((back.x + confirm.x + confirm.width) / 2 - (reason.x + reason.width / 2)) < 2,
            "Confirmation controls are centered",
          );
          await page.screenshot({ path: join(directory, `task-cancel-${String(width)}.png`), fullPage: true });
        }
        await page.getByRole("link", { name: "Back", exact: true }).click();
        assert.match(readFileSync(path, "utf8"), /status: Planned/);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.getByRole("button", { name: "Approve plan", exact: true }).click();
        await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
        const work = page.getByRole("main");
        assert.equal(await page.getByRole("button", { name: "Start task", exact: true }).count(), 0);
        workbench("queue", "start", "demo:TSK-ZZ");
        await work.getByText("Implementing", { exact: true }).waitFor();
        writeFileSync(join(root, "task-delivery.ts"), 'export const outcome = "Initial browser result";\n');
        const contextSource = Array.from(
          { length: 100 },
          (_, index) => `Paragraph ${String(index + 1)} **context**.\n`,
        ).join("");
        writeFileSync(join(root, "task-context.md"), contextSource);
        git(root, "add", "workbench/tasks/TSK-ZZ.md", taskEvidence, "task-delivery.ts", "task-context.md");
        git(root, "commit", "-qm", "Start the task workflow\n\nWorkbench-Provisional: true");
        writeFileSync(join(root, "task-delivery.ts"), 'export const outcome = "Verified in Chromium";\n');
        writeFileSync(
          path,
          readFileSync(path, "utf8") + "\n## Implementation account\n\nDelivered the browser workflow.\n",
        );
        writeFileSync(join(root, "task-context.md"), contextSource.replace("Paragraph 50", "Changed paragraph 50"));
        const extraPaths = Array.from({ length: 51 }, (_, index) => `zz-extra-${String(index).padStart(2, "0")}.ts`);
        for (const [index, file] of extraPaths.entries())
          writeFileSync(join(root, file), `export const value = ${String(index)};\n`);
        writeFileSync(join(root, "zz-large.md"), "Long document line. ".repeat(5000));
        git(
          root,
          "add",
          "workbench/tasks/TSK-ZZ.md",
          "task-delivery.ts",
          "task-context.md",
          "zz-large.md",
          ...extraPaths,
        );
        git(
          root,
          "commit",
          "-qm",
          "Deliver the task workflow\n\nVerify human approval and task acceptance in the browser.\n\nWorkbench-Provisional: true",
        );
        workbench(
          "queue",
          "implemented",
          "demo:TSK-ZZ",
          "--evidence",
          "Verified the human approval and queue workflow in Chromium.",
        );
        let outcomePage = await page.goto(base + "/reviews");
        // The CLI just changed the queue while the server may be capturing a review snapshot.
        const refreshDeadline = Date.now() + 5000;
        while (outcomePage?.status() === 409 && Date.now() < refreshDeadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          outcomePage = await page.reload();
        }
        assert(outcomePage?.ok(), "Task outcome page returned " + String(outcomePage?.status()));
        await page
          .locator('[data-task-group^="task:"]')
          .getByRole("link", { name: /Deliver the task workflow/ })
          .click();
        assert.equal(await page.locator('.sidebar a[href*="/history"]').count(), 0);
        await page
          .getByRole("region", { name: "Task commits", exact: true })
          .getByRole("link", { name: /Deliver the task workflow/ })
          .click();
        const commitMessage = page.locator('pre[aria-label="Commit message"]');
        assert(await commitMessage.isVisible(), "Commit messages are visible without opening a disclosure");
        assert.match(await commitMessage.innerText(), /Verify human approval and task acceptance in the browser/);
        const contextFile = page.locator('[data-commit-file="task-context.md"]');
        assert.equal(await contextFile.locator(".document-diff").count(), 0);
        assert.equal(await contextFile.getByText("Paragraph 1 **context**.", { exact: true }).count(), 0);
        await contextFile.getByRole("link", { name: "Show more lines above", exact: true }).click();
        await contextFile.getByText("Paragraph 30 **context**.", { exact: true }).waitFor();
        assert(
          await page.locator('[data-commit-file="task-delivery.ts"]').isVisible(),
          "Context expansion retains other files",
        );
        await page.locator('[data-commit-file="task-delivery.ts"] .hljs-keyword').first().waitFor();
        await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
        await page.locator('[data-commit-file="task-delivery.ts"] .file-diff-split').waitFor();
        await page.getByRole("link", { name: "Unified", exact: true }).click();
        assert.equal(await page.getByRole("link", { name: "More files", exact: true }).count(), 0);
        assert.equal(await page.getByRole("link", { name: "Previous files", exact: true }).count(), 0);
        assert((await page.locator("[data-commit-file]").count()) >= 4, "All file headers are present immediately");
        const lastPath = extraPaths.at(-1);
        assert(lastPath, "The fixture includes a deferred small file");
        const lastSmall = page.locator(`[data-commit-file="${lastPath}"]`);
        await lastSmall.locator(".file-diff code").first().waitFor();
        assert.equal(await page.evaluate(() => window.scrollY), 0, "Small diffs finish without scrolling");
        assert(await page.locator('[data-commit-file="zz-large.md"]').getByRole("link", { name: "Load diff" }).count());
        await page.reload();
        assert(
          (await page.locator("[data-commit-file]").count()) >= 4,
          "Reload retains the complete changed-file list",
        );
        await page.setViewportSize({ width: 1440, height: 1000 });
        const fileNavigation = page.getByRole("navigation", { name: "Changed files", exact: true });
        const fileList = fileNavigation.getByRole("region", { name: "File list", exact: true });
        const pageScroll = await page.evaluate(() => window.scrollY);
        assert(
          await fileList.evaluate((list) => {
            list.scrollTop = list.scrollHeight;
            return list.scrollTop > 0;
          }),
          "The visible file list has an independent scroll area",
        );
        assert.equal(await page.evaluate(() => window.scrollY), pageScroll);
        await contextFile.evaluate((file) => {
          file.scrollIntoView({ block: "start" });
        });
        await fileNavigation
          .getByRole("link", { name: "task-context.md", exact: true })
          .and(page.locator('[aria-current="location"]'))
          .waitFor();
        const navigationBounds = await fileNavigation.boundingBox();
        assert(navigationBounds && navigationBounds.y >= 0, "The file list stays in view while the diff scrolls");
        await contextFile.locator(":scope > .commit-file-heading").hover();
        await fileNavigation.locator('a[title="task-context.md"][data-file-hover]').waitFor();
        await fileList.hover();
        assert.equal(await fileNavigation.locator("[data-file-hover]").count(), 0);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            "Inline comparisons fit the viewport",
          );
          await page.evaluate(axe.source);
          const inlineAccessibility = await page.evaluate<axe.AxeResults>("axe.run(document)");
          assert.deepEqual(inlineAccessibility.violations, [], "Inline commit-file accessibility violations");
          await page.screenshot({ path: join(directory, `task-inline-${String(width)}.png`), fullPage: true });
        }
        const filter = page.locator("[data-commit-file-filter]"),
          large = page.locator('[data-commit-file="zz-large.md"]'),
          largeLink = fileNavigation.getByRole("link", { name: "zz-large.md", exact: true }),
          delivery = page.locator('[data-commit-file="task-delivery.ts"]'),
          inlineURL = new URL(page.url());
        await filter.fill("ZZ-LARGE");
        await large.evaluate((file) => {
          (file as HTMLDetailsElement).open = false;
        });
        const anchor = await largeLink.getAttribute("href");
        assert(anchor?.startsWith("#"));
        await largeLink.click();
        await page.waitForURL((url) => url.hash === anchor && url.search === inlineURL.search);
        assert.equal(await filter.inputValue(), "ZZ-LARGE", "A jump preserves the file filter");
        assert.equal(await large.getAttribute("open"), "");
        await large.getByRole("link", { name: "Load diff", exact: true }).click();
        await large.locator(".file-diff code").first().waitFor();
        await filter.fill("");
        await fileNavigation.getByRole("link", { name: "task-delivery.ts", exact: true }).click();
        await fileNavigation.locator('a[title="task-delivery.ts"][aria-current="location"]').waitFor();
        await delivery.getByText('export const outcome = "Verified in Chromium";', { exact: true }).waitFor();
        assert.match(await delivery.locator(".file-diff .diff-removed").innerText(), /Initial browser result/);
        await page.getByLabel("File actions: task-delivery.ts", { exact: true }).click();
        assert(
          await page.getByRole("link", { name: "Download current file", exact: true }).isVisible(),
          "File downloads are available from the compact header menu",
        );
        await page.getByLabel("File actions: task-delivery.ts", { exact: true }).click();
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            "Commit inspection fits the viewport",
          );
          await page.evaluate(axe.source);
          const accessibility = await page.evaluate<axe.AxeResults>("axe.run(document)");
          writeFileSync(
            join(directory, `task-commit-${String(width)}-accessibility.json`),
            JSON.stringify(accessibility, null, 2),
          );
          assert.deepEqual(accessibility.violations, [], "Commit-file accessibility violations");
          await page.screenshot({ path: join(directory, `task-commit-${String(width)}.png`), fullPage: true });
        }
        const scroll = delivery.locator(".file-diff-scroll");
        await scroll.focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(
          () =>
            (document.querySelector('[data-commit-file="task-delivery.ts"] .file-diff-scroll')?.scrollLeft ?? 0) > 0,
        );
        const plainContext = await newContext({ javaScriptEnabled: false }),
          plainPage = await plainContext.newPage();
        try {
          const url = new URL(inlineURL);
          url.hash = "";
          await plainPage.goto(url.href);
          await plainPage
            .getByRole("navigation", { name: "Changed files", exact: true })
            .getByRole("link", { name: "task-context.md", exact: true })
            .click();
          const target = await plainPage.locator('[data-commit-file="task-context.md"]').getAttribute("id");
          assert(target, "The selected file has a fragment target");
          assert.equal(new URL(plainPage.url()).hash, "#" + target);
          url.searchParams.set("path", "task-context.md");
          url.searchParams.delete("context");
          await plainPage.goto(url.href);
          await plainPage.getByRole("link", { name: "Show more lines above", exact: true }).click();
          await plainPage.getByText("Paragraph 30 **context**.", { exact: true }).waitFor();
          assert.equal(await plainPage.locator("form[data-review]").count(), 0);
          assert.equal(await plainPage.locator("[data-commit-file]").count(), 1);
          await plainPage
            .getByRole("navigation", { name: "Changed files", exact: true })
            .getByRole("link", { name: "task-delivery.ts", exact: true })
            .click();
          const destination = new URL(plainPage.url()),
            destinationFile = plainPage.locator('[data-commit-file="task-delivery.ts"]'),
            destinationId = await destinationFile.getAttribute("id");
          assert(destinationId, "File selection from a single comparison returns to the commit file list");
          assert.equal(destination.search, inlineURL.search);
          assert.equal(destination.hash, "#" + destinationId);
          await plainPage.reload();
          assert.equal(plainPage.url(), destination.href);
          assert(await plainPage.locator('[data-commit-file="task-context.md"]').isVisible());
          const heading = await destinationFile.locator(":scope > summary").boundingBox(),
            viewport = plainPage.viewportSize();
          assert(heading && viewport && heading.y >= 0 && heading.y < viewport.height, "Reload jumps to the file");
        } finally {
          await plainContext.close();
        }
        await page
          .getByRole("navigation", { name: "Breadcrumb" })
          .getByRole("link", { name: /Deliver the task workflow/ })
          .click();
        const taskActions = page.locator(".task-decision-actions summary");
        const acceptOutcome = page.getByRole("button", { name: "Accept outcome", exact: true });
        const documentHeading = await page
            .getByRole("heading", { name: "Implementation account", exact: true })
            .boundingBox(),
          commits = await page.getByRole("region", { name: "Task commits", exact: true }).boundingBox(),
          evidence = await page.getByRole("link", { name: /evidence\.txt/ }).boundingBox(),
          decision = await acceptOutcome.boundingBox();
        assert(documentHeading && commits && evidence && decision);
        assert(
          documentHeading.y < commits.y && commits.y < evidence.y && evidence.y < decision.y,
          "The task document, commits, and supporting files precede acceptance in that order",
        );
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          const actions = await taskActions.boundingBox();
          const accept = await acceptOutcome.boundingBox();
          assert(actions && accept, "Both task decisions are visible");
          assert.equal(actions.y, accept.y, "Task decisions share the same top edge");
          assert.equal(actions.height, accept.height, "Task decisions share the same height");
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/actions/task-state") &&
              response.status() === 200,
          ),
          page.getByRole("button", { name: "Accept outcome", exact: true }).click(),
        ]);
        await page.getByRole("heading", { name: "Reviews", exact: true }).waitFor();
        assert.match(readFileSync(path, "utf8"), /status: Accepted/);
        assert.equal(
          await page
            .locator('[data-task-group^="task:"]')
            .getByRole("link", { name: /Deliver the task workflow/ })
            .count(),
          0,
        );
        await page.screenshot({ path: join(directory, "task-queue.png"), fullPage: true });
        await page.goto(base + "/records/demo:TSK-ZZ");
        assert.equal(await page.getByRole("link", { name: "Cancel task", exact: true }).count(), 0);
        const planText = "---\nstatus: Planned\nadded_at: 2026-11-12T12:39:15.000Z\n---\n\n# Disposable browser plan\n",
          input = join(root, "browser-plan.md");
        writeFileSync(input, planText);
        workbench("task", "plan", "create", "discarded", "--file", input);
        rmSync(input);
        await page.goto(base + "/plans");
        await page.getByRole("link", { name: "Disposable browser plan", exact: true }).click();
        await page.getByRole("heading", { name: "Disposable browser plan", exact: true }).waitFor();
        assert.deepEqual(await page.locator("main .task-secondary-actions").locator("a, button").allTextContents(), [
          "Delete plan",
          "Cancel plan",
        ]);
        assert.equal(await page.getByRole("link", { name: "Delete plan", exact: true }).isVisible(), false);
        assert.equal(await page.getByRole("link", { name: "Cancel plan", exact: true }).isVisible(), false);
        assert.equal(
          await page
            .getByRole("button", { name: "Approve plan", exact: true })
            .evaluate((button) => button.classList.contains("secondary")),
          false,
        );
        const added = page.locator(".record-location time");
        assert.equal(await added.getAttribute("datetime"), "2026-11-12T12:39:15.000Z");
        assert.doesNotMatch(await added.innerText(), /T12:39:15/);
        const planAddress = page.url(),
          shortHeights = new Map<number, number>();
        for (const profile of ["short", "long"]) {
          if (profile === "long") {
            await page.getByRole("link", { name: "Edit", exact: true }).click();
            assert.deepEqual(await page.locator("form[data-editor] .actions").locator("a, button").allTextContents(), [
              "Cancel",
              "Save draft",
            ]);
            await page
              .getByLabel("Plan", { exact: true })
              .fill(
                planText +
                  "\nA shared service keeps project activity available across command-line and browser sessions. It preserves unfinished work, separates approval from execution, and reports failures with enough context to recover. Its lifecycle supports installation, startup, shutdown, and upgrades while protecting active operations. The implementation must keep local access usable without introducing additional privileges or requiring developers to restart their projects.\n",
              );
            await page.getByRole("button", { name: "Save draft", exact: true }).click();
            await page.waitForURL((url) => url.searchParams.get("view") !== "edit");
            await page.getByText("A shared service keeps project activity available", { exact: false }).waitFor();
            await page.getByRole("button", { name: "Approve plan", exact: true }).waitFor();
          }
          await page.goto(base + "/plans");
          const row = page.locator('[data-task-node="demo:plan/discarded"]');
          for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            assert.equal(await row.getByRole("group").count(), 0, "Unapproved plans have no execution-order controls");
            const bounds = await row.boundingBox();
            assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
            const height = bounds.height;
            if (profile === "short") shortHeights.set(width, height);
            else assert(height > (shortHeights.get(width) ?? Infinity), "The fixture exercises a taller pane");
            await row.screenshot({ path: join(directory, `plan-list-${profile}-${String(width)}.png`) });
          }
          await page.goto(planAddress);
          await page.getByRole("button", { name: "Approve plan", exact: true }).waitFor();
        }
        await page.getByText("Show plan actions", { exact: true }).click();
        await page.getByRole("link", { name: "Cancel plan", exact: true }).click();
        await page.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get("view") !== "cancel");
        await page.getByText("Show plan actions", { exact: true }).click();
        await page.getByRole("link", { name: "Delete plan", exact: true }).click();
        assert.equal(await page.getByLabel("Reason (optional)").count(), 0);
        assert.equal(await page.getByRole("button", { name: "Approve plan", exact: true }).count(), 0);
        await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
        await page.getByRole("heading", { name: "Plans", exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: /Disposable browser plan/ }).count(), 0);

        for (const [id, title] of [
          ["V", "Prepare data"],
          ["W", "Build the report"],
          ["X", "Publish the report"],
        ] as const)
          writeFileSync(
            join(root, `workbench/tasks/TSK-0${id}.md`),
            `---\nstatus: Approved\n---\n\n# TSK-${id}: ${title}\n\n## Overview\n\nA browser fixture task.\n`,
          );
        workbench("queue", "add", "demo:TSK-V", "demo:TSK-W", "demo:TSK-X");
        await page.goto(base + "/work");
        const queued = page.locator(".task-queue > [data-task-node]");
        await queued.nth(2).waitFor();
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const [index, row] of (await queued.all()).entries()) {
            const controls = row.getByRole("group"),
              buttons = controls.getByRole("button");
            await alignedControls(row, row.locator(".task-queue-content"));
            assert.equal(await buttons.count(), 2);
            assert.equal(await buttons.nth(0).isDisabled(), index === 0);
            assert.equal(await buttons.nth(1).isDisabled(), index === 2);
            assert.match((await buttons.nth(0).getAttribute("aria-label")) ?? "", /^Move up:/);
            assert.match((await buttons.nth(1).getAttribute("aria-label")) ?? "", /^Move down:/);
          }
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            "Task controls and content fit a narrow window",
          );
          await page.screenshot({ path: join(directory, `task-order-${String(width)}.png`), fullPage: true });
        }
        await page.getByRole("button", { name: "Move down: Prepare data", exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector(".task-queue > li")?.getAttribute("data-task-node") === "demo:TSK-W",
        );
        assert.deepEqual(
          await queued.evaluateAll((items) => items.map((item) => item.getAttribute("data-task-node"))),
          ["demo:TSK-W", "demo:TSK-V", "demo:TSK-X"],
        );
        workbench("queue", "remove", "demo:TSK-V");
        await page.waitForFunction(() => document.querySelectorAll(".task-queue > li").length === 2);
        assert.deepEqual(
          await queued.evaluateAll((items) => items.map((item) => item.getAttribute("data-task-node"))),
          ["demo:TSK-W", "demo:TSK-X"],
        );
        assert.match(readFileSync(join(root, "workbench/tasks/TSK-0V.md"), "utf8"), /status: Approved/);
        await page.screenshot({ path: join(directory, "task-removed-from-queue.png"), fullPage: true });
        rmSync(path);
      },
    },
    {
      name: BrowserScenario.Windows,
      run: async () => {
        for (let number = 1; number < 120; number++)
          writeFileSync(
            join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`),
            `---\nstatus: Planned\n---\n\n# TSK-${number.toString(36).toUpperCase()}: Task ${String(number)}\n`,
          );
        await page.goto(base + "/records?type=TSK&status=Planned");
        await page.getByRole("heading", { name: "TSK-3B: Task 119", exact: true }).waitFor();
        assert.equal(await page.locator('[data-task-window="roots"] [data-record-id]').count(), 100);
        await page.evaluate(() => {
          globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight);
        });
        await page.getByRole("heading", { name: "TSK-0: Inspect the interface", exact: true }).waitFor();
        assert.equal(await page.locator('[data-task-window="roots"] [data-record-id]').count(), 120);
        const manualContext = await newContext();
        const manual = await manualContext.newPage();
        await manual.addInitScript(() => {
          Object.defineProperty(globalThis, "IntersectionObserver", { value: undefined, configurable: true });
        });
        await manual.goto(base + "/records?type=TSK&status=Planned");
        await manual.getByRole("link", { name: "Load more", exact: true }).click();
        await manual.getByRole("heading", { name: "TSK-0: Inspect the interface", exact: true }).waitFor();
        const taskZero = join(root, "workbench/tasks/TSK-00.md");
        writeFileSync(
          taskZero,
          readFileSync(taskZero, "utf8").replace("TSK-0: Inspect the interface", "TSK-0: Refreshed expanded result"),
        );
        await manual.getByRole("heading", { name: "TSK-0: Refreshed expanded result", exact: true }).waitFor();
        assert.equal(await manual.locator('[data-task-window="roots"] [data-record-id]').count(), 120);
        await manualContext.close();
        await page.goto(base + "/records?type=TSK");
        assert.equal(await page.locator("[data-task-node]").count(), 100);
        await page.evaluate(() => {
          globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight);
        });
        await page.getByRole("heading", { name: "TSK-0: Refreshed expanded result", exact: true }).waitFor();
        assert.equal(await page.locator("[data-task-node]").count(), 120);
        assert.equal(new URL(page.url()).searchParams.get("through"), "demo:TSK-0");
        for (let number = 120; number < 500; number++)
          writeFileSync(
            join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`),
            `---\nstatus: Planned\n---\n\n# TSK-${number.toString(36).toUpperCase()}: Task ${String(number)}\n`,
          );
        await page.goto(base + "/records?type=TSK&status=Planned&q=TSK-");
        await page.getByRole("heading", { name: "TSK-DV: Task 499", exact: true }).waitFor();
        for (const end of [300, 200, 100]) {
          await page.evaluate(() => {
            globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight);
          });
          await page
            .getByRole("heading", { name: `TSK-${end.toString(36).toUpperCase()}: Task ${String(end)}`, exact: true })
            .waitFor();
        }
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        // Automatic loading may already have advanced another batch. Reopen an exact retained window before
        // exercising keyboard-focus protection, rather than racing the observer from the automation process.
        await page.goto(base + "/records?type=TSK&status=Planned&q=TSK-&after=demo:TSK-B4&through=demo:TSK-2S");
        await page.getByRole("heading", { name: "TSK-B3: Task 399", exact: true }).waitFor();
        const first = page.locator("#record-list [data-record-id]").first();
        await first.focus();
        await page.evaluate(() => {
          globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight);
        });
        await page
          .getByText("Automatic loading paused to preserve keyboard focus. Use Load more to continue.", { exact: true })
          .waitFor();
        assert.equal(await page.locator(":focus").getAttribute("data-record-id"), "demo:TSK-B3");
        await page.getByRole("link", { name: "Load more", exact: true }).click();
        await page.getByRole("heading", { name: "TSK-0: Refreshed expanded result", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        await page.reload();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        await page.locator("#record-list [data-record-id]").last().getByRole("link").click();
        await page.getByRole("heading", { name: "TSK-0: Refreshed expanded result", exact: true }).waitFor();
        await page.goBack();
        await page.getByRole("heading", { name: "TSK-0: Refreshed expanded result", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        await page.getByRole("link", { name: "Load previous records", exact: true }).click();
        await page.getByRole("heading", { name: "TSK-8C: Task 300", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 100);
      },
    },
    {
      name: BrowserScenario.Live,
      run: async () => {
        await page.goto(base + "/records/demo:TSK-0");
        const task = join(root, "workbench/tasks/TSK-00.md");
        writeFileSync(task, readFileSync(task, "utf8") + "\nLive refreshed content.\n");
        await page.getByText("Live refreshed content.", { exact: true }).waitFor({ timeout: 10000 });
        const navigation = page
          .getByRole("navigation", { name: "Main navigation" })
          .getByRole("link", { name: /^Tasks/ });
        await navigation.focus();
        writeFileSync(task, readFileSync(task, "utf8") + "\nKeyboard focus retained.\n");
        await page.getByText("Keyboard focus retained.", { exact: true }).waitFor();
        const focused = new URL((await page.locator(":focus").getAttribute("href")) ?? "", base);
        assert.equal(focused.pathname, new URL(base).pathname + "/records");
        assert.equal(focused.searchParams.get("type"), "TSK");
        assert.equal(focused.searchParams.get("scope"), "demo");
        const search = page.getByLabel("Search project records");
        await search.fill("Search draft retained during rename");
        const registry = join(root, "workbench/projects.toml");
        writeFileSync(
          registry,
          readFileSync(registry, "utf8").replace('id="demo"', 'id="demo"\nname="Renamed project"'),
        );
        await page.locator(".project-switch-name").getByText("Renamed project", { exact: true }).waitFor();
        assert.equal(await search.inputValue(), "Search draft retained during rename");
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).searchParams.get("workflow") === "plans"),
          page.goto(base + "/plans"),
        ]);
        const plan = join(root, "workbench/tasks/TSK-0Z.md"),
          title = "TSK-Z: Explain notebook tags";
        writeFileSync(plan, `---\nstatus: Planned\n---\n\n# ${title}\n`);
        const draft = page.getByRole("link", { name: title, exact: true });
        await draft.waitFor();
        assert.equal(await page.locator("#workflow-notice").textContent(), "");
        await draft.click();
        await page.getByRole("button", { name: "Approve plan", exact: true }).click();
        await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).searchParams.get("workflow") === "reviews"),
          page.goto(base + "/reviews"),
        ]);
        writeFileSync(plan, readFileSync(plan, "utf8") + "\nInclude examples for offline notebooks.\n");
        await page.getByRole("region", { name: "Awaiting approval" }).getByRole("link", { name: title }).waitFor();
        await page.waitForFunction(
          () => document.getElementById("workflow-notice")?.textContent === "A plan needs approval",
        );
      },
    },
    {
      name: BrowserScenario.Responsive,
      run: async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(base);
        await page.screenshot({ path: join(directory, "charters-mobile.png"), fullPage: true });
        assert(
          await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
          "Mobile viewport overflows",
        );
        await page.getByLabel("Search project records").fill("Source document");
        await page.getByLabel("Record type", { exact: true }).selectOption("CIT");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: /Source document/ }).waitFor();
        assert.equal(await page.getByLabel("Record type", { exact: true }).inputValue(), "CIT");
        for (const width of [320, 700]) {
          await page.setViewportSize({ width, height: 844 });
          assert(
            await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
            `Search controls overflow at ${String(width)} pixels`,
          );
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(directory, "search-mobile.png"), fullPage: true });
        await page.goto(base + "/records/demo:ADR-0?view=changes&layout=split");
        await page.screenshot({ path: join(directory, "adr-diff-mobile.png"), fullPage: true });
        assert(
          await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
          "Mobile diff overflows",
        );
        for (const width of [320, 700]) {
          await page.setViewportSize({ width, height: 844 });
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `Side-by-side review overflows at ${String(width)} pixels`,
          );
        }
        await page.goto(base + "/records/demo:ADR-0/review?layout=split");
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "Review layout overflows",
        );
        await page.setViewportSize({ width: 320, height: 844 });
        const columns = ["Manager", ...Array.from({ length: 19 }, (_, index) => "Column " + String(index))];
        const values = ["Development", ...columns.slice(1)];
        writeFileSync(
          join(root, "workbench/decisions/ADR-01.md"),
          "---\nsummary: A wide table.\n---\n\n# ADR-1: Wide table\n\n| " +
            columns.join(" | ") +
            " |\n| " +
            columns.map(() => "---").join(" | ") +
            " |\n| " +
            values.join(" | ") +
            " |\n",
        );
        await page.goto(base + "/records/demo:ADR-1");
        const table = page.getByRole("region", { name: "Document table", exact: true });
        for (const [role, name] of [
          ["columnheader", "Manager"],
          ["cell", "Development"],
        ] as const) {
          const cell = table.getByRole(role, { name, exact: true });
          assert.equal(
            await cell.evaluate((element) => {
              const text = element.ownerDocument.createRange();
              text.selectNodeContents(element);
              return text.getClientRects().length;
            }),
            1,
            `Keep the table word "${name}" on one line`,
          );
        }
        await table.focus();
        assert(
          await table.evaluate((element) => element.scrollWidth > element.clientWidth),
          "Wide table must scroll independently",
        );
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => (document.querySelector(".table-wrap")?.scrollLeft ?? 0) > 0);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "Wide document table overflows the page",
        );
        const longTitle = "Unbroken title " + "W".repeat(400);
        writeFileSync(
          join(root, "workbench/citations/CIT-00.json"),
          JSON.stringify([
            {
              id: "demo-CIT-0",
              type: "article-journal",
              title: longTitle,
              author: [{ given: "Ada", family: "Lovelace" }],
              issued: { "date-parts": [[2026]] },
            },
          ]),
        );
        await page.goto(base + "/records/demo:CIT-0");
        await page.getByRole("heading", { name: longTitle, exact: true }).waitFor();
        assert(
          await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
          "Long record title overflows the narrow viewport",
        );
        await page.screenshot({ path: join(directory, "wrapping-mobile.png"), fullPage: true });
        await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
        await page.goto(base + "/reviews");
        await page.screenshot({ path: join(directory, "review-forced-colors.png"), fullPage: true });
        await page.keyboard.press("Tab");
        assert.equal(await page.locator(":focus").textContent(), "Skip to content");
      },
    },
    {
      name: BrowserScenario.Sources,
      run: async () => {
        await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
        await page.setViewportSize({ width: 1440, height: 1000 });
        const registry = join(root, "workbench/projects.toml");
        writeFileSync(
          registry,
          readFileSync(registry, "utf8").replace('id="demo"', 'id="demo"\nname="GraphAI"') +
            '\n[[project]]\nid="graphmp"\nname="GraphMP"\npath="packages/compute"\n[[project]]\nid="solver"\npath="packages/compute/src/solver"\n',
        );
        for (const [id, path] of [
          ["graphmp", "packages/compute"],
          ["solver", "packages/compute/src/solver"],
        ]) {
          mkdirSync(join(root, path ?? "", "workbench/tasks"), { recursive: true });
          writeFileSync(
            join(root, path ?? "", "workbench/tasks/TSK-00.md"),
            `---\nstatus: Planned\n---\n\n# TSK-0: ${id ?? ""} nested discovery token\n`,
          );
        }
        await page.goto(base + "/records?scope=solver&type=TSK");
        const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
        await breadcrumbs.getByRole("link", { name: "solver", exact: true }).waitFor();
        assert.deepEqual(await breadcrumbs.getByRole("link").allTextContents(), ["GraphAI", "GraphMP", "solver"]);
        const sources = page.getByRole("navigation", { name: "Record sources" });
        const parent = sources.getByRole("link", { name: "GraphMP", exact: true });
        await parent.focus();
        await page.keyboard.press("ArrowLeft");
        await sources.getByRole("link", { name: "solver", exact: true }).waitFor({ state: "hidden" });
        await page.keyboard.press("ArrowRight");
        await sources.getByRole("link", { name: "solver", exact: true }).waitFor();
        const name = await page.locator(".project-switch-name").boundingBox();
        const action = await page.locator(".project-switch-action").boundingBox();
        assert(
          name && action && action.x >= name.x + name.width && action.y < name.y + name.height,
          "Switch project must appear beside the project name",
        );
        assert.equal(await page.locator("#record-source").count(), 0);
        assert.equal(await page.locator("a.brand").count(), 0);
        const rootName = await sources.getByRole("link", { name: "GraphAI", exact: true }).boundingBox();
        const groupName = await sources.locator(".source-group-label").boundingBox();
        const collectionName = await sources.getByRole("link", { name: "company", exact: true }).boundingBox();
        assert(
          rootName &&
            groupName &&
            collectionName &&
            Math.abs(rootName.x - groupName.x) < 1 &&
            collectionName.x > groupName.x,
          "Root source labels must align and collection items must be nested",
        );
        assert.equal(await sources.getByRole("link", { name: "All sources", exact: true }).count(), 0);
        const disclosure = sources.getByRole("button", { name: "Toggle subprojects of GraphMP", exact: true });
        await disclosure.focus();
        const nestedTask = join(root, "packages/compute/src/solver/workbench/tasks/TSK-00.md");
        writeFileSync(nestedTask, readFileSync(nestedTask, "utf8") + "\nLive nested summary.\n");
        await page.getByText("Live nested summary.", { exact: true }).waitFor();
        assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Toggle subprojects of GraphMP");
        for (const label of ["Plans", "Work", "Reviews"]) {
          await page
            .getByRole("navigation", { name: "Main navigation" })
            .getByRole("link", { name: new RegExp(`^${label}\\b`) })
            .click();
          await page.getByRole("heading", { name: label, exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get("scope"), "solver");
          await page.screenshot({ path: join(directory, `scoped-${label.toLowerCase()}.png`), fullPage: true });
        }
        await page.getByLabel("Search project records").fill("nested discovery token");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: "TSK-0: graphmp nested discovery token", exact: true }).waitFor();
        await page.getByRole("heading", { name: "TSK-0: solver nested discovery token", exact: true }).waitFor();
        await page
          .getByRole("navigation", { name: "Record sources" })
          .getByRole("link", { name: "GraphMP", exact: true })
          .click();
        await page.screenshot({ path: join(directory, "source-hierarchy-desktop.png"), fullPage: true });
        assert(!(await page.getByRole("navigation", { name: "Record sources" }).innerText()).includes("packages"));
        await breadcrumbs.getByRole("link", { name: "GraphAI", exact: true }).click();
        await page.getByRole("heading", { name: "Charters", exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get("scope"), "demo");

        await page.goto(base + "/records/solver:TSK-0");
        await page.getByRole("button", { name: "Approve plan", exact: true }).click();
        await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
        workbench("queue", "start", "solver:TSK-0");
        await page.goto(base + "/reviews?collection=company");
        const parentReviews = sources.getByRole("link", { name: "1 pending review in GraphAI/GraphMP", exact: true });
        assert.equal(await parentReviews.count(), 0);
        const sharedPolicy = "workbench/decisions/ADR-0Y.md";
        writeFileSync(
          join(root, sharedPolicy),
          "---\nsummary: Shared solver policy.\n---\n\n# ADR-Y: Solver policy\n\nShared policy for the solver.\n",
        );
        writeFileSync(
          nestedTask,
          readFileSync(nestedTask, "utf8") + "\n## Implementation account\n\nDelivered the shared solver policy.\n",
        );
        git(root, "add", sharedPolicy, nestedTask, registry);
        git(
          root,
          "commit",
          "-qm",
          "Deliver shared solver policy\n\nWorkbench-Provisional: true",
          "--",
          sharedPolicy,
          nestedTask,
          registry,
        );
        workbench("queue", "implemented", "solver:TSK-0", "--evidence", "Verified shared solver policy");
        await parentReviews.waitFor();
        await parentReviews.click();
        await page.waitForURL(
          (url) => url.pathname.endsWith("/reviews") && url.searchParams.get("scope") === "graphmp",
        );
        const group = page.locator('[data-task-group="task:solver:TSK-0"]');
        await group.waitFor();
        const scopedReviews = page.url();
        await page.goto(base + "/records/graphmp:TSK-0");
        await page.getByRole("button", { name: "Approve plan", exact: true }).click();
        await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
        workbench("queue", "start", "graphmp:TSK-0");
        workbench("queue", "implemented", "graphmp:TSK-0", "--evidence", "Verified the earlier outcome");
        await page.goto(scopedReviews);
        await page
          .locator('[data-task-group="task:graphmp:TSK-0"]')
          .getByRole("link", { name: "TSK-0: graphmp nested discovery token", exact: true })
          .click();
        await page.locator('a[rel="next"]').click();
        await page.getByRole("button", { name: "Confirm new file", exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get("path"), sharedPolicy);
        await page.getByRole("heading", { name: "demo:ADR-Y: Solver policy", level: 1, exact: true }).waitFor();
        assert.deepEqual(await breadcrumbs.getByRole("link").allTextContents(), [
          "GraphAI",
          "GraphMP",
          "Reviews",
          "TSK-0: solver nested discovery token",
        ]);
        assert.doesNotMatch(await page.locator(".commit-review-context").innerText(), /solver nested discovery token/);
        const reviewURL = page.url();
        await page.getByRole("link", { name: /^Commit [0-9a-f]{12}$/ }).click();
        await page.getByRole("heading", { name: "Deliver shared solver policy", level: 1, exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get("scope"), "graphmp");
        await page.getByRole("navigation", { name: "Changed files", exact: true }).waitFor();
        assert.equal(await page.locator("form[data-review]").count(), 0);
        await page.goBack();
        await page.waitForURL(reviewURL);
        await page.getByRole("button", { name: "Confirm new file", exact: true }).waitFor();
        await page.locator('a[rel="next"]').click();
        await page.getByRole("heading", { name: "TSK-0: solver nested discovery token", exact: true }).waitFor();
        await page.locator('a[rel="prev"]').click();
        await page.getByRole("button", { name: "Confirm new file", exact: true }).waitFor();
        await page.locator('a[rel="prev"]').click();
        await page.getByRole("heading", { name: "TSK-0: graphmp nested discovery token", exact: true }).waitFor();
        await page.getByRole("button", { name: "Accept outcome", exact: true }).click();
        await page.waitForURL(scopedReviews);
        await parentReviews.waitFor();
        await page.screenshot({ path: join(directory, "subproject-review-queue.png"), fullPage: true });
        await group.getByRole("link", { name: "ADR-Y: Solver policy", exact: true }).click();
        await page.getByRole("button", { name: "Confirm new file", exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get("scope"), "graphmp");
        assert.equal(new URL(page.url()).searchParams.get("task"), "solver:TSK-0");
        await page.reload();
        await page.getByRole("button", { name: "Confirm new file", exact: true }).click();
        await page.waitForURL(
          (url) =>
            url.pathname.endsWith("/records/solver:TSK-0") &&
            url.searchParams.get("scope") === "graphmp" &&
            url.searchParams.get("workflow") === "1",
        );
        await parentReviews.waitFor();
        await page.getByRole("heading", { name: "TSK-0: solver nested discovery token", exact: true }).waitFor();
        await page.getByRole("button", { name: "Accept outcome", exact: true }).click();
        await page.waitForURL(scopedReviews);
        assert.equal(await group.getByRole("link", { name: "ADR-Y: Solver policy", exact: true }).count(), 0);
        assert.equal(await parentReviews.count(), 0);
      },
    },
    {
      name: BrowserScenario.Demonstration,
      run: async () => {
        await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
        await page.setViewportSize({ width: 1440, height: 1000 });
        const origin = new URL(base).origin;
        const demonstration = origin + "/demonstration";
        await page.goto(origin + "/projects");
        await page.getByRole("button", { name: "Open demonstration", exact: true }).click();
        await page.waitForURL(demonstration + "/");
        await page.getByText("Demonstration", { exact: true }).waitFor();
        assert.equal(await page.locator(".project-switch").getAttribute("href"), "/projects");
        await page.setViewportSize({ width: 320, height: 844 });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "Demo project controls overflow with enlarged text",
        );
        await page.screenshot({ path: join(directory, "demonstration-large-text.png"), fullPage: true });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "";
        });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(demonstration + "/records?type=TSK");
        await page.locator('.task-tree .task-tree [data-record-id="demo:TSK-A"]').waitFor();
        await page.locator('.task-tree .task-tree [data-record-id="demo:TSK-6"]').waitFor();
        await page.locator('details[data-task-branch="demo:TSK-9"] > summary').click();
        assert.equal(await page.locator('.task-tree .task-tree [data-record-id="demo:TSK-A"]').isVisible(), false);
        await page.waitForURL(
          (url) =>
            (JSON.parse(url.searchParams.get("task_windows") ?? "{}") as Record<string, unknown>)["demo:TSK-9"] ===
            false,
        );
        await page.reload();
        assert.equal(await page.locator('details[data-task-branch="demo:TSK-9"]').getAttribute("open"), null);
        await page.locator('details[data-task-branch="demo:TSK-9"] > summary').click();
        await page.locator('.task-tree .task-tree [data-record-id="demo:TSK-A"]').waitFor();
        await page.screenshot({ path: join(directory, "demonstration-tasks.png"), fullPage: true });
        await page.goto(demonstration + "/records/demo:TSK-9");
        await page.getByRole("heading", { name: "Questions and confirmed constraints", exact: true }).waitFor();
        await page.getByRole("button", { name: "Approve plan", exact: true }).waitFor();
        await page.goto(demonstration + "/plans");
        assert.equal(await page.locator('main [data-task-node="demo:TSK-2"]').count(), 0);
        await page.getByRole("link", { name: "Bookmark notes for later reading", exact: true }).waitFor();
        await page.locator('main [data-task-node="demo:TSK-9"] > .task-tree > [data-task-node="demo:TSK-A"]').waitFor();
        await page.goto(demonstration + "/work");
        for (const state of ["Implementing", "Blocked", "Awaiting implementation"])
          await page.getByText(state, { exact: true }).first().waitFor();
        await page.getByText("Waiting for demo:TSK-5 (Approved)", { exact: true }).waitFor();
        assert.equal(await page.locator('main [data-task-node="demo:TSK-2"]').count(), 0);
        await page.screenshot({ path: join(directory, "demonstration-task-queue.png"), fullPage: true });
        await page.goto(demonstration + "/reviews");
        const revisedTask = page
          .getByRole("region", { name: "Awaiting approval" })
          .locator('[data-task-node="demo:TSK-2"]');
        await revisedTask.getByText("demo:TSK-2", { exact: true }).waitFor();
        const outcome = page.locator('[data-task-group="task:demo:TSK-7"]');
        const rows = outcome.locator("[data-task-group-items] > [data-task-node]");
        const first = await rows.nth(0).boundingBox(),
          last = await rows.nth(1).boundingBox();
        assert(first && last && Math.abs(last.y - first.y - first.height) < 1, "Review rows stack without a gap");
        assert.deepEqual(
          await rows
            .locator("[data-record-id]")
            .evaluateAll((items) => items.map((item) => item.getAttribute("data-record-id"))),
          ["demo:ADR-1", "demo:TSK-7"],
        );
        await page.screenshot({ path: join(directory, "demonstration-review-groups.png"), fullPage: true });
        await outcome.getByRole("link", { name: "ADR-1: Offline search and previews", exact: true }).click();
        await page.getByRole("button", { name: "Confirm changes", exact: true }).click();
        await page.waitForURL((url) => url.origin === origin && url.pathname === "/demonstration/records/demo:TSK-7");
        const [acceptance] = await Promise.all([
          page.waitForResponse(
            (response) => response.request().method() === "POST" && response.url().endsWith("/actions/task-state"),
          ),
          page.getByRole("button", { name: "Accept outcome", exact: true }).click(),
        ]);
        assert.equal(acceptance.status(), 200, "Task outcome acceptance succeeds");
        await page.waitForURL(
          (url) =>
            url.origin === origin &&
            url.pathname === "/demonstration/reviews" &&
            url.searchParams.get("scope") === "demo",
        );
        assert.equal(await page.locator('[data-task-group="task:demo:TSK-7"]').count(), 0);
        await page.goto(demonstration + "/records/demo:TSK-7");
        await page.locator(".record-metadata").getByText("Accepted", { exact: true }).waitFor();
        await page.goto(demonstration + "/records?type=ADR");
        const card = page.locator('[data-record-id="demo:ADR-0"]');
        const paragraph = card.locator("p").first();
        const bounds = await paragraph.boundingBox();
        if (!bounds) throw new Error("Missing demonstration card summary");
        const listing = page.url();
        assert.equal(await card.getByRole("link", { name: "demo:ADR-0: Needs review", exact: true }).count(), 1);
        await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + Math.min(180, bounds.width - 2), bounds.y + bounds.height / 2, { steps: 12 });
        await page.mouse.up();
        assert((await page.evaluate(() => globalThis.getSelection()?.toString().length ?? 0)) > 0);
        assert.equal(page.url(), listing);
        await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
        await card.click({ position: { x: 8, y: 8 } });
        await page.locator("h1").filter({ hasText: "ADR-0" }).waitFor();
        await page.goto(demonstration + "/reviews");
        const queueLinks = page
          .getByRole("region", { name: "Awaiting acceptance" })
          .locator("article.record-row a[data-card-link]");
        const paths = await queueLinks.evaluateAll((links) =>
          links.map((link) => link.closest("[data-record-id]")?.getAttribute("data-record-id")),
        );
        assert.deepEqual(paths, ["demo:ADR-0", "demo:EXP-0"]);
        await page.goto(demonstration + "/records/demo:EXP-0");
        const evidence = await page.getByRole("link", { name: /observation\.txt/ }).boundingBox(),
          decision = await page.getByRole("link", { name: "Review outcome", exact: true }).boundingBox();
        assert(evidence && decision && evidence.y < decision.y, "Experiment supporting files precede outcome review");
        await page.goto(demonstration + "/reviews");
        await page.getByRole("link", { name: "EXP-0: Warm index versus scanning notes", exact: true }).click();
        assert.equal(await page.locator("form[data-review]").count(), 1);
        await page.getByRole("heading", { name: "Supporting files", exact: true }).waitFor();
        const supportingFile = page.locator('[data-review-file$="/observation.txt"]'),
          supportingPanel = page.locator("details").filter({ has: supportingFile });
        assert.equal(await supportingPanel.getAttribute("open"), null);
        await supportingPanel.locator(":scope > summary").click();
        assert.match(await supportingFile.innerText(), /edited-note query/);
        await page.screenshot({ path: join(directory, "demonstration-experiment-review.png"), fullPage: true });
        await page.goto(demonstration + "/records?type=ADR");
        await page.getByRole("link", { name: "demo:ADR-0: Needs review", exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.has("review_source"), false);
        assert.equal(await page.getByRole("link", { name: "Review staged contents", exact: true }).count(), 0);
        assert.equal(await page.getByRole("link", { name: /Switch to/ }).count(), 0);
        await page.getByRole("button", { name: "Confirm changes", exact: true }).click();
        await page.locator("h1").filter({ hasText: "EXP-0" }).waitFor();
        await page.goto(demonstration + "/records?type=ADR");
        assert.equal(await page.getByRole("link", { name: "demo:ADR-0: Needs review", exact: true }).count(), 0);
        await page.goto(demonstration + "/collections");
        await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
        await page.getByRole("button", { name: "Accept all", exact: true }).waitFor({ timeout: 30000 });
        await page.screenshot({ path: join(directory, "demonstration-collection.png"), fullPage: true });
        await page.locator(".project-switch").click();
        await page.waitForURL(origin + "/projects");
        await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
        assert.equal(await page.locator(".project-switch .badge").count(), 0);
      },
    },
  ];
}
