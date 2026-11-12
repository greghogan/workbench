import { afterEach, expect, test, vi } from "vitest";
import { parseDOM } from "../../fixtures/dom.mjs";
import { startHubUpdates } from "../../../src/server/browser/hub-client.ts";
import { startBrowser } from "../../../src/server/browser/client.ts";
import { errorResponse, workerFailure, decodeWorkerFailure } from "../../../src/server/http/error-response.ts";
import { WebError } from "../../../src/server/http/errors.ts";
import { decodeRecovery } from "../../../src/server/projects/recovery.ts";
import { BrowserSession } from "../../../src/server/browser/browser-session.ts";
import { startFormActions } from "../../../src/server/browser/form-client.ts";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
function inventory(events = true, row = '<td data-cache-cell="size">123 B</td>') {
  const dom = parseDOM(
    `<body ${events ? 'data-events-url="/updates"' : ""}><div id="inventory-status" hidden><span></span><a href="">Refresh</a></div><section data-cache-content data-inventory-url="/inventory"><table><tbody data-cache-rows="projects"><tr data-cache-row="p">${row}</tr></tbody></table></section></body>`,
    { url: "http://localhost/projects" },
  );
  const sources: EventTarget[] = [];
  class Events extends dom.window.EventTarget {
    constructor() {
      super();
      sources.push(this);
    }
    close = vi.fn();
  }
  Object.defineProperty(dom.window, "EventSource", { value: Events });
  const fetch = vi.fn<typeof globalThis.fetch>();
  Object.defineProperty(dom.window, "fetch", { value: fetch });
  const stop = startHubUpdates(dom.window as unknown as Window & typeof globalThis);
  cleanups.push(() => {
    stop();
    dom.window.close();
  });
  return {
    document: dom.window.document,
    fetch,
    event: (type: string, value: unknown) =>
      sources[0]?.dispatchEvent(new dom.window.MessageEvent(type, { data: JSON.stringify(value) })),
    update: async () => {
      sources[0]?.dispatchEvent(new dom.window.Event("inventory"));
      await vi.advanceTimersByTimeAsync(150);
    },
  };
}
test("count events avoid inventory fetches and late row patches cannot undo a newer completed count", async () => {
  vi.useFakeTimers();
  const id = "a".repeat(24);
  const row = (revision: number, count: number) =>
    `<td data-cache-cell="reviews"><a data-project-reviews="${id}" data-review-revision="${String(revision)}" data-review-count="${String(count)}" href="/projects/${id}/review">${String(count)}</a></td>`;
  const web = inventory(true, row(1, 7));
  web.event("reviews", { id, revision: 3, count: 2 });
  expect(web.document.querySelector("td a")?.textContent).toBe("2");
  expect(web.fetch).not.toHaveBeenCalled();
  web.fetch.mockResolvedValue(
    Response.json({
      sections: { projects: `<tr data-cache-row="p">${row(2, 5)}</tr>` },
      sizes: [],
      problems: [],
      refreshing: false,
    }),
  );
  await web.update();
  expect(web.document.querySelector("td a")?.textContent).toBe("2");
  web.event("reviews", { id, revision: 4, count: 0 });
  web.event("reviews", { id, revision: 3, count: 2 });
  expect(web.document.querySelector("td a")?.textContent).toBe("0");
  expect(web.document.querySelector("td a")?.getAttribute("href")).toBe(`/projects/${id}/review`);
  expect(web.fetch).toHaveBeenCalledOnce();
  let release!: (response: Response) => void;
  const patch = (revision: number, count: number) =>
    Response.json({
      sections: { projects: `<tr data-cache-row="p">${row(revision, count)}</tr>` },
      sizes: [],
      problems: [],
      refreshing: false,
    });
  web.fetch
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(patch(1, 6));
  await web.update();
  web.event("open", null);
  release(patch(100, 99));
  await vi.advanceTimersByTimeAsync(300);
  expect(web.document.querySelector("td a")?.textContent).toBe("6");
});
test("inventory retains measured data through transient failures, reports persistent failures, and recovers", async () => {
  vi.useFakeTimers();
  const web = inventory(),
    status = web.document.getElementById("inventory-status");
  web.fetch.mockRejectedValue(new TypeError("Network connection unavailable"));
  await web.update();
  expect(status?.hidden).toBe(true);
  await web.update();
  await web.update();
  expect(status?.hidden).toBe(false);
  expect(web.document.querySelector("td")?.textContent).toBe("123 B");
  web.fetch.mockResolvedValue(
    new Response(JSON.stringify({ sections: {}, sizes: [], problems: [], refreshing: false })),
  );
  await web.update();
  expect(status?.hidden).toBe(true);
  web.fetch.mockResolvedValue(new Response("{}"));
  await web.update();
  expect(status?.hidden).toBe(false);
  expect(status?.textContent).toContain("invalid");
  expect(web.document.querySelector("td")?.textContent).toBe("123 B");
});
test("missing background endpoints are visible without making an invented request", () => {
  const web = inventory(false);
  expect(web.document.getElementById("inventory-status")?.hidden).toBe(false);
  expect(web.fetch).not.toHaveBeenCalled();
  const dom = parseDOM(
    '<body><div id="live-status" hidden><span></span><a href="">Refresh</a></div><main></main></body>',
    { url: "http://localhost/" },
  );
  const close = startBrowser(dom.window as unknown as Window & typeof globalThis);
  cleanups.push(() => {
    close();
    dom.window.close();
  });
  expect(dom.window.document.getElementById("live-status")?.hidden).toBe(false);
});
test("server recovery destinations survive workers and are followed by failed forms without repeating a mutation", async () => {
  const recovery = { href: "/collections?scope=demo", label: "Return to collections" };
  const problem = errorResponse(
    decodeWorkerFailure(workerFailure(new WebError(409, "Preview expired", { recovery }))),
    "request",
  );
  expect(problem).toEqual({ status: 409, message: "Preview expired", recovery });
  expect(decodeRecovery({ href: "//other-host/action", label: "Retry" })).toBeUndefined();
  expect(decodeRecovery({ href: "/\\other-host/action", label: "Retry" })).toBeUndefined();
  const dom = parseDOM(
    '<body><div id="live-status" hidden><span></span><a>Refresh</a></div><main><form data-action action="/actions/collection-apply"><button>Apply</button></form></main></body>',
    { url: "http://localhost/collection-proposal" },
  );
  const browser = dom.window as unknown as Window & typeof globalThis;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ error: problem.message, recovery }), { status: problem.status }));
  Object.defineProperty(browser, "fetch", { value: fetch });
  const session = new BrowserSession(browser),
    stop = startFormActions(session);
  cleanups.push(() => {
    stop();
    session.close();
    dom.window.close();
  });
  dom.window.document
    .querySelector("form")
    ?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(dom.window.document.querySelector("#live-status a")?.getAttribute("href")).toBe("/collections?scope=demo");
  });
  expect(dom.window.document.querySelector("#live-status a")?.textContent).toBe("Return to collections");
  expect(fetch).toHaveBeenCalledOnce();
  expect(dom.window.document.querySelector("button")?.disabled).toBe(false);
});
