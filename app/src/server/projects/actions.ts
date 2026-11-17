import { cancelPlan, deletePlan } from "../../core/tasks/planning/plan-disposition.js";
import { applyTaskDisposition } from "../../core/tasks/task-disposition.js";
import { committedReview } from "../../core/review/review-units.js";
import { renamePlan } from "../../core/tasks/planning/plan-rename.js";
import { changeWorkQueue } from "../../core/tasks/planning/plan-transfer.js";
import { planIdentity, parsePlanReference } from "../../core/tasks/planning/plan-model.js";
import { savePlanDraft, approvePlanDraft } from "../../core/tasks/planning/planning-operations.js";
import { readPlan } from "../../core/tasks/planning/planning-store.js";
import { readWorkGraph } from "../../core/tasks/planning/work-plans.js";
import { taskPhase, TaskPhase } from "../../core/tasks/task-workflow.js";
import { StateConflict } from "../../core/runtime/input-errors.js";
import { recordURL, routeURL } from "../routes/locations.js";
import { CompatibilityDecision } from "../../core/collections/policy-findings.js";
import { randomBytes } from "node:crypto";
import { CollectionOperation, WebAction } from "../../core/diagnostics/diagnostics.mjs";
import { createCharter, saveRecord } from "../../core/records/record-service.js";
import { runReviewWorker } from "../review/review-worker.js";
import { runCollectionWorker } from "./collection-runner.js";
import type { CollectionApplication, CollectionRequest } from "./collection-service.js";
import { WebError } from "../http/errors.js";
import { decodeCollectionRequest, type CollectionPreview } from "./protocol.js";
import { Route, actionDefinition, queueOperations, type ActionResult } from "../routes/routes.js";
import type { ReviewTarget } from "../review/review-request.js";
import { readTaskQueue, type QueueChange } from "../../core/tasks/task-queue.js";
import { taskStatuses } from "../../core/records/record-document.js";
import { ReviewVersions } from "../review/review-versions.js";

