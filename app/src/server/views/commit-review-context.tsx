import { historyFiles } from "../../core/git/history.js";
import { historicalRecords } from "../review/historical-records.js";
import type { ComponentChildren, JSX } from "preact";
import { resolve } from "node:path";

function commitTasks(root: string, revision: string) {
  const history = historyFiles(root, revision),
    taskPaths = history.changes
      .map((file) => file.path)
      .filter((path) => /(?:^|\/)workbench\/tasks\/(?:[0-9A-Z]{2}\/)*TSK-[0-9A-Z]+\.md$/.test(path));
  return taskPaths.flatMap((path) => {
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
}

export function commitReviewContext(
  root: string,
  revision: string,
  subject: string,
  progress: ComponentChildren,
  {
    headingLevel = 2,
    showTasks = true,
    commitHref,
  }: { headingLevel?: 2 | 3; showTasks?: boolean; commitHref?: string } = {},
): JSX.Element {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const commit = (
    <>
      Commit <code>{revision.slice(0, 12)}</code>
    </>
  );
  return (
    <div class="commit-review-context">
      {showTasks &&
        commitTasks(root, revision).map((task) => (
          <p key={task.id}>
            {task.scope}:{task.title}
          </p>
        ))}
      <Heading>{subject}</Heading>
      <p class="muted">
        {progress} · {commitHref ? <a href={commitHref}>{commit}</a> : commit}
      </p>
    </div>
  );
}
