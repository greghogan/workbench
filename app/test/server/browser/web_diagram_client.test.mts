import { expect, test, vi } from "vitest";
import { startDiagrams } from "../../../src/server/browser/diagram-client.ts";
import { DiagramMessage } from "../../../src/server/browser/diagram-protocol.ts";
import { parseDOM } from "../../fixtures/dom.mjs";
import { renderToString } from "preact-render-to-string";
import { diagramView, diagramComparisonView } from "../../../src/server/views/diagram-view.js";

test("diagram messages accept only the isolated renderer and release images when records leave the page", () => {
  const dom = parseDOM(renderToString(diagramView("flowchart LR\nA --> B")), {
    url: "http://localhost:8080/records/demo:TSK-0",
  });
  const browser = dom.window as unknown as Window & typeof globalThis;
  const createURL = vi.fn(() => "blob:diagram"),
    revokeURL = vi.fn<(url: string) => void>();
  Object.assign(browser.URL, { createObjectURL: createURL, revokeObjectURL: revokeURL });
  const controller = startDiagrams(browser);
  try {
    const frame = browser.document.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("Renderer frame missing");
    const renderer = frame.contentWindow;
    const messages = vi.spyOn(renderer, "postMessage");
    const receive = (data: unknown, source: Window = renderer) =>
      browser.dispatchEvent(new browser.MessageEvent("message", { source, data }));
    receive({ type: DiagramMessage.Ready }, browser);
    expect(messages).not.toHaveBeenCalled();
    receive({ type: DiagramMessage.Ready });
    const request = messages.mock.calls[0]?.[0] as { id: string; source: string };
    expect(request.source).toBe("flowchart LR\nA --> B");
    const complete = {
      type: DiagramMessage.Complete,
      id: request.id,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width: 120,
      height: 60,
    };
    receive({ ...complete, width: Number.NaN });
    receive(complete, browser);
    expect(createURL).not.toHaveBeenCalled();
    receive(complete);
    const image = browser.document.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:diagram");
    expect(image?.alt).toContain("A --> B");
    expect(browser.document.querySelector("[data-diagram-source] code")?.textContent).toBe(request.source);
    const source = browser.document.querySelector<HTMLElement>("[data-diagram-source]");
    expect(source?.hidden).toBe(true);
    browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="source"]')?.click();
    expect(source?.hidden).toBe(false);
    browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="diagram"]')?.click();
    expect(source?.hidden).toBe(true);
    expect(createURL).toHaveBeenCalledTimes(1);
    const root = browser.document.querySelector("[data-diagram-comparison]");
    if (!root) throw new Error("Diagram comparison missing");
    root.remove();
    controller.watch();
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:diagram");
    receive(complete);
    expect(createURL).toHaveBeenCalledTimes(1);
    browser.document.body.append(root);
    controller.watch();
    const next = messages.mock.calls[1]?.[0] as { id: string; source: string };
    expect(next.source).toBe(request.source);
    expect(next.id).not.toBe(request.id);
    receive({ ...complete, id: next.id });
    expect(browser.document.querySelectorAll("img")).toHaveLength(1);
    expect(createURL).toHaveBeenCalledTimes(2);
  } finally {
    controller.close();
  }
  expect(browser.document.querySelector("iframe")).toBeNull();
  expect(revokeURL).toHaveBeenCalledTimes(2);
  controller.watch();
  expect(browser.document.querySelector("iframe")).toBeNull();
});

test.each(["https://example.invalid/renderer", "http://["])(
  "unavailable renderer %s leaves readable source",
  (location) => {
    const dom = parseDOM(renderToString(diagramView("graph LR\n A --> B")), {
      url: "http://localhost/records/demo:TSK-0",
    });
    const browser = dom.window as unknown as Window & typeof globalThis;
    const input = browser.document.querySelector<HTMLElement>("[data-diagram-frame]");
    if (!input) throw new Error("Missing diagram");
    input.dataset.diagramFrame = location;
    const controller = startDiagrams(browser);
    expect(browser.document.querySelector("pre")?.textContent).toBe("graph LR\n A --> B");
    expect(browser.document.querySelector("output")?.textContent).toContain("source is shown");
    expect(browser.document.querySelector("iframe,img,script")).toBeNull();
    controller.close();
    expect(browser.document.querySelector("section")?.textContent).toBe("graph LR\n A --> B");
  },
);

