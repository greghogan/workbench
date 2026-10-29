import { afterEach, expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import { startBrowser } from "../src/web/client.ts";

const resources: { close: () => void }[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});
function fixture(body: string) {
  const dom = new JSDOM(
    `<!doctype html><body data-revision="one"><nav aria-label="Main navigation"></nav><div id="live-status" hidden><span></span><a href="">Refresh</a></div><main>${body}</main></body>`,
    { url: "http://localhost:8080/collections", pretendToBeVisual: true },
  );
  const window = dom.window;
  const events: Events[] = [];
  class Events extends window.EventTarget {
    onerror: (() => void) | null = null;
    closed = false;
    constructor() {
      super();
      events.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const observers: Observer[] = [];
  class Observer {
    constructor(readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe() {
      /* Visibility is explicitly driven by this fixture. */
    }
    disconnect() {
      /* The fixture owns observation delivery. */
    }
    fire() {
      this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
  }
  Object.defineProperty(window, "EventSource", { value: Events });
  Object.defineProperty(window, "IntersectionObserver", { value: Observer });
  const fetch = vi.fn<typeof globalThis.fetch>();
  Object.defineProperty(window, "fetch", { value: fetch });
  window.scrollTo = vi.fn();
  window.scrollBy = vi.fn();
  const close = startBrowser(window as unknown as Window & typeof globalThis);
  resources.push({
    close: () => {
      close();
      dom.window.close();
    },
  });
  const change = () => {
    events[0]?.dispatchEvent(new window.MessageEvent("revision", { data: "two" }));
  };
  return { window, document: window.document, fetch, events, observers, change, close };
}
function deferredResponse() {
  let finish: (response: Response) => void = () => {
    throw new Error("missing response owner");
  };
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  return { response, finish };
}
const updated = (body: string) =>
  new Response(
    `<!doctype html><body data-revision="two"><nav aria-label="Main navigation"></nav><main>${body}</main></body>`,
  );

test("routine freshness events never change the reading view or announce timestamps", () => {
  const web = fixture("<p>Reading position</p>"),
    main = web.document.querySelector("main");
  for (const refreshing of [true, false, true, false])
    web.events[0]?.dispatchEvent(
      new web.window.MessageEvent("freshness", {
        data: JSON.stringify({ refreshing, problem: "", collectedAt: new Date().toISOString() }),
      }),
    );
  expect(web.document.querySelector("main")).toBe(main);
  expect(web.document.getElementById("live-status")?.hidden).toBe(true);
  expect(web.fetch).not.toHaveBeenCalled();
  expect(web.document.body.textContent).not.toContain("checked at");
});
test("workspace recovery preserves a separately owned draft notice", () => {
  const web = fixture("<form data-editor><textarea>Human draft</textarea></form>");
  web.change();
  for (const problem of ["temporary read failure", ""])
    web.events[0]?.dispatchEvent(
      new web.window.MessageEvent("freshness", { data: JSON.stringify({ refreshing: false, problem }) }),
    );
  expect(web.document.getElementById("live-status")?.hidden).toBe(false);
  expect(web.document.getElementById("live-status")?.textContent).toContain("draft is preserved");
});
test("browser restoration reopens controllers and retains unsaved form ownership", () => {
  const web = fixture("<form data-action data-editor><textarea>Original</textarea></form>");
  const editor = web.document.querySelector("textarea");
  if (!editor) throw new Error("Missing editor");
  editor.value = "Human draft";
  editor.dispatchEvent(new web.window.Event("input", { bubbles: true }));
  web.window.dispatchEvent(new web.window.Event("pagehide"));
  expect(web.events[0]?.closed).toBe(true);
  web.window.dispatchEvent(new web.window.Event("pageshow"));
  expect(web.events).toHaveLength(2);
  expect(web.document.querySelector("textarea")).toBe(editor);
  expect(editor.value).toBe("Human draft");
  const leaving = new web.window.Event("beforeunload", { cancelable: true });
  web.window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
});
test("live refresh restores the focused breadcrumb rather than another link to the same URL", async () => {
  const web = fixture('<nav aria-label="Breadcrumb"><a href="/records?type=TSK">Tasks</a></nav>');
  const navigation = '<a href="/records?type=TSK">Tasks</a>';
  const sidebar = web.document.querySelector('nav[aria-label="Main navigation"]');
  if (!sidebar) throw new Error("Missing main navigation");
  sidebar.innerHTML = navigation;
  web.document.querySelector<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a')?.focus();
  web.fetch.mockResolvedValueOnce(
    new Response(
      '<body data-revision="two"><nav aria-label="Main navigation">' +
        navigation +
        '</nav><main><nav aria-label="Breadcrumb">' +
        navigation +
        "</nav></main></body>",
    ),
  );
  web.change();
  await vi.waitFor(() => {
    expect(web.document.body.dataset.revision).toBe("two");
  });
  expect(web.document.activeElement?.closest("nav")?.getAttribute("aria-label")).toBe("Breadcrumb");
});

test("record reference previews support focus, Escape, safe text, and live-node replacement", async () => {
  const web = fixture(
    '<a href="/record?id=demo:TSK-0" data-record-reference="demo:TSK-0" data-record-title="&lt;b&gt;Task&lt;/b&gt;" data-record-summary="A summary" aria-describedby="existing">Task</a>',
  );
  const link = web.document.querySelector<HTMLAnchorElement>("main a");
  link?.focus();
  const popup = web.document.querySelector<HTMLElement>('[role="tooltip"]');
  expect(popup?.hidden).toBe(false);
  expect(popup?.textContent).toContain("demo:TSK-0");
  expect(popup?.textContent).toContain("<b>Task</b>");
  expect(popup?.querySelector("b")).toBeNull();
  expect(link?.getAttribute("aria-describedby")).toContain("existing record-reference-preview");
  link?.dispatchEvent(new web.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(popup?.hidden).toBe(true);
  expect(link?.getAttribute("aria-describedby")).toBe("existing");
  link?.blur();
  link?.focus();
  link?.remove();
  await Promise.resolve();
  expect(popup?.hidden).toBe(true);
  web.close();
  expect(web.document.querySelector('[role="tooltip"]')).toBeNull();
});

test("inventory events update measured cells without disturbing a focused action or unrelated draft", async () => {
  vi.useFakeTimers();
  const dom = new JSDOM(
    '<body data-project-hub><section data-cache-content data-cache-refreshing="true"><table><tbody data-cache-rows="projects"><tr data-cache-row="p"><td data-cache-cell="size" data-cache-members="[&quot;/cache&quot;]">10 B</td><td data-cache-cell="action"><button>Clear cache</button></td></tr></tbody></table><div data-cache-problems></div></section><input id="draft" value="unfinished"></body>',
    { url: "http://localhost:8080/projects", pretendToBeVisual: true },
  );
  const browser = dom.window as unknown as Window & typeof globalThis;
  const eventSources: EventTarget[] = [];
  class Events extends dom.window.EventTarget {
    constructor() {
      super();
      eventSources.push(this);
    }
    close = vi.fn();
  }
  Object.defineProperty(browser, "EventSource", { value: Events });
  const patch = (size: string, pending = false) => ({
    sections: {
      projects: `<tr data-cache-row="p"><td data-cache-cell="size" data-cache-members="[&quot;/cache&quot;]"${pending ? ' data-cache-pending="true"' : ""}>${size}</td><td data-cache-cell="action"><button>Remove cache</button></td></tr>`,
    },
    problems: [],
    sizes: [],
    refreshing: pending,
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(patch("123 B")))
    .mockResolvedValueOnce(Response.json(patch("Calculating…", true)));
  Object.defineProperty(browser, "fetch", { value: fetch });
  const close = startBrowser(browser);
  try {
    const button = browser.document.querySelector<HTMLButtonElement>("button");
    button?.focus();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(fetch).not.toHaveBeenCalled();
    eventSources[0]?.dispatchEvent(new dom.window.Event("inventory"));
    await vi.advanceTimersByTimeAsync(150);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browser.document.querySelector('[data-cache-cell="size"]')?.textContent).toBe("123 B");
    expect(browser.document.activeElement).toBe(button);
    expect(button?.textContent).toBe("Clear cache");
    eventSources[0]?.dispatchEvent(
      new dom.window.MessageEvent("size", {
        data: JSON.stringify({ directory: "/cache", state: "ready", bytes: 250, measuredAt: "2026-10-28T00:00:00Z" }),
      }),
    );
    expect(browser.document.querySelector('[data-cache-cell="size"]')?.textContent).toBe("250 B");
    expect(fetch).toHaveBeenCalledTimes(1);

    const draft = browser.document.querySelector<HTMLInputElement>("#draft");
    draft?.focus();
    expect(browser.document.querySelector("button")?.textContent).toBe("Remove cache");
    eventSources[0]?.dispatchEvent(new dom.window.Event("inventory"));
    await vi.advanceTimersByTimeAsync(150);
    expect(browser.document.querySelector('[data-cache-cell="size"]')?.textContent).toBe("250 B");
    expect(browser.document.querySelector<HTMLInputElement>("#draft")).toBe(draft);
    expect(draft?.value).toBe("unfinished");
  } finally {
    close();
    dom.window.close();
    vi.useRealTimers();
  }
});

test.each(["data-action", 'action="/records"'])(
  "typing into a %s form while a live response is pending preserves the draft and current DOM",
  async (attributes) => {
    const web = fixture(
      `<form ${attributes}><label>Repository<input id="repository" name="source" value="original"></label></form>`,
    );
    const pending = deferredResponse();
    web.fetch.mockReturnValue(pending.response);
    web.change();
    expect(web.fetch).toHaveBeenCalledOnce();
    const input = web.document.querySelector("input");
    if (!input) throw new Error("missing form input");
    input.value = "human draft";
    input.dispatchEvent(new web.window.Event("input", { bubbles: true }));
    pending.finish(updated("<p>Replacement page</p>"));
    await vi.waitFor(() => {
      expect(web.document.getElementById("live-status")?.textContent).toContain("draft is preserved");
    });
    expect(web.document.querySelector("input")).toBe(input);
    expect(input.value).toBe("human draft");
    expect(web.document.querySelector("main")?.textContent).not.toContain("Replacement page");
  },
);
test("cleanup aborts pending reads and never publishes a late response", async () => {
  const web = fixture("<p>Original page</p>");
  const pending = deferredResponse();
  web.fetch.mockReturnValue(pending.response);
  web.change();
  web.close();
  pending.finish(updated("<p>Late page</p>"));
  await pending.response;
  await Promise.resolve();
  expect(web.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(web.events[0]?.closed).toBe(true);
  expect(web.document.querySelector("main")?.textContent).toBe("Original page");
});
const row = (number: number) =>
  `<a href="/record?id=demo:TSK-${number.toString(36).toUpperCase()}" data-record-id="demo:TSK-${number.toString(36).toUpperCase()}">Task ${String(number)}</a>`;
const list = (start: number, count: number) =>
  `<div id="record-previous"></div><div id="record-list" data-list-revision="one"><section class="panel">${Array.from({ length: count }, (_, index) => row(start + index)).join("")}</section></div><div id="record-loader"><a data-load-more href="/records?type=TSK&after=demo:TSK-8B&cursor_revision=one">Load more</a></div><p id="record-loading-status" role="status"></p>`;
test("automatic loading preserves focused rows, while explicit loading bounds the DOM and retains a navigable range", async () => {
  const web = fixture(list(0, 300));
  web.window.history.replaceState(null, "", "/records?type=TSK");
  const first = web.document.querySelector<HTMLAnchorElement>("[data-record-id]");
  first?.focus();
  web.observers.at(-1)?.fire();
  expect(web.fetch).not.toHaveBeenCalled();
  web.fetch.mockResolvedValue(updated(list(300, 100)));
  const loader = web.document.querySelector<HTMLAnchorElement>("[data-load-more]");
  loader?.dispatchEvent(new web.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(web.document.querySelector('[data-record-id="demo:TSK-B3"]')).not.toBeNull();
  });
  const rows = web.document.querySelectorAll("[data-record-id]");
  expect(rows.length).toBe(300);
  expect(rows[0]?.textContent).toBe("Task 100");
  expect(web.document.activeElement?.textContent).toBe("Task 300");
  expect(new URL(web.window.location.href).searchParams.get("after")).toBe("demo:TSK-2R");
  expect(new URL(web.window.location.href).searchParams.get("through")).toBe("demo:TSK-B3");
  expect(web.document.querySelector("#record-previous a")?.getAttribute("href")).toContain("before=demo%3ATSK-2S");
});
test("a keyboard focus move during a batch request prevents eviction of the focused row", async () => {
  const web = fixture(list(0, 300));
  const pending = deferredResponse();
  web.fetch.mockReturnValue(pending.response);
  web.observers.at(-1)?.fire();
  const first = web.document.querySelector<HTMLAnchorElement>("[data-record-id]");
  first?.focus();
  pending.finish(updated(list(300, 100)));
  await vi.waitFor(() => {
    expect(web.document.getElementById("record-list")?.hasAttribute("aria-busy")).toBe(false);
  });
  expect(web.document.activeElement).toBe(first);
  expect(web.document.querySelectorAll("[data-record-id]").length).toBe(300);
  expect(web.document.querySelector('[data-record-id="demo:TSK-B3"]')).toBeNull();
});

test("source branches retain disclosure state across refresh and support keyboard traversal", async () => {
  const web = fixture("<p>Records</p>");
  web.close();
  const source = web.document.createElement("nav");
  source.dataset.sourceNavigation = "";
  source.innerHTML =
    '<ul><li><div class="source-row"><button data-source-toggle="root" data-source-default="true" aria-controls="root-children" aria-expanded="true">Toggle root</button><a class="source-link" href="/?scope=root">GraphAI</a></div><ul id="root-children"><li><div class="source-row"><button data-source-toggle="constructor" aria-controls="child-children" aria-expanded="true">Toggle child</button><a class="source-link" href="/?scope=child">GraphMP</a></div><ul id="child-children"><li><div class="source-row"><a class="source-link" href="/?scope=leaf">Solver</a></div></li></ul></li></ul></li></ul>';
  web.document.body.prepend(source);
  const { startSourceNavigation } = await import("../src/web/source-client.ts");
  const { BrowserSession } = await import("../src/web/browser-session.ts");
  const controller = startSourceNavigation(new BrowserSession(web.window as unknown as Window & typeof globalThis));
  resources.push({ close: controller.close });
  const child = source.querySelector<HTMLAnchorElement>('a[href="/?scope=child"]');
  const nested = web.document.getElementById("child-children");
  expect(nested?.hidden).toBe(true);
  child?.focus();
  child?.dispatchEvent(new web.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(nested?.hidden).toBe(false);
  controller.refresh();
  expect(nested?.hidden).toBe(false);
  child?.dispatchEvent(new web.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(web.document.activeElement?.textContent).toBe("Solver");
  web.document.activeElement?.dispatchEvent(
    new web.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
  );
  expect(web.document.activeElement).toBe(child);
  child?.dispatchEvent(new web.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(nested?.hidden).toBe(true);
  controller.refresh();
  expect(nested?.hidden).toBe(true);
});

test("the collection group participates in keyboard navigation without a source link of its own", async () => {
  const web = fixture("<p>Records</p>");
  web.close();
  const nav = web.document.createElement("nav");
  nav.dataset.sourceNavigation = "";
  nav.innerHTML =
    '<ul><li><div class="source-row"><a class="source-link" href="/?scope=root">Root</a></div></li><li><div class="source-row"><button data-source-toggle="collections:" data-source-default="true" aria-controls="collection-children" aria-expanded="true">Collections</button><a aria-label="Manage collections" href="/collections">Settings</a></div><ul id="collection-children"><li><div class="source-row"><a class="source-link" href="/?collection=company">company</a></div></li></ul></li></ul>';
  web.document.body.prepend(nav);
  const { startSourceNavigation } = await import("../src/web/source-client.ts");
  const { BrowserSession } = await import("../src/web/browser-session.ts");
  const controller = startSourceNavigation(new BrowserSession(web.window as unknown as Window & typeof globalThis));
  resources.push({ close: controller.close });
  const toggle = nav.querySelector("button"),
    leaf = nav.querySelector<HTMLAnchorElement>('a[href="/?collection=company"]');
  toggle?.focus();
  toggle?.dispatchEvent(new web.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(web.document.activeElement).toBe(leaf);
  leaf?.dispatchEvent(new web.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(web.document.activeElement).toBe(toggle);
});

test("connection recovery clears its own notice while preserving a failed refresh", async () => {
  const web = fixture("<p>Last complete view</p>");
  web.events[0]?.onerror?.();
  expect(web.document.getElementById("live-status")?.textContent).toContain("connection interrupted");
  web.events[0]?.dispatchEvent(new web.window.Event("open"));
  expect(web.document.getElementById("live-status")?.hidden).toBe(true);
  web.fetch.mockRejectedValueOnce(new Error("unavailable read"));
  web.change();
  await vi.waitFor(() => {
    expect(web.document.getElementById("live-status")?.textContent).toContain("Live refresh failed");
  });
  web.events[0]?.onerror?.();
  web.events[0]?.dispatchEvent(new web.window.Event("open"));
  expect(web.document.getElementById("live-status")?.hidden).toBe(false);
  expect(web.document.getElementById("live-status")?.textContent).toContain("unavailable read");
});

test("a rejected save shows its precise cause above the retained-draft warning", async () => {
  const web = fixture(
    '<form data-action data-editor><textarea name="contents">Original</textarea><button type="submit">Save draft</button></form>',
  );
  const form = web.document.querySelector("form"),
    editor = web.document.querySelector("textarea");
  if (!form || !editor) throw new Error("Missing editor fixture");
  editor.value = "Human draft";
  editor.dispatchEvent(new web.window.Event("input", { bubbles: true }));
  web.change();
  expect(web.document.getElementById("live-status")?.textContent).toContain("draft is preserved");
  web.fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "file changed since this editor opened; your draft was not saved" }), {
      status: 409,
    }),
  );
  form.dispatchEvent(new web.window.Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(web.document.getElementById("live-status")?.textContent).toContain("file changed since this editor opened");
  });
  expect(editor.value).toBe("Human draft");
  web.events[0]?.dispatchEvent(
    new web.window.MessageEvent("freshness", { data: JSON.stringify({ refreshing: false, problem: "" }) }),
  );
  expect(web.document.getElementById("live-status")?.textContent).toContain("file changed since this editor opened");
});

test("retrying workspace acquisition preserves the current editor and unsaved-change protection", async () => {
  const web = fixture('<form data-action data-editor><textarea name="contents">draft</textarea></form>');
  const banner = web.document.getElementById("live-status"),
    form = web.document.createElement("form");
  form.setAttribute("data-action", "");
  form.setAttribute("data-workspace-retry", "");
  form.action = "/actions/workspace-retry";
  form.innerHTML = '<button type="submit">Retry refresh</button>';
  banner?.append(form);
  const editor = web.document.querySelector("textarea");
  if (!editor) throw new Error("Missing editor");
  editor.value = "unsaved edit";
  editor.dispatchEvent(new web.window.Event("input", { bubbles: true }));
  web.fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ redirect: "/" }), { headers: { "content-type": "application/json" } }),
  );
  form.dispatchEvent(new web.window.Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(web.fetch).toHaveBeenCalledTimes(1);
  });
  await vi.waitFor(() => {
    expect(form.querySelector("button")?.disabled).toBe(false);
  });
  expect(editor.value).toBe("unsaved edit");
  const unload = new web.window.Event("beforeunload", { cancelable: true });
  web.window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
});
