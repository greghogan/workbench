import { afterEach, expect, test } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renderMap } from "../src/maps.ts";
import { renderCollectionMap } from "../src/collection-maps.ts";
import { renderAgentContext } from "../src/agents.ts";
import { readDecision } from "../src/decision-record.ts";
import { decisionScopes } from "../src/decisions.ts";
import { documentationErrors } from "../src/documentation.ts";
import { section } from "../src/records.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-record-navigation-"));
  roots.push(root);
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write("workbench/config.toml", "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n");
  write("workbench/projects.toml", '[[project]]\nid="demo"\npath="."\n');
  copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
  write("workbench/decisions/ADR-00.md", "---\nsummary: Foundational intent.\n---\n\n# ADR-0: Foundation\n");
  return { root, write };
}

test("record maps and agent context preserve encoded subproject paths and decision-summary links", () => {
  const { root, write } = fixture();
  const path = "packages/API v2#draft(s)";
  write("workbench/projects.toml", `[[project]]\nid="demo"\npath="."\n[[project]]\nid="api"\npath="${path}"\n`);
  write(`${path}/workbench/CHARTER.md`, "# API\n\nFixture scope.\n");
  write(`${path}/workbench/decision-map.md`, "# Decision map\n");
  write(
    "workbench/decisions/ADR-01.md",
    '---\nsummary: "Read [foundation](ADR-00.md)."\n---\n\n# ADR-1: Network [draft]\n',
  );
  const map = renderMap(root, { id: "demo", path: "." }, "ADR");
  expect(map).toContain("[foundation](decisions/ADR-00.md)");
  expect(map).toContain("Network \\[draft\\]");
  expect(map).toContain("API%20v2%23draft%28s%29/workbench/decision-map.md");
  write("workbench/decision-map.md", map);
  const context = renderAgentContext(root);
  expect(context).toContain("API%20v2%23draft%28s%29/workbench/decision-map.md");
  write("AGENTS.md", context);
  expect(documentationErrors(root, [join(root, "workbench/decision-map.md"), join(root, "AGENTS.md")])).toEqual([]);
});

test("published collection maps relocate summary links from their actual record directory", () => {
  const { root, write } = fixture();
  const path = join(root, "workbench/decisions/ADR-01.md");
  write(
    "workbench/decisions/ADR-01.md",
    '---\nsummary: "Read [foundation](ADR-00.md)."\n---\n\n# ADR-1: Network [draft]\n',
  );
  const map = renderCollectionMap([readDecision({ id: "demo", path: "." }, "1", path)]);
  expect(map).toContain("[foundation](decisions/ADR-00.md)");
  expect(map).toContain("Network \\[draft\\]");
});

test.each(["summary", "agent_instruction", "body"])(
  "%s references permit later ADRs while rejecting unresolved references and cycles",
  (field) => {
    const { root, write } = fixture();
    write("workbench/decisions/ADR-01.md", "---\nsummary: Later policy.\n---\n\n# ADR-1: Later\n");
    const decision = (target: string) => {
      const reference = `See ${target}.`,
        summary = field === "summary" ? reference : "Foundation.",
        instruction = field === "agent_instruction" ? `agent_instruction: ${reference}\n` : "";
      return `---\nsummary: ${summary}\n${instruction}---\n\n# ADR-0: Foundation\n\n${field === "body" ? reference : ""}\n`;
    };
    write("workbench/decisions/ADR-00.md", decision("demo:ADR-1"));
    expect(decisionScopes(root, false)[0]?.decisions.map(({ reference }) => reference)).toEqual([
      "demo:ADR-0",
      "demo:ADR-1",
    ]);
    write("workbench/decisions/ADR-01.md", "---\nsummary: Later policy.\n---\n\n# ADR-1: Later\n\nSee ADR-0.\n");
    expect(() => decisionScopes(root, false)).toThrow(/reference cycle/);
    write("workbench/decisions/ADR-00.md", decision("demo:ADR-Z"));
    expect(() => decisionScopes(root, false)).toThrow(/reference not found/);
  },
);

test.each([
  "```md\n## Hypothesis\nAn example, not a protocol section.\n```\n",
  "> ## Hypothesis\n> A quoted example.\n",
  "## Hypothesis\n\n# Appendix\nUnrelated text.\n",
  "## Hypothesis\n\n<!-- Add a real hypothesis here. -->\n",
])("protocol sections must be real document sections: %s", (contents) => {
  expect(section(contents, "Hypothesis")).toBe(false);
  expect(section("## Hypothesis\n\nTestable effect.\n", "Hypothesis")).toBe(true);
});

test("documentation checks real reference links and images while ignoring literal examples", () => {
  const { root, write } = fixture();
  write("notes/a(b)#literal.md", "# Target\n");
  write("image.png", "fixture image");
  write(
    "README.md",
    '[target][reference]\n\n[reference]: notes/a%28b%29%23literal.md#target "A title"\n\n![image](image.png)\n\n```md\n[example](missing-example.md)\n```\n',
  );
  const readme = join(root, "README.md");
  expect(documentationErrors(root, [readme])).toEqual([]);
  write(
    "README.md",
    "[missing][record]\n\n[record]: absent.md\n\n![missing image](absent.png)\n\n[bad encoding](%FF.md)\n",
  );
  const errors = documentationErrors(root, [readme]);
  expect(errors).toHaveLength(3);
  expect(errors.join("\n")).toMatch(/absent.md/);
  expect(errors.join("\n")).toMatch(/absent.png/);
  expect(errors.join("\n")).toContain("invalid link encoding");
});

test("documentation links cannot escape ownership through a directory alias", () => {
  const { root, write } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "workbench-document-target-"));
  roots.push(outside);
  writeFileSync(join(outside, "notes.md"), "Unrelated private fixture.\n");
  symlinkSync(outside, join(root, "alias"), "junction");
  write("README.md", "[outside](alias/notes.md)\n");
  expect(documentationErrors(root, [join(root, "README.md")]).join("\n")).toContain("symlinks are not supported");
  expect(readFileSync(join(outside, "notes.md"), "utf8")).toBe("Unrelated private fixture.\n");
});
