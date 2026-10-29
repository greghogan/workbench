import { recordURL, routeURL } from "./locations.js";
import { proposeReviewFormatting, applyReviewFormatting } from "../review-formatting.js";
import { join } from "node:path";
import { CompatibilityDecision } from "../policy-findings.js";
import { randomBytes } from "node:crypto";
import { CollectionOperation } from "../diagnostics.js";
import { createCharter, saveRecord } from "../record-service.js";
import { runReviewWorker } from "./review-worker.js";
import { runCollectionWorker } from "./collection-runner.js";
import type { CollectionApplication, CollectionRequest } from "./collection-service.js";
import { WebError } from "./errors.js";
import { decodeCollectionRequest, type CollectionPreview } from "./protocol.js";
import { Route, actionDefinition, queueOperations, type ActionResult } from "./routes.js";
import { changeExperimentStatus } from "../experiment-workflow.js";
import { changeTaskStatus } from "../task-service.js";
import { changeTaskQueue, type QueueChange } from "../task-queue.js";
import { taskStatuses, experimentStatuses } from "../record-document.js";
import { ReviewVersions } from "./review-versions.js";

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
  async run(path: string, form: URLSearchParams): Promise<ActionResult> {
    const definition = actionDefinition(path);
    if (!definition) throw new WebError(404, "Action not found.");
    if (this.closed) throw new WebError(503, "record operations are stopping");
    if (this.operations.size)
      throw new WebError(409, "another review or collection operation is in progress; wait for it to finish");
    const result = (redirect: string): ActionResult => ({ redirect, ...definition });
    switch (path) {
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
            resolution: { policy_digest: form.get("policy_digest") ?? "", finding: form.get("finding") ?? "", outcome },
          }),
        );
        return result(routeURL(Route.Review, { compatibility: "1" }));
      }

      case Route.FormatReview: {
        const path = form.get("path") ?? "";
        await this.operation("review", async () => {
          const proposal = await proposeReviewFormatting(this.root, path ? join(this.root, path) : undefined);
          applyReviewFormatting(this.root, proposal, form.get("expected") ?? "");
        });
        return result(routeURL(Route.Review, path ? { path } : {}));
      }
      case Route.TaskState: {
        const reference = form.get("reference") ?? "",
          expected = form.get("expected") ?? "",
          selected = form.get("state");
        if (!expected) throw new WebError(400, "Supply the reviewed record version");
        if (/:EXP-[0-9A-Z]+$/.test(reference)) {
          const state = experimentStatuses.find((state) => state === selected);
          if (!state) throw new WebError(400, "Unknown experiment state");
          changeExperimentStatus(this.root, reference, state, expected);
        } else {
          const state = taskStatuses.find((state) => state === selected);
          if (!state) throw new WebError(400, "Unknown task state");
          changeTaskStatus(this.root, reference, state, expected, true);
        }
        return result(
          selected === "Approved" || selected === "Accepted" ? Route.TaskQueue : recordURL(form.get("reference") ?? ""),
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
        else if (
          operation === "remove" ||
          operation === "start" ||
          operation === "implemented" ||
          operation === "block" ||
          operation === "release"
        )
          change = { action: operation, reference, detail: form.get("detail") ?? "" };
        else throw new WebError(400, "Unknown queue operation");
        if (!form.get("expected")) throw new WebError(400, "Supply the queue version");
        changeTaskQueue(this.root, change, form.get("expected") ?? "");
        return result(Route.TaskQueue);
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
        await this.operation("review", () =>
          this.reviewRunner({
            root: this.root,
            version: presented.version,
            digest: form.get("digest") ?? "",
            humanWritten: form.get("human_written") === "yes",
          }),
        );
        return result(Route.Review);
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
        return result(routeURL(Route.Review, { collection_applied: applied.id }));
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