interface Proposal {
  request: CollectionRequest;
  plan: CollectionPreview;
  created: number;
}
/** Own admitted review and collection work and short-lived previews; shutdown drains work before dropping previews. */
export class WebActions {
  readonly reviews = new ReviewVersions();
  private readonly operations = new Map<Promise<unknown>, "review" | "collection">();
  private closed = false;
  private readonly applications = new Map<string, CollectionApplication>();
  application(id: string): CollectionApplication | undefined {
    return this.applications.get(id);
  }
  private readonly proposals = new Map<string, Proposal>();
  constructor(
    private readonly root: string,
    private readonly runner: typeof runCollectionWorker = (root, operation, request, expected) =>
      runCollectionWorker(root, operation, request, expected, bundle),
    private readonly reviewRunner: typeof runReviewWorker = (request) => runReviewWorker(request, bundle),
    bundle?: string,
  ) {}
  get activeOperations(): number {
    return this.operations.size;
  }
  get activeCollections(): number {
    return [...this.operations.values()].filter((kind) => kind === "collection").length;
  }
  private prune() {
    for (const [key, value] of this.proposals)
      if (Date.now() - value.created > 15 * 60 * 1000) this.proposals.delete(key);
  }
  proposal(token: string): Proposal {
    this.prune();
    const saved = this.proposals.get(token);
    if (!saved)
      throw new WebError(409, "Collection preview expired; prepare a fresh preview", {
        recovery: { href: routeURL(Route.Collections, {}), label: "Return to collections" },
      });
    return saved;
  }
  private async operation<T>(kind: "review" | "collection", start: () => Promise<T>): Promise<T> {
    const work = start();
    this.operations.set(work, kind);
    try {
      return await work;
    } finally {
      this.operations.delete(work);
    }
  }
  async run(path: string, form: URLSearchParams, preparation?: ReviewTarget): Promise<ActionResult> {
    const definition = actionDefinition(path);
    if (!definition) throw new WebError(404, "Action not found.");
    if (this.closed) throw new WebError(503, "record operations are stopping");
    if (this.operations.size)
      throw new WebError(409, "another review or collection operation is in progress; wait for it to finish");
    const result = (redirect: string): ActionResult => ({ redirect, ...definition });
    switch (path) {
      case Route.ReviewPrepare: {
        if (!preparation) throw new WebError(400, "resolve a record before preparing review");
        await this.operation("review", () =>
          this.reviewRunner({
            root: this.root,
            operation: WebAction.ReviewPrepare,
            path: preparation.path,
            ...(preparation.task ? { task: preparation.task } : {}),
          }),
        );
        if (preparation.task)
          return result(
            recordURL(preparation.task.reference, {
              layout: preparation.layout,
              ...(preparation.workflow ? { workflow: preparation.workflow } : {}),
              ...(preparation.recordView ? { view: preparation.recordView } : {}),
            }),
          );
        return {
          ...result(
            routeURL(Route.Review, {
              path: preparation.path,
              layout: preparation.layout,
              ...(preparation.view ? { view: preparation.view } : {}),
            }),
          ),
          reviewTarget: preparation,
        };
      }
      case Route.PolicyResolution: {
        const outcome = Object.values(CompatibilityDecision).find((value) => value === form.get("decision"));
        if (
          !outcome ||
          form.get("reviewed") !== "yes" ||
          !/^[a-f0-9]{64}$/.test(form.get("policy_digest") ?? "") ||
          !/^[a-f0-9]{64}$/.test(form.get("finding") ?? "")
        )
          throw new WebError(400, "Select the exact compatibility finding and its review decision");
        await this.operation("review", () =>
          this.reviewRunner({
            root: this.root,
            operation: WebAction.PolicyResolution,
            policyDigest: form.get("policy_digest") ?? "",
            finding: form.get("finding") ?? "",
            outcome,
          }),
        );
        return result(routeURL(Route.Review, { compatibility: "1" }));
      }

      case Route.PlanCancel:
        cancelPlan(
          this.root,
          parsePlanReference(form.get("reference") ?? ""),
          form.get("expected") ?? "",
          form.get("reason") ?? "",
        );
        return result(routeURL(Route.Plan, { id: form.get("reference") ?? "" }));
      case Route.PlanDelete: {
        const identity = parsePlanReference(form.get("reference") ?? ""),
          plan = readPlan(this.root, identity);
        deletePlan(this.root, identity, form.get("expected") ?? "");
        return result(
          plan.document?.metadata.status === "Approved" && plan.approval?.current ? Route.Work : Route.Plans,
        );
      }
      case Route.TaskDisposition: {
        const kind = form.get("kind");
        if (kind !== "delete" && kind !== "revert") throw new WebError(400, "Select deletion or reversion");
        const reference = form.get("reference") ?? "",
          task = readWorkGraph(this.root).require(reference),
          phase = taskPhase(
            task,
            readTaskQueue(this.root).entries.find((entry) => entry.reference === reference),
          );
        applyTaskDisposition(this.root, {
          reference: form.get("reference") ?? "",
          kind,
          reason: form.get("reason") ?? "",
          expected: form.get("expected") ?? "",
        });
        return result(
          kind === "revert"
            ? recordURL(reference, { workflow: "1" })
            : phase === TaskPhase.Plans
              ? Route.Plans
              : phase === TaskPhase.Work
                ? Route.Work
                : phase === TaskPhase.Reviews
                  ? Route.Reviews
                  : routeURL(Route.Records, { type: "TSK" }),
        );
      }
      case Route.PlanRename: {
        const identity = parsePlanReference(form.get("reference") ?? ""),
          target = planIdentity(identity.scope, form.get("name") ?? "");
        renamePlan(this.root, identity, target, form.get("expected") ?? "");
        return result(routeURL(Route.Plan, { id: target.reference, scope: target.scope }));
      }
      case Route.PlanSave:
      case Route.PlanApprove: {
        const identity = parsePlanReference(form.get("reference") ?? ""),
          expected = form.get("expected") ?? "";
        if (!expected) throw new WebError(400, "Supply the inspected plan version");
        if (path === Route.PlanSave) savePlanDraft(this.root, identity, form.get("contents") ?? "", { expected });
        else {
          approvePlanDraft(this.root, identity, expected, true);
          return result(Route.Work);
        }
        return result(routeURL(Route.Plan, { id: identity.reference, scope: identity.scope }));
      }

      case Route.TaskState: {
        const reference = form.get("reference") ?? "",
          expected = form.get("expected") ?? "",
          selected = form.get("state");
        if (!expected) throw new WebError(400, "Supply the reviewed record version");
        const state = taskStatuses.find((state) => state === selected);
        if (!state) throw new WebError(400, "Unknown task state");
        await this.operation("review", () =>
          this.reviewRunner({
            root: this.root,
            operation: WebAction.Task,
            reference,
            expected,
            state,
            reason: form.get("reason") ?? "",
          }),
        );
        return result(
          selected === "Approved"
            ? Route.Work
            : selected === "Accepted"
              ? Route.Reviews
              : recordURL(form.get("reference") ?? ""),
        );
      }
      case Route.QueueChange: {
        const operation = queueOperations.find((operation) => operation === form.get("operation")),
          reference = form.get("reference") ?? "",
          target = form.get("target") ?? "";
        let change: QueueChange;
        if (operation === "add") change = { action: "add", references: [reference] };
        else if (operation === "move-before") change = { action: "move", reference, before: target };
        else if (operation === "move-after") change = { action: "move", reference, after: target };
        else if (operation === "remove") change = { action: "remove", reference };
        else throw new WebError(400, "Unknown queue operation");
        if (!form.get("expected")) throw new WebError(400, "Supply the queue version");
        await changeWorkQueue(this.root, change, form.get("expected") ?? "");
        return result(Route.Work);
      }
      case Route.CreateCharter: {
        if (form.get("human_written") !== "yes") throw new WebError(400, "confirm that you wrote the charter text");
        const id = createCharter(this.root, form.get("project") ?? "", form.get("contents") ?? "");
        return result(recordURL(id, { saved: "1" }));
      }
      case Route.Save: {
        const id = form.get("id") ?? "";
        if (!id || !form.has("expected") || !form.has("contents"))
          throw new WebError(400, "select a record and supply its expected version and contents");
        saveRecord(this.root, id, form.get("expected") ?? "", form.get("contents") ?? "");
        return result(recordURL(id, { saved: "1" }));
      }
      case Route.Approve: {
        if (form.get("reviewed") !== "yes") throw new WebError(400, "explicit human review confirmation is required");
        if (!form.get("path") || !form.get("digest"))
          throw new WebError(400, "select a file version and its review digest");
        const presented = this.reviews.get(
          form.get("path") ?? "",
          form.get("digest") ?? "",
          form.get("review_layout") === "split" ? "split" : "unified",
        );
        const commit = form.get("review_commit");
        if (
          commit &&
          !committedReview(this.root, commit).changes.some(
            (change) =>
              change.path === presented.version.change.path &&
              change.after === presented.version.change.after &&
              change.before === presented.version.change.before,
          )
        )
          throw new StateConflict("The selected commit does not contain this reviewed version");
        await this.operation("review", () =>
          this.reviewRunner({
            root: this.root,
            operation: WebAction.Review,
            version: presented.version,
            digest: form.get("digest") ?? "",
            humanWritten: form.get("human_written") === "yes",
          }),
        );
        if (commit) return result(routeURL(Route.History, { commit }));
        return result(Route.Reviews);
      }
      case Route.Preview: {
        const id = form.get("id");
        const request = decodeCollectionRequest({
          source: form.get("source") ?? "",
          commit: form.get("commit") ?? "",
          collection: form.get("collection") ?? ".",
          visibility: form.get("visibility"),
          ...(id ? { id } : {}),
        });
        if (
          process.env.WORKBENCH_DEMONSTRATION_ROOT === this.root &&
          (request.source !== process.env.WORKBENCH_DEMONSTRATION_SOURCE ||
            request.commit !== process.env.WORKBENCH_DEMONSTRATION_COMMIT)
        )
          throw new WebError(400, "The demonstration only acquires its bundled offline collection");
        const plan = await this.operation("collection", () =>
          this.runner(this.root, CollectionOperation.Preview, request, undefined),
        );
        if (!plan || !("digest" in plan)) throw new Error("collection preview was not produced");
        if (Buffer.byteLength(JSON.stringify(plan)) > 8 * 1024 * 1024)
          throw new WebError(413, "collection preview exceeds 8 MiB; inspect it using the CLI");
        this.prune();
        const token = randomBytes(24).toString("hex");
        if (this.proposals.size >= 8) {
          const oldest = this.proposals.keys().next().value;
          if (oldest) this.proposals.delete(oldest);
        }
        this.proposals.set(token, { request, plan, created: Date.now() });
        return result(
          `/collection-proposal?token=${token}${form.get("record_source") ? `&collection=${encodeURIComponent(form.get("record_source") ?? "")}` : ""}`,
        );
      }
      case Route.Apply: {
        if (form.get("reviewed") !== "yes")
          throw new WebError(400, "explicit human approval of the collection proposal is required");
        const token = form.get("token") ?? "",
          saved = this.proposal(token);
        const choice = form.get("accept_all");
        if (choice !== null && choice !== "yes" && choice !== "no")
          throw new WebError(400, "Unknown collection acceptance choice");
        if (choice === "yes" && saved.request.id)
          throw new WebError(400, "Review adaptations when updating an existing collection");
        const applied = await this.operation("collection", () =>
          this.runner(
            this.root,
            CollectionOperation.Apply,
            { ...saved.request, ...(choice === "yes" ? { acceptAll: true } : {}) },
            saved.plan.digest,
          ),
        );
        if (!applied || !("issues" in applied) || applied.id !== saved.plan.pin.id)
          throw new Error("Collection application result is unavailable; inspect the current project files");
        if (this.applications.size >= 16) {
          const oldest = this.applications.keys().next().value;
          if (oldest) this.applications.delete(oldest);
        }
        this.applications.set(applied.id, applied);
        this.proposals.delete(token);
        return result(routeURL(Route.Reviews, { collection_applied: applied.id }));
      }
      default:
        throw new WebError(404, "Action not found.");
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.operations.keys()]);
    this.reviews.clear();
    this.proposals.clear();
    this.applications.clear();
  }
}
