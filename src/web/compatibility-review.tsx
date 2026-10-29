import { CompatibilityDecision } from "../policy-findings.js";
import { PolicyCompatibilityState } from "../policy-compatibility.js";
import { projectBreadcrumb } from "../project-hierarchy.js";
import { badge, submitButton } from "./components.js";
import { mutationForm } from "./action-forms.js";
import { markdown } from "./markdown-view.js";
import { recordURL, routeURL } from "./locations.js";
import { projectPath } from "./project-paths.js";
import { reviewLocation } from "./review-navigation.js";
import { Route } from "./routes.js";
import { shell } from "./page-frame.js";
import type { ViewContext } from "./view-context.js";

export function compatibilityReviewItem(context: ViewContext) {
  if (!context.compatibilityNeedsHumanReview) return null;
  return (
    <article class="record-row" data-card="" data-compatibility-item="">
      {badge("Compatibility", "pending")}
      <h2>
        <a data-card-link="" href={routeURL(Route.Review, { compatibility: "1" })}>
          Resolve policy incompatibilities
        </a>
      </h2>
      <p>
        {String(context.pendingCompatibilityFindings.length + (context.compatibility.report?.conflicts.length ?? 0))}{" "}
        reported incompatibilities
      </p>
    </article>
  );
}
export function compatibilityStatus(context: ViewContext) {
  const { report, error } = context.compatibility;
  if (!report) return <p class="notice">Compatibility status unavailable: {error}</p>;
  const messages: Record<typeof report.status, string> = {
    conflict: "Policy sources conflict.",
    "stale-context": "Local agent context needs regeneration.",
    "not-required": "No local collections apply.",
    current: "Compatibility assessment is current.",
    "review-required": "An agent compatibility assessment is needed.",
    incompatible: context.pendingCompatibilityFindings.length
      ? "Reported incompatibilities need human resolution."
      : "Approved resolutions await policy changes and a fresh agent assessment.",
  };
  return (
    <p>
      {messages[report.status]}
      {report.reviewed_at && (
        <>
          {" "}
          Previous acknowledgment:{" "}
          <time datetime={report.reviewed_at}>{report.reviewed_at.replace("T", " ").replace("Z", " UTC")}</time>.
        </>
      )}
    </p>
  );
}
export function compatibilityReviewPage(context: ViewContext): string {
  const { report, error } = context.compatibility;
  const assessment = report?.sources.length ? report.assessment : null;
  const previous = context.reviewQueue.at(-1);
  return shell(
    context,
    "Policy compatibility",
    "review",
    <>
      {context.compatibilityNeedsHumanReview && (
        <nav class="review-navigation" aria-label="Review queue navigation">
          {previous ? (
            <a rel="prev" href={reviewLocation(context, previous)}>
              ← Previous
            </a>
          ) : (
            <span class="muted">← Previous</span>
          )}
          <span>
            {String(context.pendingReviews)} of {String(context.pendingReviews)}
          </span>
          <span class="muted">Next →</span>
        </nav>
      )}
      {compatibilityStatus(context)}
      {context.problem && (
        <p class="notice">The workspace could not refresh. This is the last acquired compatibility report.</p>
      )}
      {error && <p class="notice">Resolve the inspection error before reassessing compatibility.</p>}
      {!!report?.conflicts.length && (
        <section class="panel">
          <div class="panel-body">
            <h2>Conflicting policy sources</h2>
            <ul>
              {report.conflicts.map((conflict) => (
                <li>{conflict}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {!!report?.stale_contexts.length && (
        <section class="panel">
          <div class="panel-body">
            <h2>Outdated local context</h2>
            <ul>
              {report.stale_contexts.map((path) => (
                <li class="file-path">{path}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {assessment?.findings.map((finding) => (
        <section class="panel" data-compatibility-finding={finding.id}>
          <div class="panel-body">
            <h2>{finding.summary}</h2>
            <p>
              {finding.records.map((id) => (
                <>
                  {context.index.byId.has(id) ? (
                    <a class="badge" href={recordURL(id)}>
                      {id}
                    </a>
                  ) : (
                    badge(id)
                  )}{" "}
                </>
              ))}
            </p>
            {markdown(finding.details, undefined, context.index.references)}
            <h3>Proposed resolution</h3>
            {markdown(finding.proposed_resolution, undefined, context.index.references)}
            {assessment.policy_digest !== report?.digest && (
              <p class="notice">
                Policies have changed since this finding was reported. Approval covers the proposal shown here; an agent
                must reassess the resulting policies.
              </p>
            )}
            {finding.decision ? (
              <p>
                {badge(
                  finding.decision.outcome === CompatibilityDecision.Approve
                    ? "Resolution approved"
                    : "Finding dismissed",
                  "approved",
                )}
              </p>
            ) : (
              <div class="actions">
                {mutationForm({
                  action: Route.PolicyResolution,
                  csrf: context.csrf,
                  context,
                  fields: {
                    policy_digest: assessment.policy_digest,
                    finding: finding.id,
                    decision: CompatibilityDecision.Approve,
                    reviewed: "yes",
                  },
                  children: () => submitButton("Approve resolution", { approve: true }),
                })}
                {mutationForm({
                  action: Route.PolicyResolution,
                  csrf: context.csrf,
                  context,
                  fields: {
                    policy_digest: assessment.policy_digest,
                    finding: finding.id,
                    decision: CompatibilityDecision.Dismiss,
                    reviewed: "yes",
                  },
                  children: () => submitButton("Dismiss finding", { approve: true }),
                })}
              </div>
            )}
          </div>
        </section>
      ))}
      {!assessment && report?.last_resolution && (
        <details class="panel">
          <summary>Last resolved incompatibilities</summary>
          <div class="panel-body">
            <ul>
              {report.last_resolution.findings.map((finding) => (
                <li>
                  <strong>{finding.summary}</strong>
                  {markdown(finding.proposed_resolution, undefined, context.index.references)}
                  {finding.decision && (
                    <p>
                      {finding.decision.outcome === CompatibilityDecision.Approve
                        ? "Resolution approved"
                        : "Finding dismissed"}{" "}
                      · <time datetime={finding.decision.reviewed_at}>{finding.decision.reviewed_at}</time>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
      {report && (
        <details class="panel">
          <summary>Applicable policies and assessment</summary>
          <div class="panel-body">
            <h2>Project policies</h2>
            <ul>
              {report.project_sources.map((source) => {
                const project = context.projects.find((project) => project.id === source.id);
                return (
                  <li>
                    <a
                      href={routeURL(Route.Records, {
                        type: "ADR",
                        ...(project ? { scope: source.id } : { collection: source.id }),
                      })}
                    >
                      {project ? projectBreadcrumb(project, context.projects) : source.id}
                    </a>
                    {project && (
                      <>
                        {" "}
                        · <a href={recordURL(source.id + ":CHARTER")}>Charter</a>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            <h2>Local collections</h2>
            <ul>
              {report.sources.map((source) => (
                <li>
                  <a href={routeURL(Route.Records, { collection: source.id, type: "ADR" })}>{source.id}</a>
                </li>
              ))}
            </ul>
            <p class="file-path">Policy fingerprint: {report.digest}</p>
            {report.status === PolicyCompatibilityState.Current && (
              <p>No incompatibilities remain in the recorded assessment.</p>
            )}
          </div>
        </details>
      )}
      <p>
        <a href={projectPath("/review")}>Review queue</a>
      </p>
    </>,
    { parents: [{ label: "Review queue", href: projectPath("/review") }] },
  );
}
