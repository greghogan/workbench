import { expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDOM } from "../../fixtures/dom.mjs";
import { webServers, readReconciledWebPage } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { approveReviewFiles, reviewStatus, ReviewSource } from "../../../src/core/review/review-service.ts";

const fixture = webServers();
const records = [
  { path: "workbench/CHARTER.md", title: "Charter", header: "", section: "Intent" },
  {
    path: "workbench/decisions/ADR-00.md",
    title: "ADR-0: Decision",
    header: "---\nsummary: Review a decision.\n---\n\n",
    section: "Decision",
  },
  {
    path: "workbench/environments/ENV-00.md",
    title: "ENV-0: Hardware",
    header: "---\n{}\n---\n\n",
    section: "Hardware configuration",
  },
  {
    path: "workbench/experiments/EXP-00.md",
    title: "EXP-0: Comparison",
    header: "---\nstatus: Accepted\nenvironment: null\n---\n\n",
    section: "Decision",
  },
];

test.each(records)("$path reviews the last acknowledged version in both shared diff layouts", async (record) => {
  const root = fixture.project();
  mkdirSync(dirname(join(root, record.path)), { recursive: true });
  const contents = (word: string) =>
    `${record.header}# ${record.title}\n\n## ${record.section}\n\nUnchanged document context.\n\n${word} wording.\n`;
  writeFileSync(join(root, record.path), contents("Committed"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "Record baseline");
  writeFileSync(join(root, record.path), contents("Reviewed"));
  const change = reviewStatus(root, ReviewSource.Working).changes.find((change) => change.path === record.path);
  if (!change) throw new Error("Missing protected review fixture");
  approveReviewFiles(root, [change], change.charter, ReviewSource.Working);
  writeFileSync(join(root, record.path), contents("Current"));
  const web = await fixture.start(root);
  const page = parseDOM((await readReconciledWebPage(web, `/review?path=${encodeURIComponent(record.path)}`)).html)
    .window.document;
  const diff = page.querySelector(".document-diff");
  expect(diff).not.toBeNull();
  expect(diff?.textContent).toContain("Unchanged document context.");
  expect([...page.querySelectorAll(".document-diff del")].map((node) => node.textContent).join("")).toContain(
    "Reviewed",
  );
  expect([...page.querySelectorAll(".document-diff ins")].map((node) => node.textContent).join("")).toContain(
    "Current",
  );
  expect(diff?.textContent).not.toContain("Committed");
  expect(page.querySelector('nav[aria-label="Reviewed file views"]')).toBeNull();
  const layouts = [...page.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Difference layout"] a')];
  expect(layouts.map((link) => link.textContent)).toEqual(["Unified", "Side-by-side"]);
  const splitURL = layouts.find((link) => link.textContent === "Side-by-side")?.getAttribute("href");
  if (!splitURL) throw new Error("Missing side-by-side navigation");
  const split = parseDOM((await readReconciledWebPage(web, splitURL)).html).window.document;
  expect(split.querySelector(".document-diff.split")).not.toBeNull();
  const previous = [...split.querySelectorAll('[data-diff-side="before"]')].map((node) => node.textContent).join(" ");
  expect(previous).toContain("Reviewed wording.");
  expect(previous).not.toContain("Current wording.");
  const current = [...split.querySelectorAll('[data-diff-side="after"]')].map((node) => node.textContent).join(" ");
  expect(current).toContain("Current wording.");
  expect(split.querySelector('nav[aria-label="Difference layout"] [aria-current="page"]')?.textContent).toBe(
    "Side-by-side",
  );
  expect(split.querySelector("form[data-review] [data-approve]")?.textContent).toBe("Confirm changes");
});
