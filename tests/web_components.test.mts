import { inventoryPresentation, inventoryContent, inventoryPatch, hubLayout } from "../src/web/hub-pages.js";
import { emptyInventory } from "../src/web/cache-inventory.js";
import type { RegisteredProject } from "../src/project-registry.js";
import { parseDOM, renderDOM } from "./fixtures/dom.mjs";
import { expect, test } from "vitest";
import { headerSearch, panel, textArea, textField } from "../src/web/components.js";
import { requestUnavailablePage } from "../src/web/page-frame.tsx";
import { pageDocument } from "../src/web/page-document.js";
import { tabs } from "../src/web/render-links.js";
import { decodeInventoryPatch } from "../src/web/inventory-protocol.js";
import { mutationForm } from "../src/web/action-forms.js";
import { Route } from "../src/web/routes.js";
import { DifferenceLayout } from "../src/web/navigation-state.js";
import { withProjectPaths } from "../src/web/project-paths.js";
import type { InventoryView } from "../src/web/inventory-service.js";

test("server-rendered controls preserve exact text and selected values without interpreting markup", () => {
  const text = "<script>alert(\"x\")</script> & 'quotes'";
  const document = parseDOM(
    pageDocument({
      title: text,
      contents: [
        text,
        panel(textArea({ id: "draft", name: "contents", label: text, value: text }), { heading: text }),
        textField({ id: "name", name: "name", label: text, value: text }),
        headerSearch({ query: text, type: "CIT" }),
        tabs([{ label: text, href: "/records?q=" + encodeURIComponent(text), current: true }], text),
      ],
    }),
  ).window.document;
  expect(document.body.textContent).toContain(text);
  expect(document.querySelector("title")?.textContent).toBe(text + " · Workbench");
  expect(document.querySelector("h2")?.textContent).toBe(text);
  expect(document.querySelector<HTMLTextAreaElement>("#draft")?.value).toBe(text);
  expect(document.querySelector<HTMLInputElement>("#name")?.value).toBe(text);
  expect(document.querySelector<HTMLInputElement>("#global-search")?.value).toBe(text);
  expect(document.querySelector<HTMLSelectElement>("#global-search-type")?.value).toBe("CIT");
  expect(document.querySelector("[aria-current=page]")?.textContent).toBe(text);
  expect(document.querySelectorAll("script")).toHaveLength(1);
  expect(document.querySelector("script")?.getAttribute("src")).toBe("/assets/client.js");
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input:not([type=hidden]),textarea,select",
  )) {
    expect(control.labels?.length, "Control has no native label: " + control.id).toBeGreaterThan(0);
    expect([...(control.labels ?? [])].some((label) => label.control === control)).toBe(true);
  }
});

test("inventory updates reject malformed nested data before publishing partial changes", () => {
  const patch = { sections: { projects: "<tr></tr>" }, problems: [], refreshing: false, sizes: [] };
  expect(decodeInventoryPatch(patch)).toEqual(patch);
  for (const invalid of [
    { ...patch, sections: ["rows"] },
    { ...patch, sections: { projects: 42 } },
    { ...patch, sections: { unknown: "<tr></tr>" } },
    { ...patch, problems: [null] },
    { ...patch, sizes: [{ directory: "/cache", state: "ready", bytes: 1 }] },
  ])
    expect(() => decodeInventoryPatch(invalid)).toThrow();
});

test("review forms bind the exact version and source while retaining their project navigation context", () => {
  const document = withProjectPaths("/p/owned", () =>
    renderDOM(
      mutationForm({
        action: Route.Approve,
        csrf: "token <&>",
        context: { selection: "patterns", scope: "", all: false },
        fields: {
          path: "workbench/decisions/ADR-00.md",
          digest: "exact-version",
          review_layout: DifferenceLayout.Split,
          reviewed: "yes",
          human_written: "no",
        },
        children: () => "Confirm",
      }),
    ),
  );
  const form = document.querySelector("form");
  expect(form?.getAttribute("action")).toBe("/p/owned/actions/approve");
  expect(form?.hasAttribute("data-review")).toBe(true);
  const values = Object.fromEntries(
    [...document.querySelectorAll<HTMLInputElement>("input")].map((input) => [input.name, input.value]),
  );
  expect(values).toEqual({
    csrf: "token <&>",
    record_source: "patterns",
    record_scope: "",
    record_all: "0",
    path: "workbench/decisions/ADR-00.md",
    digest: "exact-version",
    review_layout: "split",
    reviewed: "yes",
    human_written: "no",
  });
});

