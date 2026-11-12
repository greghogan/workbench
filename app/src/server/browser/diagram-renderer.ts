import { DiagramMessage, isDiagramRequest } from "./diagram-protocol.js";
import type { DiagramResponse } from "./diagram-protocol.js";

// The separately acquired official tiny build supplies this browser API.
declare const mermaid: {
  initialize(configuration: Record<string, unknown>): void;
  render(id: string, source: string, container: Element): Promise<{ svg: string }>;
};

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "neutral",
  fontFamily: "system-ui, sans-serif",
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: false },
});

let queue = Promise.resolve();
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isDiagramRequest(event.data)) return;
  const request = event.data;
  queue = queue.then(async () => {
    const container = document.getElementById("diagram");
    let response: DiagramResponse;
    try {
      if (!container) throw new Error("Diagram container is unavailable");
      const { svg } = await mermaid.render(request.id, request.source, container);
      const document = new DOMParser().parseFromString(svg, "image/svg+xml");
      const [, , width, height] = (document.documentElement.getAttribute("viewBox") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height))
        throw new Error("Diagram dimensions are unavailable");
      response = { type: DiagramMessage.Complete, id: request.id, svg, width, height };
    } catch {
      response = { type: DiagramMessage.Failed, id: request.id };
    } finally {
      container?.replaceChildren();
    }
    window.parent.postMessage(response, "*");
  });
});
window.parent.postMessage({ type: DiagramMessage.Ready }, "*");
