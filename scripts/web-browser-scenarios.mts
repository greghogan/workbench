export const BrowserScenario = {
  Accessibility: "Automated accessibility evidence",
  Projects: "Projects dashboard, cache inventory, and accessible reference previews",
  Search: "Search and ADR differences",
  Paragraphs: "Paragraph differences ignore soft wrapping",
  Reviews: "Drafts and record review",
  Collections: "Collection preview and adaptations",
  Compatibility: "Policy incompatibility proposals in the unified review queue",
  Metadata: "Bibliographic and record metadata",
  Citations: "Retained citation PDFs",
  Tasks: "Human task decisions and local execution queue",
  Windows: "Incremental record windows",
  Live: "Live updates and focus",
  Responsive: "Narrow windows and accessibility preferences",
  Sources: "Nested project names, source hierarchy, and global search",
  Demonstration: "Isolated demonstration and bundled collection preview",
} as const;
import { accessibilityEvidence } from "./web-accessibility.mjs";
import type { Browser, Page } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
        await page.goto(base + "/record?id=demo:ADR-0");
        await page.getByText("Working-only phrase.", { exact: true }).waitFor();
        await page.getByRole("link", { name: "Changes", exact: true }).click();
        await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
        assert(await page.locator(".document-diff.split").count());
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
          assert.equal(comparison.searchParams.get("id"), "demo:ADR-0");
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
          const complete = baseline + "\n" + contextParagraphs.join("\n\n") + "\n";
          writeFileSync(adr, complete);
          git(root, "add", "workbench/decisions/ADR-00.md");
          git(root, "commit", "-qm", "Long document comparison fixture");
          writeFileSync(adr, complete.replace("paragraph 20 stays", "paragraph 20 remains"));
          for (const layout of ["unified", "split"]) {
            await page.goto(base + "/review?id=demo:ADR-0&layout=" + layout);
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
            assert.equal(await comparison.locator("del").innerText(), "stays");
            assert.equal(await comparison.locator("ins").innerText(), "remains");
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
          .getByRole("navigation", { name: "Difference layout" })
          .locator('a[aria-current="page"]')
          .filter({ hasText: "Unified" })
          .waitFor();
        assert.equal(await page.getByRole("navigation", { name: "Reviewed file views" }).count(), 0);
        await page.screenshot({ path: join(directory, "review-default-changes-desktop.png"), fullPage: true });
        await page.getByRole("link", { name: "Side-by-side", exact: true }).click();
        await page.locator(".document-diff.split").waitFor();
        assert.match(
          (await page.locator('[data-diff-side="before"] .document').allInnerTexts()).join(" "),
          /Keep project documents in plain files/,
        );
        assert.match(
          (await page.locator('[data-diff-side="after"] .document').allInnerTexts()).join(" "),
          /Saved browser draft/,
        );
        assert.equal(await page.locator("form[data-review]").count(), 1);
        const nextReview = await page
          .getByRole("navigation", { name: "Review queue navigation" })
          .locator('a[rel="next"]')
          .getAttribute("href");
        if (!nextReview) throw new Error("Expected the next protected record");
        await page.getByRole("button", { name: "Confirm review", exact: true }).click();
        await page.waitForURL(new URL(nextReview, base).href);
        assert.equal(new URL(page.url()).searchParams.get("layout"), "split");
        assert.equal(new URL(page.url()).searchParams.has("review_source"), false);
        const receipt = JSON.parse(readFileSync(join(root, ".git/workbench/review.json"), "utf8")) as {
          changes: unknown[];
        };
        assert.equal(receipt.changes.length, 1);
        await page.goto(base + "/record?id=demo:ADR-0&view=changes");
        assert.equal(await page.getByRole("link", { name: "Compare with committed HEAD", exact: true }).count(), 0);
        await page.locator(".document-diff").waitFor();
        assert.equal(await page.locator(".document-diff ins,.document-diff del").count(), 0);
        writeFileSync(adr, edited + "\nAfter the last review.\n");
        await page.locator(".document-diff p ins").filter({ hasText: "After the last review." }).waitFor();
        assert.equal(await page.locator(".document-diff p del").count(), 0);
        await page.screenshot({ path: join(directory, "since-last-review-desktop.png"), fullPage: true });
        const shown = edited + "\nAfter the last review.\n";
        await page.goto(base + "/review?id=demo:ADR-0");
        const digest = await page.locator('form[data-review] input[name="digest"]').inputValue();
        writeFileSync(adr, shown + "\nA later edit on disk.\n");
        await page.getByText("File changed on disk. Reload to view the latest version.", { exact: true }).waitFor();
        assert.equal(await page.locator('form[data-review] input[name="digest"]').inputValue(), digest);
        assert.equal(await page.getByRole("button", { name: "Confirm review", exact: true }).isEnabled(), true);
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/actions/approve") &&
              response.status() === 200,
          ),
          page.getByRole("button", { name: "Confirm review", exact: true }).click(),
        ]);
        await page.locator(".document-diff p ins").filter({ hasText: "A later edit on disk." }).waitFor();
        writeFileSync(adr, shown + "\nA further edit for reload.\n");
        await page.getByRole("link", { name: "Reload", exact: true }).waitFor();
        await page.getByRole("link", { name: "Reload", exact: true }).click();
        await page.locator(".document-diff p ins").filter({ hasText: "A further edit for reload." }).waitFor();
        assert.equal(await page.locator('form[data-review] input[type="checkbox"]').count(), 0);
        const action = page.getByRole("button", { name: "Confirm review", exact: true });
        const bounds = await action.boundingBox(),
          formBounds = await page.locator("form[data-review]").boundingBox();
        assert(bounds && formBounds);
        assert(bounds.width < formBounds.width / 2);
        assert(Math.abs(bounds.x + bounds.width / 2 - (formBounds.x + formBounds.width / 2)) < 2);
        await page.goto(base + "/record?id=demo:TSK-0");
        assert.equal(await page.getByRole("link", { name: "Edit", exact: true }).count(), 0);
        const added = "workbench/decisions/ADR-01.md";
        const contents = "# ADR-1: New record\n\nRead the complete new record before approval.\n";
        writeFileSync(join(root, added), contents);
        await page.goto(base + "/review?path=" + encodeURIComponent(added));
        const views = page.getByRole("navigation", { name: "Reviewed file views" });
        assert.deepEqual(await views.getByRole("link").allTextContents(), ["Current"]);
        assert.equal(await views.locator('[aria-current="page"]').textContent(), "Current");
        await page.getByText("Read the complete new record before approval.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: "Raw", exact: true }).count(), 0);
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
        await page.getByRole("button", { name: "Apply proposal", exact: true }).click();
        await page.waitForURL(base + "/review?collection_applied=company", { timeout: 30000 });
        const applicationResult = page.getByLabel("Collection application result");
        await applicationResult.waitFor();
        assert.match(await applicationResult.innerText(), /Project context synchronized and validation passed\./);
        await page.locator('main a[data-card-link][href*="company%3AADR-0"]').waitFor();
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
        await page.getByRole("link", { name: "Compare with reviewed record", exact: true }).click();
        // The service keeps its last complete snapshot while the new Git baseline refreshes asynchronously.
        await page.waitForFunction(() => {
          const difference = document.querySelector(".document-diff");
          return difference !== null && difference.querySelector("ins, del") === null;
        });
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
        await page.getByText("Permit the host scheduler to wrap project build commands.", { exact: true }).waitFor();
        assert.equal(await page.locator('a[href*="hostrules%3AADR-0"]').count(), 1);
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
      name: BrowserScenario.Tasks,
      run: async () => {
        const path = join(root, "workbench/tasks/TSK-ZZ.md");
        writeFileSync(
          path,
          "---\nstatus: Planned\n---\n\n# TSK-ZZ: Deliver the task workflow\n\n## Overview\n\nReview the delivered behavior.\n\n## Details\n\n- [x] Check the browser workflow.\n",
        );
        await page.goto(base + "/record?id=demo:TSK-ZZ");
        assert.equal(await page.getByRole("checkbox", { name: "Approve plan", exact: true }).count(), 0);
        await page.getByRole("button", { name: "Approve plan", exact: true }).click();
        await page.getByRole("heading", { name: "Plans", exact: true }).waitFor();
        const work = page.getByRole("region", { name: "Work", exact: true });
        await work
          .locator("article")
          .filter({ has: page.getByRole("link", { name: /Deliver the task workflow/ }) })
          .getByRole("button", { name: "Add to local queue", exact: true })
          .click();
        await page.getByRole("button", { name: "Start task", exact: true }).click();
        await page
          .getByLabel("Verification and outcome", { exact: true })
          .fill("Verified the human approval and queue workflow in Chromium.");
        await page.getByRole("button", { name: "Report implemented", exact: true }).click();
        await page
          .getByRole("region", { name: "Outcomes", exact: true })
          .getByRole("link", { name: /Deliver the task workflow/ })
          .click();
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
        await page.goto(base + "/record?id=demo:ADR-0&view=changes&layout=split");
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
        await page.goto(base + "/review?id=demo:ADR-0&layout=split");
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
        await page.goto(base + "/record?id=demo:ADR-1");
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
        await page.goto(origin + "/projects");
        await page.getByRole("button", { name: "Open demonstration", exact: true }).click();
        await page.waitForURL(origin + "/");
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
        await page.goto(origin + "/records?type=TSK");
        assert.equal(await page.locator('.task-tree .task-tree [data-record-id="demo:TSK-A"]').count(), 0);
        await page.locator('details[data-task-branch="demo:TSK-9"] > summary').click();
        await page.locator('.task-tree .task-tree [data-record-id="demo:TSK-A"]').waitFor();
        await page.locator('details[data-task-branch="demo:TSK-8"] > summary').click();
        await page.locator('.task-tree .task-tree [data-record-id="demo:TSK-6"]').waitFor();
        await page.screenshot({ path: join(directory, "demonstration-tasks.png"), fullPage: true });
        await page.goto(origin + "/record?id=demo:TSK-9");
        await page.getByRole("heading", { name: "Questions and confirmed constraints", exact: true }).waitFor();
        await page.getByRole("button", { name: "Approve plan", exact: true }).waitFor();
        await page.goto(origin + "/queue");
        for (const state of ["Active", "Blocked", "Queued", "Implemented"])
          await page.getByText(state, { exact: true }).first().waitFor();
        await page.getByText("Waiting for demo:TSK-5 (Approved)", { exact: true }).waitFor();
        await page.screenshot({ path: join(directory, "demonstration-task-queue.png"), fullPage: true });
        await page.getByRole("link", { name: "Review outcome", exact: true }).click();
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/actions/task-state") &&
              response.status() === 200,
          ),
          page.getByRole("button", { name: "Accept outcome", exact: true }).click(),
        ]);
        await page.locator(".record-metadata").getByText("Accepted", { exact: true }).waitFor();
        await page.goto(origin + "/records?type=ADR");
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
        await page.waitForURL((url) => url.pathname === "/record" && url.searchParams.get("id") === "demo:ADR-0");
        await page.goto(origin + "/review");
        const queueLinks = page.locator("main article.record-row a[data-card-link]");
        const paths = await queueLinks.evaluateAll((links) =>
          links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get("id")),
        );
        assert.deepEqual(paths, ["demo:ADR-0", "demo:EXP-0", "demo:EXP-1"]);
        await page.getByRole("link", { name: "EXP-0: Warm index versus scanning notes", exact: true }).click();
        assert.equal(await page.locator("form[data-review]").count(), 1);
        await page.getByRole("heading", { name: "Supporting files", exact: true }).waitFor();
        assert.match(await page.locator('[data-review-file$="/observation.txt"]').innerText(), /edited-note query/);
        await page.screenshot({ path: join(directory, "demonstration-experiment-review.png"), fullPage: true });
        await page.goto(origin + "/records?type=ADR");
        await page.getByRole("link", { name: "demo:ADR-0: Needs review", exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.has("review_source"), false);
        assert.equal(await page.getByRole("link", { name: "Review staged contents", exact: true }).count(), 0);
        assert.equal(await page.getByRole("link", { name: /Switch to/ }).count(), 0);
        await page.getByRole("button", { name: "Confirm review", exact: true }).click();
        await page.waitForURL((url) => url.pathname === "/review" && url.searchParams.get("id") === "demo:EXP-0");
        await page.goto(origin + "/records?type=ADR");
        assert.equal(await page.getByRole("link", { name: "demo:ADR-0: Needs review", exact: true }).count(), 0);
        await page.goto(origin + "/collections");
        await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
        await page.getByRole("button", { name: "Apply proposal", exact: true }).waitFor({ timeout: 30000 });
        await page.screenshot({ path: join(directory, "demonstration-collection.png"), fullPage: true });
        await page.locator(".project-switch").click();
        await page.waitForURL(origin + "/projects");
        await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
        assert.equal(await page.locator(".project-switch .badge").count(), 0);
      },
    },
  ];
}
