import type { ComponentChildren, JSX } from "preact";
import type { BrowserRecord } from "../../core/records/record-service.js";
import { recordKey, compareRecordKeys } from "../routes/record-listing.js";
import type { ViewContext } from "../workspace/view-context.js";
import { recordURL } from "../routes/locations.js";
import { sourceURL } from "../routes/sources.js";
import type { TaskLifecycle } from "../../core/tasks/task-workflow.js";

export interface PaneStep {
  href: string;
  title?: string;
}
export function recordNeighbors(
  context: ViewContext,
  record: Pick<BrowserRecord, "id" | "type" | "scope">,
  status?: TaskLifecycle,
) {
  const candidates: Pick<BrowserRecord, "id" | "type" | "scope" | "title">[] = context.records.filter(
    (item) =>
      item.scope === record.scope && item.type === record.type && (!status || context.taskState(item.id) === status),
  );
  if (!candidates.some((item) => item.id === record.id)) candidates.push({ ...record, title: record.id });
  const ordered = candidates
    .map((item) => ({
      item,
      key: recordKey(item.id),
    }))
    .sort((a, b) => compareRecordKeys(a.key, b.key));
  const index = ordered.findIndex(({ item }) => item.id === record.id);
  const step = (item: Pick<BrowserRecord, "id" | "title"> | undefined): PaneStep | undefined =>
    item ? { href: sourceURL(context, recordURL(item.id, status ? { status } : {})), title: item.title } : undefined;
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
