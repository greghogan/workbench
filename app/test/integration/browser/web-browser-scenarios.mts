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
import type { Browser, Locator, Page } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { citationPdf, citationImage } from "../../../src/core/verification/document-fixtures.mjs";
import { join } from "node:path";
import { required } from "../../../src/core/runtime/values.mjs";
import assert from "node:assert/strict";
interface BrowserScenarioContext {
  distribution: string;
  page: Page;
  browser: Browser;
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
  const { page, browser, root, provider, commit, adr, staged, directory, base, git, workbench, distribution } = context;
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
          await page.locator(".diagram > .muted").waitFor();
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
          assert.equal(
            await page.locator(".diagram > .muted").textContent(),
            "Diagram could not be rendered; source is shown.",
          );
          assert.equal(
            await page
              .locator(".diagram-renderer")
              .evaluate((frame) => frame instanceof HTMLIFrameElement && frame.contentDocument === null),
            true,
            "The renderer cannot access the parent document",
          );
          await page.locator(".diagram details summary").first().click();
          assert.equal(await page.locator(".diagram details pre").first().textContent(), graph);
          await page.locator(".diagram details summary").first().click();
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
          const plain = await browser.newContext({ javaScriptEnabled: false });
          try {
            const fallback = await plain.newPage();
            await fallback.goto(base + "/records/demo:ADR-Z");
            assert.equal(await fallback.locator(".diagram code").first().textContent(), graph);
            assert.equal(await fallback.locator(".diagram-renderer").count(), 0);
          } finally {
            await plain.close();
          }
          git(root, "add", "workbench/decisions/ADR-0Z.md");
          git(root, "commit", "-qm", "Diagram fixture");
          writeFileSync(record, contents.replace("Toolchain artifact", "Prepared toolchain"));
          await page.goto(base + "/records/demo:ADR-Z/review?layout=unified");
          assert(
            (await page.locator(".document-diff pre").allTextContents()).some((text) =>
              text.includes("Prepared toolchain"),
            ),
            "Review retains changed diagram source",
          );
        } finally {
          await page.unroute("**/*");
        }
      },
    },
    {
      name: BrowserScenario.Performance,
      run: async () => {
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
                browser: browser.version(),
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
        await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
        assert.equal(await page.locator(".metric,.metrics").count(), 0);
        assert.equal(await page.locator('.sidebar a[href="/projects"]').count(), 0);
        assert.equal(await page.locator("[data-preview-error]").count(), 0);
        const summary = page.locator('[data-record-id="demo:CHARTER"] p').first();
        assert.equal(await summary.locator("xpath=ancestor::a").count(), 0);
        await page.getByRole("link", { name: /Switch project/ }).click();
        await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
        await page.goto(base);
        await page.screenshot({ path: join(directory, "overview-desktop.png"), fullPage: true });
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
          assert.deepEqual(await crumbs.getByRole("link").allTextContents(), ["demo", "Review queue"]);
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
        const coldContext = await browser.newContext({ javaScriptEnabled: false });
        try {
          const cold = await coldContext.newPage();
          const response = await cold.goto(base + "/records/demo:ADR-0/review?layout=unified");
          assert.equal(response?.status(), 200);
          await cold.getByRole("button", { name: "Review file", exact: true }).waitFor();
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
        const bounds = await action.boundingBox(),
          formBounds = await page.locator("form[data-review]").boundingBox();
        assert(bounds && formBounds);
        assert(bounds.width < formBounds.width / 2);
        assert(Math.abs(bounds.x + bounds.width / 2 - (formBounds.x + formBounds.width / 2)) < 2);
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
        git(root, "add", ".");
        git(root, "commit", "-qm", "Retained policy updates\n\nWorkbench-Provisional: true");
        const revision = git(root, "rev-parse", "HEAD");
        await page.goto(base + "/review");
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
            title = await unit.locator("h2").boundingBox(),
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
        await page.waitForURL(base + "/review?collection_applied=company", { timeout: 30000 });
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
        await page.goto(base + "/review");
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
        await page.goto(base + "/review");
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
          assert.equal(await buttons.count(), 3);
          const boxes = await Promise.all((await buttons.all()).map((button) => button.boundingBox())),
            [up, remove, down] = boxes,
            bounds = await pane.boundingBox();
          assert(up && remove && down && bounds);
          assert(Math.abs(up.y - bounds.y) <= 1, "Move up aligns with the pane's top");
          assert(
            Math.abs(down.y + down.height - bounds.y - bounds.height) <= 1,
            "Move down aligns with the pane's bottom",
          );
          assert(
            Math.abs(remove.y + remove.height / 2 - bounds.y - bounds.height / 2) <= 1,
            "Remove is centered beside the pane",
          );
          assert(
            boxes.every((box) => box && Math.abs(box.width - up.width) <= 1),
            "Queue buttons have equal widths",
          );
          assert(up.x + up.width <= bounds.x, "Controls stay beside their task");
          return bounds.height;
        };
        const path = join(root, "workbench/tasks/TSK-ZZ.md");
        writeFileSync(
          path,
          "---\nstatus: Planned\n---\n\n# TSK-ZZ: Deliver the task workflow\n\n## Overview\n\nReview the delivered behavior.\n\n## Details\n\n- [x] Check the browser workflow.\n",
        );
        await page.goto(base + "/records/demo:TSK-ZZ");
        assert.equal(await page.getByRole("checkbox", { name: "Approve plan", exact: true }).count(), 0);
        assert.equal(await page.locator('main textarea[name="reason"]').count(), 0);
        await page.getByText("More task actions", { exact: true }).click();
        assert.equal(await page.getByRole("link", { name: "Revert work", exact: true }).count(), 0);
        await page.getByRole("link", { name: "Cancel task", exact: true }).click();
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
        await page.getByRole("heading", { name: "Plans", exact: true }).waitFor();
        const work = page.getByRole("region", { name: "Work", exact: true });
        assert.equal(await page.getByRole("button", { name: "Start task", exact: true }).count(), 0);
        workbench("queue", "start", "demo:TSK-ZZ");
        await work.getByText("Active", { exact: true }).waitFor();
        writeFileSync(join(root, "task-delivery.ts"), 'export const outcome = "Initial browser result";\n');
        git(root, "add", "workbench/tasks/TSK-ZZ.md", "task-delivery.ts");
        git(root, "commit", "-qm", "Start the task workflow\n\nWorkbench-Provisional: true");
        writeFileSync(join(root, "task-delivery.ts"), 'export const outcome = "Verified in Chromium";\n');
        writeFileSync(
          path,
          readFileSync(path, "utf8") + "\n## Implementation account\n\nDelivered the browser workflow.\n",
        );
        git(root, "add", "workbench/tasks/TSK-ZZ.md", "task-delivery.ts");
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
        await page.reload();
        await page
          .getByRole("region", { name: "Outcomes", exact: true })
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
        await page.getByRole("link", { name: "task-delivery.ts", exact: true }).click();
        await page.getByText('export const outcome = "Verified in Chromium";', { exact: true }).waitFor();
        assert.match(await page.locator(".code-difference del").innerText(), /Initial browser result/);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            "Commit inspection fits the viewport",
          );
          await page.screenshot({ path: join(directory, `task-commit-${String(width)}.png`), fullPage: true });
        }
        await page
          .getByRole("navigation", { name: "Breadcrumb" })
          .getByRole("link", { name: /Deliver the task workflow/ })
          .click();
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
        await page.getByRole("heading", { name: "Outcomes", exact: true }).waitFor();
        assert.match(readFileSync(path, "utf8"), /status: Accepted/);
        assert.equal(
          await page
            .getByRole("region", { name: "Outcomes", exact: true })
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
        await page.goto(base + "/queue");
        await page.getByRole("link", { name: "Disposable browser plan", exact: true }).click();
        await page.getByRole("heading", { name: "Disposable browser plan", exact: true }).waitFor();
        assert.deepEqual(await page.locator("main .task-actions").locator("a, button").allTextContents(), [
          "Approve plan",
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
          }
          await page.goto(base + "/queue");
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
        }
        await page.getByText("Plan actions", { exact: true }).click();
        await page.getByRole("link", { name: "Cancel plan", exact: true }).click();
        await page.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
        await page.getByText("Plan actions", { exact: true }).click();
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
        await page.goto(base + "/queue");
        for (const [id, title] of [
          ["V", "Prepare data"],
          ["W", "Build the report"],
          ["X", "Publish the report"],
        ] as const) {
          await work
            .locator("article")
            .filter({ has: page.getByRole("link", { name: new RegExp(`${title}$`) }) })
            .getByRole("button", { name: "Add to local queue", exact: true })
            .click();
          await page.locator(`.task-queue > [data-task-node="demo:TSK-${id}"]`).waitFor();
        }
        const queued = page.locator(".task-queue > [data-task-node]");
        await queued.nth(2).waitFor();
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const [index, row] of (await queued.all()).entries()) {
            const controls = row.getByRole("group"),
              buttons = controls.getByRole("button");
            await alignedControls(row, row.locator(".task-queue-content"));
            assert.equal(await buttons.count(), 3);
            assert.equal(await buttons.nth(0).isDisabled(), index === 0);
            assert.equal(await buttons.nth(1).isDisabled(), false);
            assert.equal(await buttons.nth(2).isDisabled(), index === 2);
            assert.match((await buttons.nth(0).getAttribute("aria-label")) ?? "", /^Move up:/);
            assert.match((await buttons.nth(1).getAttribute("aria-label")) ?? "", /^Remove from queue:/);
            assert.match((await buttons.nth(2).getAttribute("aria-label")) ?? "", /^Move down:/);
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
        await page.getByRole("button", { name: "Remove from queue: Prepare data", exact: true }).click();
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
        await page.getByText("120 matching record(s).", { exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 100);
        await page.evaluate(() => {
          globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight);
        });
        await page.getByRole("heading", { name: "TSK-0: Inspect the interface", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 120);
        const manual = await browser.newPage();
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
        assert.equal(await manual.locator("#record-list [data-record-id]").count(), 120);
        await manual.close();
        await page.goto(base + "/records?type=TSK");
        assert.equal(await page.locator("[data-task-node]").count(), 100);
        await page.evaluate(() => {
          globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight);
        });
        await page.getByRole("heading", { name: "TSK-3B: Task 119", exact: true }).waitFor();
        assert.equal(await page.locator("[data-task-node]").count(), 120);
        assert.equal(new URL(page.url()).searchParams.get("through"), "demo:TSK-3B");
        for (let number = 120; number < 500; number++)
          writeFileSync(
            join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`),
            `---\nstatus: Planned\n---\n\n# TSK-${number.toString(36).toUpperCase()}: Task ${String(number)}\n`,
          );
        await page.goto(base + "/records?type=TSK&status=Planned");
        await page.getByText("500 matching record(s).", { exact: true }).waitFor();
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
        await page.goto(base + "/records?type=TSK&status=Planned&after=demo:TSK-B4&through=demo:TSK-2S");
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
      },
    },
    {
      name: BrowserScenario.Responsive,
      run: async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(base);
        await page.screenshot({ path: join(directory, "overview-mobile.png"), fullPage: true });
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
        const columns = Array.from({ length: 20 }, (_, index) => "Column " + String(index));
        writeFileSync(
          join(root, "workbench/decisions/ADR-01.md"),
          "---\nsummary: A wide table.\n---\n\n# ADR-1: Wide table\n\n| " +
            columns.join(" | ") +
            " |\n| " +
            columns.map(() => "---").join(" | ") +
            " |\n| " +
            columns.join(" | ") +
            " |\n",
        );
        await page.goto(base + "/records/demo:ADR-1");
        const table = page.getByRole("region", { name: "Document table", exact: true });
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
        await page.goto(base + "/review");
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
            `---\nstatus: Planned\n---\n\n# ${id ?? ""} nested discovery token\n`,
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
        await page.getByLabel("Search project records").fill("nested discovery token");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: "graphmp nested discovery token", exact: true }).waitFor();
        await page.getByRole("heading", { name: "solver nested discovery token", exact: true }).waitFor();
        await page
          .getByRole("navigation", { name: "Record sources" })
          .getByRole("link", { name: "GraphMP", exact: true })
          .click();
        await page.screenshot({ path: join(directory, "source-hierarchy-desktop.png"), fullPage: true });
        assert(!(await page.getByRole("navigation", { name: "Record sources" }).innerText()).includes("packages"));
        await breadcrumbs.getByRole("link", { name: "GraphAI", exact: true }).click();
        await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get("scope"), "demo");
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
        await page.goto(demonstration + "/queue");
        await page
          .locator('[aria-label="Plans"] [data-task-node="demo:TSK-9"] > .task-tree > [data-task-node="demo:TSK-A"]')
          .waitFor();
        for (const state of ["Active", "Blocked", "Queued"])
          await page.getByText(state, { exact: true }).first().waitFor();
        await page.getByText("Waiting for demo:TSK-5 (Approved)", { exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "demonstration-task-queue.png"), fullPage: true });
        const outcomes = page.getByRole("region", { name: "Outcomes", exact: true });
        await outcomes.locator('[data-record-id="demo:TSK-7"] a[data-card-link]').click();
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/actions/task-state") &&
              response.status() === 200,
          ),
          page.getByRole("button", { name: "Accept outcome", exact: true }).click(),
        ]);
        await page.waitForURL(
          (url) =>
            url.origin === origin &&
            url.pathname === "/demonstration/queue" &&
            url.searchParams.get("scope") === "demo",
        );
        assert.equal(await page.locator('[aria-label="Outcomes"] [data-record-id="demo:TSK-7"]').count(), 0);
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
        await page.goto(demonstration + "/review");
        const queueLinks = page.locator("main article.record-row a[data-card-link]");
        const paths = await queueLinks.evaluateAll((links) =>
          links.map((link) => link.closest("[data-record-id]")?.getAttribute("data-record-id")),
        );
        assert.deepEqual(paths, ["demo:ADR-0", "demo:EXP-0", "demo:EXP-1"]);
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
