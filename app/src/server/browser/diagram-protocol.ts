export const DiagramMessage = {
  Ready: "diagram-ready",
  Render: "diagram-render",
  Complete: "diagram-complete",
  Failed: "diagram-failed",
} as const;

export interface DiagramRequest {
  type: typeof DiagramMessage.Render;
  id: string;
  source: string;
}
export type DiagramResponse =
  | { type: typeof DiagramMessage.Ready }
  | { type: typeof DiagramMessage.Failed; id: string }
  | { type: typeof DiagramMessage.Complete; id: string; svg: string; width: number; height: number };

export function isDiagramRequest(value: unknown): value is DiagramRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    value.type === DiagramMessage.Render &&
    "id" in value &&
    typeof value.id === "string" &&
    "source" in value &&
    typeof value.source === "string"
  );
}

export function isDiagramResponse(value: unknown): value is DiagramResponse {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === DiagramMessage.Ready) return true;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (value.type === DiagramMessage.Failed) return true;
  return (
    value.type === DiagramMessage.Complete &&
    "svg" in value &&
    typeof value.svg === "string" &&
    value.svg.length <= 16 * 1024 * 1024 &&
    "width" in value &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    "height" in value &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}
