import type { JSX } from "preact";
import { panel } from "./components.js";
import { recordURL } from "./locations.js";
import { type ViewContext } from "./view-context.js";
export function adaptationsPanel(context: ViewContext): JSX.Element | null {
  if (!context.selection || !context.comparison) return null;
  if (context.comparison.state === "published") return null;
  if (context.comparison.state !== "compared")
    return <p class="notice">Upstream comparison unavailable: {context.comparison.message}</p>;
  const changed = context.comparison.decisions.filter((decision) => decision.status !== "unchanged");
  return panel(
    changed.length ? (
      <ul>
        {changed.map((decision) => (
          <li>
            <a href={recordURL(decision.id, { collection: context.selection, view: "changes" })}>{decision.id}</a>
            {" · "}
            {decision.status === "modified" ? "Adapted" : decision.status === "removed" ? "Removed" : "Added"}
          </li>
        ))}
      </ul>
    ) : (
      <p>No ADR adaptations from the pinned upstream version.</p>
    ),
    { heading: "Collection adaptations" },
  );
}
