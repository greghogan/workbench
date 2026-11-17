import type { JSX } from "preact";
import { basename } from "node:path";
import { formatBytes } from "../../core/runtime/byte-size.js";
import type { CacheSize } from "../../core/storage/cache-size.js";
import { projectQuantities, type projectCacheViews } from "../cache/cache-view-model.js";
import type { ProjectReviewCount } from "../projects/project-reviews.js";
import { reviewCountLabel } from "../projects/review-count-protocol.js";
import { projectBase } from "../projects/project-mounts.js";
import { Route } from "../routes/routes.js";
import { routeURL } from "../routes/locations.js";
import { badge, submitButton } from "./components.js";
import { mutationForm } from "./action-forms.js";
import { quantityValue, cell } from "./cache-quantity.js";

export const reviewCount = (
  project: { id?: string; name: string },
  counts: ReadonlyMap<string, ProjectReviewCount>,
) => {
  if (!project.id) return null;
  const value = counts.get(project.id);
  return (
    <a
      data-project-reviews={project.id}
      data-review-revision={String(value?.revision ?? 0)}
      data-review-count={value?.count === undefined ? undefined : String(value.count)}
      data-review-problem={value?.problem}
      href={projectBase(project.id) + Route.Reviews}
      title={value?.problem}
    >
      {reviewCountLabel(value)}
    </a>
  );
};

export function ProjectCacheRow({
  model,
  sizes,
  accountingUnknown,
  reviews,
  csrf,
  page,
}: {
  model: ReturnType<typeof projectCacheViews>[number];
  sizes: ReadonlyMap<string, CacheSize>;
  accountingUnknown: boolean;
  reviews: ReadonlyMap<string, ProjectReviewCount>;
  csrf: string;
  page: "projects" | "caches";
}): JSX.Element {
  const { project, worktrees, images, href, id, complete, available } = model;

  const target = project.id ? { project: project.id } : { unlisted: project.path };
  const quantities = projectQuantities(model, sizes, accountingUnknown);
  const breakdown = (
    [
      ["owned", "Owned"],
      ["eligible", "Eligible"],
      ["retained", "Retained"],
      ["tools", "Tools"],
      ["shared", "Shared"],
    ] as const
  ).map(([key, label]) => ({ key, label, value: quantities[key] }));
  return (
    <tr data-cache-row={id}>
      <td data-cache-cell={id + "-name"}>
        {project.id && available ? <a href={projectBase(project.id) + "/"}>{project.name}</a> : project.name}
        {!available && badge("Unavailable")}
        <div class="file-path">{project.path}</div>
        {worktrees.length > 0 && (
          <details data-worktree-list="">
            <summary>
              {worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}
            </summary>
            <ul class="worktree-list">
              {worktrees.map((worktree) => (
                <li>
                  {worktree.id && worktree.available ? (
                    <a href={projectBase(worktree.id) + "/"} title={worktree.path}>
                      {basename(worktree.path)}
                    </a>
                  ) : (
                    <span title={worktree.path}>
                      {basename(worktree.path)} {badge("Unavailable")}
                    </span>
                  )}
                  {" · "}
                  <a href={routeURL(Route.Caches, worktree.id ? { project: worktree.id } : { owner: worktree.path })}>
                    Cache
                  </a>
                  {worktree.available && (
                    <>
                      {" · "}
                      {reviewCount(worktree, reviews)} reviews
                    </>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      {page === "projects" && (
        <td data-cache-cell={id + "-reviews"}>
          {available ? reviewCount(project, reviews) : <span aria-label="Project is unavailable">—</span>}
        </td>
      )}
      {page === "projects" ? (
        <td>
          <button
            type="button"
            class="cache-summary"
            popovertarget={id + "-breakdown"}
            popovertargetaction="show"
            data-cache-preview=""
            aria-labelledby={id + "-size " + id + "-label"}
          >
            <span id={id + "-size"}>{quantityValue(id + "-owned", quantities.owned, undefined, false)}</span>
            <span id={id + "-label"} class="sr-only">
              cache breakdown for {project.name}
            </span>
          </button>
          <section
            id={id + "-breakdown"}
            class="cache-breakdown"
            popover="auto"
            aria-label={"Cache for " + project.name}
          >
            <dl>
              {breakdown.map((entry) => (
                <div key={entry.key}>
                  <dt>{entry.label}</dt>
                  <dd>{quantityValue(id + "-preview-" + entry.key, entry.value, undefined, false)}</dd>
                </div>
              ))}
              <div>
                <dt>Images</dt>
                <dd data-cache-cell={id + "-images"}>
                  {complete ? formatBytes(images.reduce((sum, entry) => sum + entry.bytes, 0)) : "Calculating…"}
                </dd>
              </div>
            </dl>
            <a href={href}>Cache details</a>
          </section>
        </td>
      ) : (
        <>
          {breakdown.map((entry) =>
            cell(id + "-" + entry.key, entry.value, entry.key === "owned" ? href : undefined, false),
          )}
          <td data-cache-cell={id + "-images"}>
            {complete ? formatBytes(images.reduce((sum, entry) => sum + entry.bytes, 0)) : "Calculating…"}
          </td>
        </>
      )}
      <td data-cache-cell={id + "-actions"}>
        {mutationForm({
          action: Route.CachePrepare,
          csrf,
          fields: target,
          class: "inline",
          children: () => (
            <>
              <button
                class="secondary icon-button"
                aria-label={"Clear cache for " + project.name + " at " + project.path}
                title="Clear cache"
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                >
                  <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
                </svg>
              </button>
            </>
          ),
        })}
        {project.id &&
          mutationForm({
            action: Route.ProjectRemove,
            csrf,
            fields: { project: project.id },
            class: "inline",
            children: () => <>{submitButton("Remove", { secondary: true })}</>,
          })}
      </td>
    </tr>
  );
}