test("a failed renderer can restart and page restoration retains the selected source view", () => {
  const dom = parseDOM(renderToString(diagramView("flowchart LR\n A --> B")), {
    url: "http://localhost/records/demo:TSK-0",
  });
  const browser = dom.window as unknown as Window & typeof globalThis;
  const createURL = vi.fn(() => "blob:recovered"),
    revokeURL = vi.fn<(url: string) => void>();
  Object.assign(browser.URL, { createObjectURL: createURL, revokeObjectURL: revokeURL });
  const controller = startDiagrams(browser);
  const frame = browser.document.querySelector("iframe");
  if (!frame) throw new Error("Renderer frame missing");
  frame.dispatchEvent(new browser.Event("error"));
  expect(frame.isConnected).toBe(false);
  expect(browser.document.querySelector<HTMLElement>("[data-diagram-source]")?.hidden).toBe(false);
  browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="retry"]')?.click();
  const replacement = browser.document.querySelector("iframe");
  if (!replacement?.contentWindow) throw new Error("Retry did not create a renderer");
  const renderer = replacement.contentWindow,
    messages = vi.spyOn(renderer, "postMessage");
  const receive = (data: unknown) =>
    browser.dispatchEvent(new browser.MessageEvent("message", { source: renderer, data }));
  receive({ type: DiagramMessage.Ready });
  const request = messages.mock.calls[0]?.[0] as { id: string };
  receive({
    type: DiagramMessage.Complete,
    id: request.id,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    width: 120,
    height: 60,
  });
  browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="source"]')?.click();
  controller.close();
  expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:recovered");
  const restored = startDiagrams(browser);
  expect(
    browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="source"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(browser.document.querySelector<HTMLElement>("[data-diagram-source]")?.hidden).toBe(false);
  restored.close();
});

test("paired diagrams share view selection and retries reject stale render responses", () => {
  const before = "flowchart LR\n A --> B",
    after = "flowchart LR\n A --> C";
  const html =
    '<section class="document-comparison"><table><tbody><tr><td>' +
    renderToString(diagramComparisonView(before, after, "1", "previous", before)) +
    "</td><td>" +
    renderToString(diagramComparisonView(before, after, "1", "current", after)) +
    "</td></tr></tbody></table></section>";
  const dom = parseDOM(html, { url: "http://localhost/records/demo:ADR-0/review" });
  const browser = dom.window as unknown as Window & typeof globalThis;
  const createURL = vi.fn().mockReturnValueOnce("blob:previous").mockReturnValueOnce("blob:current"),
    revokeURL = vi.fn<(url: string) => void>();
  Object.assign(browser.URL, { createObjectURL: createURL, revokeObjectURL: revokeURL });
  const controller = startDiagrams(browser);
  try {
    const frame = browser.document.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("Renderer frame missing");
    const renderer = frame.contentWindow,
      messages = vi.spyOn(renderer, "postMessage");
    const receive = (data: unknown) =>
      browser.dispatchEvent(new browser.MessageEvent("message", { source: renderer, data }));
    receive({ type: DiagramMessage.Ready });
    expect(messages.mock.calls.map((call) => (call[0] as { source: string }).source)).toEqual([before, after]);
    expect(browser.document.querySelectorAll('[role="group"][aria-label="Diagram view"]')).toHaveLength(1);
    const request = (index: number) => messages.mock.calls[index]?.[0] as { id: string };
    const complete = (id: string) => ({
      type: DiagramMessage.Complete,
      id,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width: 120,
      height: 60,
    });
    receive(complete(request(0).id));
    receive({ type: DiagramMessage.Failed, id: request(1).id });
    expect(
      browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="source"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="retry"]')?.click();
    expect(request(2).id).not.toBe(request(1).id);
    receive(complete(request(1).id));
    expect(createURL).toHaveBeenCalledTimes(1);
    browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="source"]')?.click();
    receive(complete(request(2).id));
    const graphics = [...browser.document.querySelectorAll<HTMLElement>("[data-diagram-graphics]")];
    expect(graphics.every((item) => item.hidden)).toBe(true);
    browser.document.querySelector<HTMLButtonElement>('[data-diagram-action="diagram"]')?.click();
    expect(graphics.every((item) => !item.hidden)).toBe(true);
    expect(browser.document.querySelectorAll("img")).toHaveLength(2);
  } finally {
    controller.close();
  }
  expect(revokeURL.mock.calls.map((call) => call[0])).toEqual(["blob:previous", "blob:current"]);
  expect(browser.document.querySelector("iframe,img,button")).toBeNull();
});
