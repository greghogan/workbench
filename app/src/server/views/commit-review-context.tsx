import { historyFiles } from "../../core/git/history.js";
import { historicalRecords } from "../review/historical-records.js";
import type { ComponentChildren, JSX } from "preact";
import { resolve } from "node:path";

export function commitReviewContext(
  root: string,
  revision: string,
  subject: string,
  progress: ComponentChildren,
): JSX.Element {
  const history = historyFiles(root, revision),
    taskPaths = history.changes
      .map((file) => file.path)
      .filter((path) => /(?:^|\/)workbench\/tasks\/(?:[0-9A-Z]{2}\/)*TSK-[0-9A-Z]+\.md$/.test(path)),
    tasks = taskPaths.flatMap((path) => {
      const current = historicalRecords(root, revision, () => history.logicalAfter, taskPaths).references.path(
          resolve(root, path),
        ),
        record =
          current ??
          (history.unit.parents[0]
            ? historicalRecords(root, history.unit.parents[0], () => history.logicalBefore, taskPaths).references.path(
                resolve(root, path),
              )
            : undefined);
      return record?.type === "TSK" ? [record] : [];
    });
  return (
    <div class="commit-review-context">
      {tasks.map((task) => (
        <p key={task.id}>
          {task.scope}:{task.title}
        </p>
      ))}
      <h2>{subject}</h2>
      <p class="muted">
        {progress} · Commit <code>{revision.slice(0, 12)}</code>
      </p>
    </div>
  );
}
