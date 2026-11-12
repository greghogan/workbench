import type { ComponentChildren, JSX } from "preact";
import { assetURL } from "../browser/asset-manifest.js";

export type DiagramSide = "unified" | "previous" | "current";
interface Version {
  source: string;
  change: "same" | "removed" | "added";
}
function presentation(versions: Version[], source: ComponentChildren, id = "", side?: DiagramSide): JSX.Element {
  return (
    <section class="diagram-comparison" data-diagram-comparison={id} data-diagram-side={side}>
      <div class="diagram-tools" data-diagram-tools="" hidden></div>
      <div data-diagram-graphics="" hidden>
        {versions.map((version) => (
          <figure
            class={"diagram" + (version.change === "same" ? "" : " diagram-" + version.change)}
            data-diagram-frame={assetURL("diagrams")}
            aria-label={
              version.change === "same" ? "Diagram" : version.change === "removed" ? "Removed diagram" : "Added diagram"
            }
          >
            <template>
              <pre>
                <code>{version.source}</code>
              </pre>
            </template>
          </figure>
        ))}
      </div>
      <div data-diagram-source="">{source}</div>
    </section>
  );
}
export function diagramView(source: string): JSX.Element {
  return presentation(
    [{ source, change: "same" }],
    <pre>
      <code>{source}</code>
    </pre>,
  );
}
export function diagramComparisonView(
  before: string | null,
  after: string | null,
  id: string,
  side: DiagramSide,
  source: ComponentChildren,
): JSX.Element {
  const versions: Version[] = [];
  if (side !== "current" && before !== null) versions.push({ source: before, change: "removed" });
  if (side !== "previous" && after !== null) versions.push({ source: after, change: "added" });
  const present = side === "previous" ? before !== null : side === "current" ? after !== null : true;
  return presentation(versions, present ? source : null, id, side);
}
