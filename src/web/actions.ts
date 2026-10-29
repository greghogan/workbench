import { randomBytes } from "node:crypto";
import { CollectionOperation } from "../diagnostics.js";
import { createCharter, saveRecord } from "../record-service.js";
import { approveReviewFiles, reviewSource } from "../review-service.js";
import { runCollectionWorker } from "./collection-runner.js";
import type { CollectionRequest } from "./collection-service.js";
import { WebError } from "./errors.js";
import { decodeCollectionRequest, type CollectionPreview } from "./protocol.js";
import { Route, actionDefinition, type ActionResult } from "./routes.js";

interface Proposal {
  request: CollectionRequest;
  plan: CollectionPreview;
  created: number;
}
/** Own admitted collection work and short-lived previews; shutdown drains work before dropping previews. */
export class WebActions {
  private readonly operations = new Set<Promise<CollectionPreview | undefined>>();
  private readonly proposals = new Map<string, Proposal>();
  constructor(
    private readonly root: string,
    private readonly runner = runCollectionWorker,
  ) {}
  get activeOperations(): number {
    return this.operations.size;
  }
  private prune() {
    for (const [key, value] of this.proposals)
      if (Date.now() - value.created > 15 * 60 * 1000) this.proposals.delete(key);
  }
  proposal(token: string): Proposal {
    this.prune();
    const saved = this.proposals.get(token);
    if (!saved) throw new WebError(409, "collection preview expired; prepare a fresh preview");
    return saved;
  }
  private async operation(mode: CollectionOperation, request: CollectionRequest, expected?: string) {
    if (this.operations.size)
      throw new WebError(409, "another collection operation is in progress; wait for it to finish");
    const work = this.runner(this.root, mode, request, expected);
    this.operations.add(work);
    try {
      return await work;
    } finally {
      this.operations.delete(work);
    }
  }
  async run(path: string, form: URLSearchParams): Promise<ActionResult> {
    const definition = actionDefinition(path);
    if (!definition) throw new WebError(404, "Action not found.");
    const result = (redirect: string): ActionResult => ({ redirect, ...definition });
    switch (path) {
      case Route.CreateCharter: {
        if (form.get("human_written") !== "yes") throw new WebError(400, "confirm that you wrote the charter text");
        const id = createCharter(this.root, form.get("project") ?? "", form.get("contents") ?? "");
        return result(`/record?id=${encodeURIComponent(id)}&saved=1`);
      }
      case Route.Save: {
        const id = form.get("id") ?? "";
        if (!id || !form.has("expected") || !form.has("contents"))
          throw new WebError(400, "select a record and supply its expected version and contents");
        saveRecord(this.root, id, form.get("expected") ?? "", form.get("contents") ?? "");
        return result(`/record?id=${encodeURIComponent(id)}&saved=1`);
      }
      case Route.Approve: {
        if (form.get("reviewed") !== "yes") throw new WebError(400, "explicit human review confirmation is required");
        if (!form.get("path") || !form.get("digest"))
          throw new WebError(400, "select a file version and its review digest");
        approveReviewFiles(
          this.root,
          [{ path: form.get("path") ?? "", digest: form.get("digest") ?? "" }],
          form.get("human_written") === "yes",
          reviewSource(form.get("review_source")),
        );
        const destination = new URLSearchParams();
        if (form.get("record_all") === "1") destination.set("all", "1");
        else if (form.get("record_source")) destination.set("collection", form.get("record_source") ?? "");
        else if (form.get("record_scope")) destination.set("scope", form.get("record_scope") ?? "");
        return result(destination.size ? `/review?${destination.toString()}` : Route.Review);
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
        const plan = await this.operation(CollectionOperation.Preview, request);
        if (!plan) throw new Error("collection preview was not produced");
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
        await this.operation(CollectionOperation.Apply, saved.request, saved.plan.digest);
        this.proposals.delete(token);
        return result(
          form.get("record_source")
            ? `/collections?collection=${encodeURIComponent(form.get("record_source") ?? "")}`
            : Route.Collections,
        );
      }
      default:
        throw new WebError(404, "Action not found.");
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.operations]);
    this.proposals.clear();
  }
}