test("initial cache tables and live row fragments preserve text, form values, and accessible names", () => {
  const text = '<img src=x onerror=alert(1)> & "quotes" <tr>';
  const project: RegisteredProject = {
    id: "a".repeat(24),
    path: import.meta.dirname,
    name: text,
    state: "registered",
    updated: "2026-01-01T00:00:00Z",
  };
  const page = inventoryPresentation(
    {
      ...emptyInventory(),
      projects: [project],
      complete: true,
      refreshing: false,
      problem: "",
    },
    [project],
    text,
    "projects",
  );
  const initial = parseDOM(pageDocument({ title: "Projects", contents: inventoryContent(page) }));
  const fragment = parseDOM("<table><tbody>" + (inventoryPatch(page).sections.projects ?? "") + "</tbody></table>");
  try {
    for (const document of [initial.window.document, fragment.window.document]) {
      expect(document.querySelectorAll("[data-cache-row]")).toHaveLength(1);
      expect(document.querySelector('[data-cache-cell$="-name"] a')?.textContent).toBe(text);
      expect(document.querySelector("img")).toBeNull();
      expect(
        document.querySelector<HTMLInputElement>('form[action="/projects/remove"] input[name="csrf"]')?.value,
      ).toBe(text);
      expect(document.querySelector("button[title='Clear cache']")?.getAttribute("aria-label")).toBe(
        "Clear cache for " + text + " at " + project.path,
      );
    }
    expect(initial.window.document.querySelector("[data-cache-row]")?.textContent).toBe(
      fragment.window.document.querySelector("[data-cache-row]")?.textContent,
    );
  } finally {
    initial.window.close();
    fragment.window.close();
  }
});

test("all cache table fragments preserve the initial rows, quantities, controls, and literal text", () => {
  const text = '<img src=x onerror=alert(1)> & "quoted"';
  const checkout = import.meta.dirname;
  const project: RegisteredProject = {
    id: "b".repeat(24),
    name: text,
    path: checkout,
    state: "registered",
    updated: "2026-01-01T00:00:00Z",
  };
  const data: InventoryView = {
    ...emptyInventory(),
    projects: [project],
    complete: true,
    refreshing: false,
    problem: "",
    sizes: [
      { directory: "/fixture/build", state: "ready", bytes: 1234 },
      { directory: "/fixture/tool", state: "ready", bytes: 2000 },
    ],
    inventory: {
      storageRoot: "/fixture",
      checkout,
      entries: [
        {
          kind: "builds",
          directory: "/fixture/build",
          bytes: 1234,
          identity: { checkout, root: ".", environment: "native", fingerprint: "a".repeat(24) },
        },
      ],
      tools: {
        entries: [
          {
            id: "fixture-tool",
            provider: "workbench",
            tool: text,
            version: "1.0",
            platform: "fixture",
            directory: "/fixture/tool",
            identity: "fixture",
            bytes: 2000,
            protected: [],
            pinnedBy: [],
            protections: [],
          },
        ],
        issues: [],
        references: { results: [], issues: [] },
      },
      builders: { entries: [{ key: text, builder: "fixture", volumes: [], bytes: 3000, checkout }], issues: [] },
      images: {
        location: "local",
        entries: [
          {
            key: "fixture-image",
            checkout,
            profile: "fixture",
            reference: text,
            image: "fixture",
            bytes: 4000,
            lock: "/fixture/lock",
            receipt: "/fixture/lock",
            identity: "fixture",
            catalog: "/fixture/catalog",
          },
        ],
        issues: [],
      },
    },
    consumers: { "fixture-tool": [checkout] },
  };
  const page = inventoryPresentation(data, [project], text, "caches");
  const initial = renderDOM(inventoryContent(page));
  const patch = inventoryPatch(page);
  expect(Object.keys(patch.sections).sort()).toEqual(["builders", "images", "projects", "roots", "tools"]);
  for (const [section, html] of Object.entries(patch.sections)) {
    const fragment = parseDOM("<table><tbody>" + html + "</tbody></table>").window.document;
    const body = initial.querySelector(`[data-cache-rows="${section}"]`);
    if (!body) throw new Error("Missing initial inventory section: " + section);
    const rows = (element: ParentNode) =>
      [...element.querySelectorAll("[data-cache-row]")].map((row) => ({
        id: row.getAttribute("data-cache-row"),
        text: row.textContent,
        fields: [...row.querySelectorAll<HTMLInputElement>("input")].map((input) => [input.name, input.value]),
        actions: [...row.querySelectorAll("form")].map((form) => [form.method, form.getAttribute("action")]),
      }));
    expect(rows(fragment)).toEqual(rows(body));
    expect(fragment.querySelector("img,script")).toBeNull();
  }
  const projects = inventoryPatch(inventoryPresentation(data, [project], text, "projects"));
  expect(Object.keys(projects.sections)).toEqual(["projects"]);
});

test("static error pages retain responsive navigation and escaped diagnostics without opening live connections", () => {
  const page = parseDOM(requestUnavailablePage("Failure <script>malicious</script>"));
  const document = page.window.document;
  expect(document.querySelector('meta[name="viewport"]')).not.toBeNull();
  expect(document.querySelector('link[rel="stylesheet"]')).not.toBeNull();
  expect(document.querySelector("a.skip")?.getAttribute("href")).toBe("#main");
  expect(document.querySelector("main")?.textContent).toContain("Failure <script>malicious</script>");
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("main a")?.textContent).toBe("Return to the workspace");
});

test.each(["projects", "caches"] as const)("hub navigation identifies its current %s view", (active) => {
  const page = parseDOM(hubLayout("Page", "Contents", { active }));
  expect(page.window.document.querySelector('nav a[aria-current="page"]')?.getAttribute("href")).toBe("/" + active);
  expect(page.window.document.querySelectorAll('nav a[aria-current="page"]')).toHaveLength(1);
});
