import { criterionEvidence } from "./accessibility-criteria.mjs";
import axe from "axe-core";
import type { AxeResults } from "axe-core";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";

/** Automated evidence is scoped to tested states; incomplete rules remain visible for assessment. */
export async function accessibilityEvidence(page: Page, base: string, directory: string): Promise<void> {
  const scans: { state: string; url: string; results: AxeResults }[] = [];
  let complete = false;
  const scan = async (state: string) => {
    await page.evaluate(axe.source);
    const results = await page.evaluate<AxeResults>(
      'axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } })',
    );
    scans.push({ state, url: page.url(), results });
  };
  try {
    for (const [state, location] of [
      ["projects", new URL("/projects", base).href],
      ["cache", new URL("/caches", base).href],
      ["overview", base],
      ["records", base + "/records"],
      ["current-tasks", base + "/records?type=TSK"],
      ["task-queue", base + "/queue"],
      ["task-state", base + "/records?type=TSK&status=Planned"],
      ["search", base + "/records?q=files&type=ADR"],
      ["record", base + "/record?id=demo:ADR-0"],
      ["edit", base + "/record?id=demo:ADR-0&view=edit"],
      ["inline-diff", base + "/record?id=demo:ADR-0&view=changes"],
      ["split-diff", base + "/record?id=demo:ADR-0&view=changes&layout=split"],
      ["citation", base + "/record?id=demo:CIT-0"],
      ["charter", base + "/record?id=demo:CHARTER"],
      ["task", base + "/record?id=demo:TSK-0"],
      ["experiment", base + "/record?id=demo:EXP-0"],
      ["environment", base + "/record?id=demo:ENV-0"],
      ["release", base + "/record?id=demo:REL-0"],
      ["review-queue", base + "/review"],
      ["review", base + "/review?path=workbench/decisions/ADR-00.md"],
      ["collections", base + "/collections"],
    ] as const) {
      await page.goto(location);
      await scan(state);
    }
    await page.goto(base + "/record?id=demo:TSK-0");
    await page.getByRole("link", { name: "the governing decision", exact: true }).focus();
    await page.getByRole("tooltip").waitFor();
    await scan("reference-tooltip");
    await page.keyboard.press("Escape");
    await page.goto(base);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").textContent(), "Skip to content");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(":focus").getAttribute("id"), "main");
    await page.setViewportSize({ width: 720, height: 1000 });
    const textSizes = () =>
      page.locator("body,h1,h2,p,a,button,input,select,textarea,span,code").evaluateAll((elements) =>
        elements.map((element) => ({
          tag: element.tagName,
          size: Number.parseFloat(getComputedStyle(element).fontSize),
        })),
      );
    const originalSizes = await textSizes();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    const enlargedSizes = await textSizes();
    assert.equal(enlargedSizes.length, originalSizes.length, "Text resize must retain the displayed content");
    for (const [index, before] of originalSizes.entries())
      assert((enlargedSizes[index]?.size ?? 0) >= before.size * 2, `${before.tag} text did not actually double`);
    assert(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
      "Enlarged text overflows",
    );
    await scan("enlarged-text");
    await page.evaluate(() => {
      globalThis.document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 320, height: 844 });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "320 pixel reading view overflows",
    );
    await scan("narrow-reflow");
    await page.goto(base + "/review?id=demo:ADR-0&layout=split");
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "320 pixel split review overflows",
    );
    await scan("narrow-split-review");
    await page.screenshot({ path: join(directory, "reflow.png"), fullPage: true });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await scan("forced-colors-reduced-motion");
    complete = true;
  } finally {
    const distribution = new URL("../", import.meta.url);
    const metadata: unknown = JSON.parse(readFileSync(new URL("package.json", distribution), "utf8"));
    writeFileSync(
      join(directory, "accessibility.json"),
      JSON.stringify(
        {
          schema: 1,
          complete,
          collectedAt: new Date().toISOString(),
          package: metadata,
          releaseSha256: createHash("sha256")
            .update(readFileSync(new URL("bundle/main.cjs.br", distribution)))
            .digest("hex"),
          axe: axe.version,
          browser: page.context().browser()?.version(),
          node: process.versions.node,
          platform: process.platform,
          methods: [
            "axe WCAG A/AA and best-practice rules",
            "keyboard skip link",
            "200% text resize",
            "320 CSS pixel reflow",
            "forced colors",
            "reduced motion",
          ],
          conformance: "not-assessed",
          criteria: criterionEvidence(scans),
          limitations: [
            "Automation does not establish complete Section 508 conformance.",
            "Real assistive-technology interaction and criteria without automated rules remain unverified.",
            "Resize checks cover selected states, not every content and browser combination.",
          ],
          scans,
        },
        null,
        2,
      ),
    );
  }
  const failures = scans.flatMap(({ state, results }) =>
    results.violations.map((violation) => ({
      state,
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
      help: violation.helpUrl,
    })),
  );
  assert.deepEqual(failures, [], "Automated accessibility violations; see accessibility.json");
}
