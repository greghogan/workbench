import type { Browser } from "./browser-session.js";
import { DiagramMessage, isDiagramResponse } from "./diagram-protocol.js";

const View = { Diagram: "diagram", Source: "source" } as const;
type View = (typeof View)[keyof typeof View];
interface Group {
  key: string;
  scope: Element | null;
  roots: Set<HTMLElement>;
  diagrams: Set<Diagram>;
  mode: View;
  controls?: {
    host: HTMLElement;
    diagram: HTMLButtonElement;
    source: HTMLButtonElement;
    retry: HTMLButtonElement;
    status: HTMLOutputElement;
  };
}
interface Diagram {
  element: HTMLElement;
  original: ChildNode[];
  text: string;
  group: Group;
  number: number;
  failed: boolean;
  id?: string;
  sent?: boolean;
  url?: string;
}

/** One isolated renderer serves immutable versions; paired controls never change the review snapshot. */
export function startDiagrams(browser: Browser): { watch: () => void; close: () => void } {
  const { document } = browser,
    groups = new Set<Group>(),
    roots = new WeakMap<HTMLElement, Group>(),
    owners = new WeakMap<HTMLElement, Diagram>(),
    requests = new Map<string, Diagram>();
  let renderer: HTMLIFrameElement | undefined,
    ready = false,
    stopped = false,
    sequence = 0,
    diagramCount = 0;
  const release = (diagram: Diagram) => {
    if (diagram.id) requests.delete(diagram.id);
    if (diagram.url) browser.URL.revokeObjectURL(diagram.url);
    delete diagram.url;
    delete diagram.id;
    delete diagram.sent;
  };
  const present = (group: Group) => {
    const failed = [...group.diagrams].some((diagram) => diagram.failed),
      complete = group.diagrams.size > 0 && [...group.diagrams].every((diagram) => !!diagram.url),
      graphic = group.mode === View.Diagram && complete && !failed;
    for (const root of group.roots) {
      root.dataset.diagramMode = group.mode;
      const source = root.querySelector<HTMLElement>(":scope > [data-diagram-source]"),
        graphics = root.querySelector<HTMLElement>(":scope > [data-diagram-graphics]");
      if (source) source.hidden = graphic;
      if (graphics) graphics.hidden = !graphic;
    }
    if (group.controls) {
      group.controls.diagram.setAttribute("aria-pressed", String(group.mode === View.Diagram));
      group.controls.source.setAttribute("aria-pressed", String(group.mode === View.Source));
      group.controls.diagram.disabled = failed;
      group.controls.retry.hidden = !failed;
      group.controls.status.textContent = failed
        ? "Diagram unavailable; source is shown."
        : group.mode === View.Diagram && !complete
          ? "Rendering diagram…"
          : "";
    }
  };
  const fail = (diagram: Diagram) => {
    release(diagram);
    diagram.failed = true;
    diagram.group.mode = View.Source;
    present(diagram.group);
  };
  const send = (diagram: Diagram) => {
    if (!ready || !renderer?.contentWindow || !diagram.id || diagram.sent) return;
    diagram.sent = true;
    try {
      renderer.contentWindow.postMessage({ type: DiagramMessage.Render, id: diagram.id, source: diagram.text }, "*");
    } catch {
      fail(diagram);
    }
  };
  const ensureRenderer = (diagram: Diagram): boolean => {
    const location = browser.URL.parse(diagram.element.dataset.diagramFrame ?? "", browser.location.href);
    if (location?.origin !== browser.location.origin) {
      fail(diagram);
      return false;
    }
    if (!renderer) {
      const frame = document.createElement("iframe");
      renderer = frame;
      frame.className = "diagram-renderer";
      frame.title = "Diagram renderer";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.src = location.href;
      frame.addEventListener("error", () => {
        if (stopped || renderer !== frame) return;
        renderer = undefined;
        ready = false;
        frame.remove();
        for (const group of groups) for (const item of group.diagrams) fail(item);
      });
      document.body.append(frame);
    }
    return true;
  };
  const render = (diagram: Diagram) => {
    release(diagram);
    diagram.failed = false;
    if (!ensureRenderer(diagram)) return;
    diagram.id = "workbench-diagram-" + String(++sequence);
    requests.set(diagram.id, diagram);
    send(diagram);
  };
  const controls = (group: Group, root: HTMLElement) => {
    const host = root.querySelector<HTMLElement>(":scope > [data-diagram-tools]");
    if (!host || !root.querySelector("[data-diagram-frame]")) return;
    host.hidden = false;
    if (group.controls?.host.isConnected) return;
    const choices = document.createElement("div");
    choices.className = "diagram-switch";
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", "Diagram view");
    const button = (label: string, action: string) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "secondary";
      item.textContent = label;
      item.dataset.diagramAction = action;
      return item;
    };
    const diagram = button("Diagram", View.Diagram),
      source = button("Source", View.Source),
      retry = button("Retry diagram", "retry"),
      status = document.createElement("output");
    retry.hidden = true;
    status.className = "muted";
    choices.append(diagram, source);
    host.replaceChildren(choices, retry, status);
    group.controls = { host, diagram, source, retry, status };
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (
      stopped ||
      !renderer?.contentWindow ||
      event.source !== renderer.contentWindow ||
      !isDiagramResponse(event.data)
    )
      return;
    const message = event.data;
    if (message.type === DiagramMessage.Ready) {
      if (!ready) {
        ready = true;
        for (const item of requests.values()) send(item);
      }
      return;
    }
    const diagram = requests.get(message.id);
    if (!diagram?.element.isConnected) return;
    if (message.type === DiagramMessage.Failed) {
      fail(diagram);
      return;
    }
    requests.delete(message.id);
    const url = browser.URL.createObjectURL(new browser.Blob([message.svg], { type: "image/svg+xml" }));
    diagram.url = url;
    const image = document.createElement("img");
    image.alt = (diagram.element.getAttribute("aria-label") ?? "Diagram") + ": " + diagram.text;
    image.width = Math.ceil(message.width);
    image.height = Math.ceil(message.height);
    image.src = url;
    image.addEventListener(
      "error",
      () => {
        if (!stopped && diagram.element.isConnected && diagram.url === url) fail(diagram);
      },
      { once: true },
    );
    const viewport = document.createElement("div");
    viewport.className = "diagram-viewport";
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "region");
    viewport.setAttribute(
      "aria-label",
      (diagram.element.getAttribute("aria-label") ?? "Diagram") + " " + String(diagram.number),
    );
    viewport.append(image);
    diagram.element.replaceChildren(viewport);
    present(diagram.group);
  };
  const choose = (event: Event) => {
    if (stopped || !(event.target instanceof browser.Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-diagram-action]"),
      root = button?.closest<HTMLElement>("[data-diagram-comparison]"),
      group = root ? roots.get(root) : undefined;
    if (!button || !group) return;
    const action = button.dataset.diagramAction;
    if (action === "retry") {
      group.mode = View.Diagram;
      for (const diagram of group.diagrams) if (diagram.failed) render(diagram);
    } else if (action === View.Source || action === View.Diagram) group.mode = action;
    present(group);
  };
  const watch = () => {
    if (stopped) return;
    for (const group of groups) {
      for (const root of group.roots)
        if (!root.isConnected) {
          group.roots.delete(root);
          roots.delete(root);
        }
      for (const diagram of group.diagrams)
        if (!diagram.element.isConnected) {
          release(diagram);
          diagram.element.replaceChildren(...diagram.original);
          owners.delete(diagram.element);
          group.diagrams.delete(diagram);
        }
      if (!group.roots.size) groups.delete(group);
    }
    for (const root of document.querySelectorAll<HTMLElement>("[data-diagram-comparison]")) {
      let group = roots.get(root);
      if (!group) {
        const key = root.dataset.diagramComparison ?? "",
          scope = root.closest(".document-comparison");
        group = key && scope ? [...groups].find((item) => item.scope === scope && item.key === key) : undefined;
        group ??= {
          key,
          scope,
          roots: new Set(),
          diagrams: new Set(),
          mode: root.dataset.diagramMode === View.Source ? View.Source : View.Diagram,
        };
        groups.add(group);
        group.roots.add(root);
        roots.set(root, group);
      }
      controls(group, root);
      for (const element of root.querySelectorAll<HTMLElement>("[data-diagram-frame]")) {
        if (owners.has(element)) continue;
        const source = element.querySelector<HTMLTemplateElement>("template")?.content.querySelector("pre");
        if (!source) continue;
        const diagram: Diagram = {
          element,
          original: [...element.childNodes],
          text: source.textContent,
          group,
          number: ++diagramCount,
          failed: false,
        };
        owners.set(element, diagram);
        group.diagrams.add(diagram);
        render(diagram);
      }
    }
    for (const group of groups) present(group);
  };
  browser.addEventListener("message", receive);
  browser.addEventListener("click", choose);
  watch();
  return {
    watch,
    close: () => {
      stopped = true;
      browser.removeEventListener("message", receive);
      browser.removeEventListener("click", choose);
      renderer?.remove();
      for (const group of groups) {
        for (const diagram of group.diagrams) {
          release(diagram);
          if (diagram.element.isConnected) diagram.element.replaceChildren(...diagram.original);
        }
        for (const root of group.roots) {
          const source = root.querySelector<HTMLElement>(":scope > [data-diagram-source]"),
            graphics = root.querySelector<HTMLElement>(":scope > [data-diagram-graphics]"),
            tools = root.querySelector<HTMLElement>(":scope > [data-diagram-tools]");
          if (source) source.hidden = false;
          if (graphics) graphics.hidden = true;
          if (tools) {
            tools.replaceChildren();
            tools.hidden = true;
          }
        }
      }
      groups.clear();
      requests.clear();
    },
  };
}
