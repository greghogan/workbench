import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { webServers, readWebPage } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { parseDOM } from "../../fixtures/dom.mjs";

const fixture = webServers();
const source = "flowchart LR\n  A[Profile] --> B[Toolchain]\n";
const document = (diagram: string) =>
  "---\nsummary: Diagram review.\n---\n\n# ADR-0: Diagrams\n\n```mermaid\n" + diagram + "```\n";

test("Mermaid source stays escaped and the renderer is served separately with isolated execution", async () => {
  const root = fixture.project();
  const unsafe = source + '  C["</code><script>alert(1)</script>"]\n';
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), document(unsafe));
  const web = await fixture.start(root);
  const page = parseDOM((await readWebPage(web, "/records/demo:ADR-0")).html).window.document;
  const diagram = page.querySelector<HTMLElement>("[data-diagram-comparison]");
  expect(diagram?.querySelector("[data-diagram-source] code")?.textContent).toBe(unsafe);
  expect(diagram?.querySelector("script,iframe,img")).toBeNull();
  const href = diagram?.querySelector<HTMLElement>("[data-diagram-frame]")?.dataset.diagramFrame;
  if (!href) throw new Error("Missing renderer location");
  const response = await fetch(new URL(href, web.url));
  expect(response.status).toBe(200);
  const frame = parseDOM(await response.text()).window.document;
  const script = frame.querySelector("script");
  expect(script?.getAttribute("src")).toBeNull();
  const hash = createHash("sha256")
    .update(script?.textContent ?? "")
    .digest("base64");
  const policy = response.headers.get("content-security-policy") ?? "";
  expect(policy).toContain("sandbox allow-scripts;");
  expect(policy).not.toContain("allow-same-origin");
  expect(policy).toContain(`script-src 'sha256-${hash}'`);
  expect(policy).toContain("frame-ancestors 'self'");
  expect(policy).toContain("default-src 'none'");
  expect(frame.querySelector("script[src],link[href],img[src]")).toBeNull();
});

test.each(["unified", "split"])(
  "diagram review retains paired previews and exact source differences (%s)",
  async (layout) => {
    const root = fixture.project();
    const path = "workbench/decisions/ADR-00.md";
    writeFileSync(join(root, path), document(source));
    git(root, "add", path);
    git(root, "commit", "-qm", "Diagram baseline");
    writeFileSync(join(root, path), document(source.replace("Toolchain", "Prepared toolchain")));
    const web = await fixture.start(root);
    const page = parseDOM((await readWebPage(web, "/records/demo:ADR-0/review?layout=" + layout)).html).window.document;
    expect(page.querySelector(".document-diff")?.textContent).toContain("Prepared toolchain");
    expect(page.querySelector(".document-diff del")?.textContent).toContain("Toolchain");
    const diagrams = [...page.querySelectorAll<HTMLTemplateElement>(".document-diff template")].map(
      (item) => item.content.textContent,
    );
    expect(diagrams).toEqual([source, source.replace("Toolchain", "Prepared toolchain")]);
    expect(page.querySelectorAll(".diagram-removed")).toHaveLength(1);
    expect(page.querySelectorAll(".diagram-added")).toHaveLength(1);
    expect(page.querySelectorAll(".document-diff script, .document-diff iframe, .document-diff img")).toHaveLength(0);
  },
);
test.each([true, false])("one-sided diagrams preserve exact source without an empty preview (%s)", async (added) => {
  const root = fixture.project(),
    path = "workbench/decisions/ADR-00.md",
    without = document("").replace("```mermaid\n```\n", "").trimEnd() + "\n";
  writeFileSync(join(root, path), added ? without : document(source));
  git(root, "add", path);
  git(root, "commit", "-qm", "Diagram baseline");
  writeFileSync(join(root, path), added ? document(source) : without);
  const web = await fixture.start(root);
  const page = parseDOM((await readWebPage(web, "/records/demo:ADR-0/review?layout=split")).html).window.document;
  const cells = page.querySelectorAll(".document-diff td");
  expect(page.querySelectorAll("[data-diagram-frame]")).toHaveLength(1);
  expect(page.querySelector<HTMLTemplateElement>(".document-diff template")?.content.textContent).toBe(source);
  expect(page.querySelector(added ? ".diagram-added" : ".diagram-removed")).not.toBeNull();
  const empty = [...cells].find(
    (cell) => cell.querySelector("[data-diagram-comparison]") && !cell.querySelector("[data-diagram-frame]"),
  );
  expect(empty?.querySelector("pre")).toBeNull();
});
