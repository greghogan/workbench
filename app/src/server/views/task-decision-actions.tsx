import type { ComponentChild, JSX } from "preact";

export function taskDecisionActions(
  kind: "plan" | "task",
  primary: JSX.Element | null,
  secondary: readonly ComponentChild[],
): JSX.Element | null {
  const actions = secondary.filter(Boolean);
  if (!actions.length) return primary ? <div class="task-actions">{primary}</div> : null;
  return (
    <div class="task-decision-actions" data-primary={primary ? "1" : undefined}>
      <details>
        <summary class="button secondary">
          <span class="task-show-actions">Show {kind} actions</span>
          <span class="task-hide-actions">Hide {kind} actions</span>
        </summary>
        <div class="task-secondary-actions">{actions}</div>
      </details>
      {primary && <div class="task-primary-action">{primary}</div>}
    </div>
  );
}
