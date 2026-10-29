import type { ComponentChildren, JSX } from "preact";
import type { BrowserRecord } from "../record-service.js";
import { normalizedNumber } from "../record-identity.js";
import type { ViewContext } from "./view-context.js";
import { recordURL } from "./locations.js";

export interface PaneStep {
  href: string;
  title?: string;
}
export function recordNeighbors(context: ViewContext, record: Pick<BrowserRecord, "id" | "type" | "scope">) {
  const candidates: Pick<BrowserRecord, "id" | "type" | "scope" | "title">[] = context.records.filter(
    (item) => item.scope === record.scope && item.type === record.type,
  );
  if (!candidates.some((item) => item.id === record.id)) candidates.push({ ...record, title: record.id });
  const ordered = candidates
    .map((item) => ({
      item,
      number: item.type === "CHARTER" ? "" : normalizedNumber(item.id.split("-").at(-1) ?? "0"),
    }))
    .sort((a, b) => a.number.length - b.number.length || a.number.localeCompare(b.number));
  const index = ordered.findIndex(({ item }) => item.id === record.id);
  const step = (item: Pick<BrowserRecord, "id" | "title"> | undefined): PaneStep | undefined =>
    item ? { href: recordURL(item.id), title: item.title } : undefined;
  return {
    previous: index > 0 ? step(ordered[index - 1]?.item) : undefined,
    next: index >= 0 ? step(ordered[index + 1]?.item) : undefined,
  };
}

/** Shared document frame keeps previous/next controls beside every readable or editable record view. */
export function recordPane(
  children: ComponentChildren,
  options: { previous: PaneStep | undefined; next: PaneStep | undefined; label?: string },
): JSX.Element {
  const control = (direction: "previous" | "next", step: PaneStep | undefined) => {
    const label = `${direction === "previous" ? "Previous" : "Next"} ${options.label ?? "record"}`;
    const arrow = (
      <svg viewBox="0 0 16 28" aria-hidden="true" focusable="false">
        <path
          d={direction === "previous" ? "M12 3 3 14l9 11" : "m4 3 9 11-9 11"}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        />
      </svg>
    );
    return step ? (
      <a
        class="record-step"
        href={step.href}
        rel={direction === "previous" ? "prev" : "next"}
        aria-label={label}
        title={step.title ? `${label}: ${step.title}` : label}
      >
        <span class="record-step-icon">{arrow}</span>
      </a>
    ) : (
      <button type="button" class="record-step disabled" disabled aria-label={label}>
        <span class="record-step-icon">{arrow}</span>
      </button>
    );
  };
  return (
    <div class="record-pane">
      <div class="record-step-rail">{control("previous", options.previous)}</div>
      <div class="record-pane-content">{children}</div>
      <div class="record-step-rail">{control("next", options.next)}</div>
    </div>
  );
}
