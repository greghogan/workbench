export const BrowserScenario = {
  Accessibility: "Automated accessibility evidence",
  Projects: "Projects dashboard, cache inventory, and accessible reference previews",
  Search: "Search and ADR differences",
  Paragraphs: "Paragraph differences ignore soft wrapping",
  Reviews: "Drafts and staged review",
  Collections: "Collection preview and adaptations",
  Metadata: "Bibliographic and record metadata",
  Citations: "Retained citation PDFs",
  Windows: "Incremental record windows",
  Live: "Live updates and focus",
  Responsive: "Narrow windows and accessibility preferences",
  Sources: "Nested project names, source hierarchy, and global search",
  Demonstration: "Isolated demonstration and bundled collection preview",
} as const;
import { accessibilityEvidence } from "./web-accessibility.mjs";
import type { Browser, Page } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { citationPdf } from "./web-browser-fixtures.mjs";
import { join } from "node:path";
import assert from "node:assert/strict";
interface BrowserScenarioContext {
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
}
export function webBrowserScenarios(context: BrowserScenarioContext): { name: string; run: () => Promise<void> }[] {
  const { page, browser, root, provider, commit, adr, staged, directory, base, git } = context;
  return [
    { name: BrowserScenario.Accessibility, run: async () => accessibilityEvidence(page, base, directory) },
    {
      name: BrowserScenario.Projects,
      run: async () => {
        const origin = new URL(base).origin;
        await page.goto(origin + "/projects");
        await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "projects-desktop.png"), fullPage: true });
        await page.goto(origin + "/caches");
        await page.getByRole("heading", { name: "Shared tool installations", exact: true }).waitFor();
        await page.goto(base + "/record?id=demo:TSK-0");
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
        await page.getByLabel("Search all records").fill("distinctive search phrase");
        await page.getByLabel("Record type", { exact: true }).selectOption("TSK");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: "TSK-0: Inspect the interface", exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get("type"), "TSK");
        assert.equal(await page.locator('main input[name="q"],main select[name="type"]').count(), 0);
        assert.equal(await page.getByLabel("Search all records").inputValue(), "distinctive search phrase");
        await page.getByLabel("Record type", { exact: true }).selectOption("ADR");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByText("No matching records.", { exact: true }).waitFor();
        await page.getByLabel("Record type", { exact: true }).selectOption("");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("heading", { name: "TSK-0: Inspect the interface", exact: true }).waitFor();
        await page.goto(base + "/record?id=demo:ADR-0");
        await page.getByText("Working-only phrase.", { exact: true }).waitFor();
        await page.getByRole("link", { name: "Changes", exact: true }).click();
        await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
        assert(await page.locator(".diff.split").count());
        await page.screenshot({ path: join(directory, "adr-diff-desktop.png"), fullPage: true });
      },
    },
    {
      name: BrowserScenario.Paragraphs,
      run: async () => {
        const original = readFileSync(adr, "utf8"),
          baseline = git(root, "show", "HEAD:workbench/decisions/ADR-00.md") + "\n";
        const rewrite = JSON.parse(
          readFileSync(new URL("../tests/fixtures/paragraph-diff.json", import.meta.url), "utf8"),
        ) as { before: string; after: string };
        try {
          writeFileSync(
            adr,
            baseline.replace("Keep project documents in plain files.", "Keep project documents\nin plain files."),
          );
          await page.goto(base + "/record?id=demo:ADR-0&view=changes");
          await page.getByText(/Only paragraph wrapping or formatting changed/).waitFor({ timeout: 10000 });
          assert.equal(
            await page.locator(".paragraph-diff .diff-content ins, .paragraph-diff .diff-content del").count(),
            0,
          );
          writeFileSync(
            adr,
            baseline.replace("Keep project documents in plain files.", "Store project documents\nin plain files."),
          );
          await page.locator(".diff-content ins").filter({ hasText: "Store" }).waitFor({ timeout: 10000 });
          assert.equal(await page.locator(".diff-content del").count(), 1);
          assert.equal(await page.locator(".diff-content ins").count(), 1);
          assert.equal(
            await page
              .locator(".paragraph-diff")
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
          await page.goto(base + "/review?path=workbench%2Fdecisions%2FADR-00.md&review_source=working&view=changes");
          await page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin });
          const paragraph = page.locator(".diff-content").first();
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
          assert.equal(comparison.searchParams.get("review_source"), "working");
          assert.equal(comparison.searchParams.has("baseline"), false);
          assert.equal(comparison.searchParams.get("path"), "workbench/decisions/ADR-00.md");
          await page.getByRole("link", { name: "Raw", exact: true }).click();
          assert.equal(
            await page.locator("pre.source").textContent(),
            baseline.replace("Keep project documents in plain files.", rewrite.after.trim()),
          );
        } finally {
          writeFileSync(adr, original);
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
      },
    },
    {
      name: BrowserScenario.Reviews,
      run: async () => {
        await page.goto(base + "/record?id=demo:ADR-0&view=edit");
        await page.getByLabel("ADR source").fill("Unsaved browser draft <retained>");
        writeFileSync(adr, staged + "\nExternal concurrent edit.\n");
        await page.locator("#live-status:not([hidden])").waitFor();
        assert.equal(await page.getByLabel("ADR source").inputValue(), "Unsaved browser draft <retained>");
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await page.getByText(/file changed since this editor opened/).waitFor();
        assert.equal(await page.getByLabel("ADR source").inputValue(), "Unsaved browser draft <retained>");
        await page.screenshot({ path: join(directory, "stale-editor-desktop.png"), fullPage: true });
        await page.goto(base + "/record?id=demo:ADR-0&view=edit");
        const edited = staged + "\nSaved browser draft.\n";
        await page.getByLabel("ADR source").fill(edited);
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await page.waitForURL(/saved=1/);
        assert.equal(readFileSync(adr, "utf8"), edited);
        assert.equal(git(root, "show", ":workbench/decisions/ADR-00.md"), staged.trim());
        await page.goto(base + "/review?path=workbench/decisions/ADR-00.md");
        await page
          .getByRole("navigation", { name: "Reviewed file views" })
          .locator('a[aria-current="page"]')
          .filter({ hasText: "Changes" })
          .waitFor();
        await page.screenshot({ path: join(directory, "review-default-changes-desktop.png"), fullPage: true });
        await page.getByRole("link", { name: "Read", exact: true }).click();
        await page.getByText("Staged exact phrase.", { exact: true }).waitFor();
        assert.equal(await page.getByText("Saved browser draft.", { exact: true }).count(), 0);
        await page.getByRole("link", { name: "Changes", exact: true }).click();
        await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
        await page.locator(".diff.split").waitFor();
        await page.getByRole("checkbox", { name: "I have reviewed this exact staged file." }).check();
        await page.getByRole("button", { name: "Confirm review", exact: true }).click();
        await page.waitForURL(
          (url) =>
            url.pathname === new URL(base).pathname + "/review" &&
            url.searchParams.get("path") === "workbench/decisions/ADR-00.md" &&
            url.searchParams.get("review_source") === "working",
        );
        assert.equal(new URL(page.url()).searchParams.get("layout"), "split");
        assert.equal(
          await page
            .getByRole("navigation", { name: "Review queue navigation" })
            .getByRole("link", { name: "← Previous", exact: true })
            .count(),
          1,
        );
        const receipt = JSON.parse(readFileSync(join(root, ".git/workbench/review.json"), "utf8")) as {
          changes: unknown[];
        };
        assert.equal(receipt.changes.length, 1);
        await page.goto(base + "/review?path=workbench/decisions/ADR-00.md&review_source=working");
        await page.getByRole("link", { name: "Read", exact: true }).click();
        await page.getByText("Saved browser draft.", { exact: true }).waitFor();
        const nextReview = await page
          .getByRole("navigation", { name: "Review queue navigation" })
          .locator('a[rel="next"]')
          .getAttribute("href");
        if (!nextReview) throw new Error("Expected the next protected fixture after the working ADR");
        await page.getByRole("checkbox", { name: "I have reviewed this exact working file." }).check();
        await page.getByRole("button", { name: "Confirm review", exact: true }).click();
        await page.waitForURL(new URL(nextReview, base).href);
        await page.goto(base + "/record?id=demo:ADR-0&view=changes");
        await page.getByText(/Last reviewed/).waitFor();
        await page.getByText("No source differences.", { exact: true }).waitFor();
        writeFileSync(adr, edited + "\nAfter the last review.\n");
        await page.locator(".diff-content ins").filter({ hasText: "After the last review." }).waitFor();
        assert.equal(await page.locator(".diff-content del").count(), 0);
        await page.screenshot({ path: join(directory, "since-last-review-desktop.png"), fullPage: true });
        await page.goto(base + "/record?id=demo:TSK-0");
        assert.equal(await page.getByRole("link", { name: "Edit", exact: true }).count(), 0);
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
        await page
          .getByRole("checkbox", { name: "I have reviewed this exact proposal and approve applying it." })
          .check();
        await page.getByRole("button", { name: "Apply reviewed proposal", exact: true }).click();
        await page.waitForURL(base + "/collections", { timeout: 30000 });
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
        await page.goto(base + "/record?id=company:ADR-0&view=changes");
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
        await page.getByRole("link", { name: "Compare with committed HEAD", exact: true }).click();
        await page.getByText("No source differences.", { exact: true }).waitFor();
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
      name: BrowserScenario.Metadata,
      run: async () => {
        await page.goto(base + "/record?id=demo:CIT-0");
        await page.getByRole("heading", { name: "Authors", exact: true }).waitFor();
        await page.getByText("Ada Lovelace", { exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "citation-desktop.png"), fullPage: true });
        await page.goto(base + "/record?id=demo:ADR-0");
        await page.getByRole("heading", { name: "Summary", exact: true }).waitFor();
        await page.getByRole("heading", { name: "Agent instructions", exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "decision-metadata-desktop.png"), fullPage: true });
      },
    },
    {
      name: BrowserScenario.Citations,
      run: async () => {
        const pdf = citationPdf();
        appendFileSync(join(root, "workbench/config.toml"), '\n[citations]\nlibrary_dir="library/citations"\n');
        mkdirSync(join(root, "workbench/citations/CIT-00"), { recursive: true });
        mkdirSync(join(root, "library/citations"), { recursive: true });
        writeFileSync(
          join(root, "workbench/citations/CIT-00/acquisition.yaml"),
          `sources:\n  - kind: published\n    status: acquired\n    landing-url: https://example.invalid/paper\n    sha256: ${createHash("sha256").update(pdf).digest("hex")}\n  - kind: arxiv\n    status: pending\n    landing-url: https://example.invalid/preprint\n`,
        );
        const path = join(root, "library/citations/CIT-00-published.pdf");
        writeFileSync(path, pdf);
        await page.goto(base + "/record?id=demo:CIT-0");
        await page.getByText("File present locally", { exact: true }).waitFor();
        await page.getByText("File missing locally", { exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "citation-documents-desktop.png"), fullPage: true });
        const viewLink = page.getByRole("link", { name: "View PDF", exact: true });
        const downloadLink = page.getByRole("link", { name: "Download PDF", exact: true });
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
        assert.equal(await page.getByRole("link", { name: "View PDF", exact: true }).count(), 0);
      },
    },
    {
      name: BrowserScenario.Windows,
      run: async () => {
        for (let number = 1; number < 120; number++)
          writeFileSync(
            join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`),
            `---\nstatus: Planned\n---\n\n# Task ${String(number)}\n`,
          );
        await page.goto(base + "/records?type=TSK");
        await page.getByText("120 matching record(s).", { exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 100);
        await page.locator("[data-load-more]").scrollIntoViewIfNeeded();
        await page.getByRole("heading", { name: "Task 119", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 120);
        const manual = await browser.newPage();
        await manual.addInitScript(() => {
          Object.defineProperty(globalThis, "IntersectionObserver", { value: undefined, configurable: true });
        });
        await manual.goto(base + "/records?type=TSK");
        await manual.getByRole("link", { name: "Load more", exact: true }).click();
        await manual.getByRole("heading", { name: "Task 119", exact: true }).waitFor();
        const taskZero = join(root, "workbench/tasks/TSK-00.md");
        writeFileSync(
          taskZero,
          readFileSync(taskZero, "utf8").replace("TSK-0: Inspect the interface", "Refreshed expanded result"),
        );
        await manual.getByRole("heading", { name: "Refreshed expanded result", exact: true }).waitFor();
        assert.equal(await manual.locator("#record-list [data-record-id]").count(), 120);
        await manual.close();
        for (let number = 120; number < 500; number++)
          writeFileSync(
            join(root, `workbench/tasks/TSK-${number.toString(36).toUpperCase().padStart(2, "0")}.md`),
            `---\nstatus: Planned\n---\n\n# Task ${String(number)}\n`,
          );
        await page.goto(base + "/records?type=TSK");
        await page.getByText("500 matching record(s).", { exact: true }).waitFor();
        for (const end of [199, 299, 399]) {
          await page.getByRole("link", { name: "Load more", exact: true }).scrollIntoViewIfNeeded();
          await page.getByRole("heading", { name: `Task ${String(end)}`, exact: true }).waitFor();
        }
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        const first = page.locator("#record-list [data-record-id]").first();
        await first.focus();
        await page.getByRole("link", { name: "Load more", exact: true }).scrollIntoViewIfNeeded();
        await page
          .getByText("Automatic loading paused to preserve keyboard focus. Use Load more to continue.", { exact: true })
          .waitFor();
        assert.equal(await page.locator(":focus").getAttribute("data-record-id"), "demo:TSK-2S");
        await page.getByRole("link", { name: "Load more", exact: true }).click();
        await page.getByRole("heading", { name: "Task 499", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        await page.reload();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        await page.locator("#record-list [data-record-id]").last().getByRole("link").click();
        await page.getByRole("heading", { name: "Task 499", exact: true }).waitFor();
        await page.goBack();
        await page.getByRole("heading", { name: "Task 499", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 300);
        await page.getByRole("link", { name: "Load previous records", exact: true }).click();
        await page.getByRole("heading", { name: "Task 199", exact: true }).waitFor();
        assert.equal(await page.locator("#record-list [data-record-id]").count(), 100);
      },
    },
    {
      name: BrowserScenario.Live,
      run: async () => {
        await page.goto(base + "/record?id=demo:TSK-0");
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
        await page.getByLabel("Search all records").fill("Source document");
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
        await page.goto(base + "/record?id=demo:ADR-0&view=changes&layout=split");
        await page.screenshot({ path: join(directory, "adr-diff-mobile.png"), fullPage: true });
        assert(
          await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
          "Mobile diff overflows",
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
        await page.goto(base + "/record?id=demo:CIT-0");
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
        await sources.getByRole("link", { name: "All sources", exact: true }).waitFor();
        await page.getByLabel("Search all records").fill("nested discovery token");
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
        await page.goto(origin + "/projects");
        await page.getByRole("button", { name: "Open demonstration", exact: true }).click();
        await page.waitForURL(origin + "/");
        await page.getByText("Demonstration", { exact: true }).waitFor();
        assert.equal((await page.request.get(origin + "/projects")).status(), 404);
        await page.goto(origin + "/collections");
        await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
        await page.getByRole("button", { name: "Apply reviewed proposal", exact: true }).waitFor({ timeout: 30000 });
        await page.screenshot({ path: join(directory, "demonstration-collection.png"), fullPage: true });
      },
    },
  ];
}
