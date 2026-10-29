import type { WorkspaceSnapshot } from "../workspace-service.js";
import { workspaceSnapshotBytes } from "../workspace-service.js";
import { recordOwnerPath } from "../staged-records.js";
import { createHash } from "node:crypto";
import { ReviewFormatter, formattingProposal, type FormattingResult } from "../review-formatting.js";

/** A published workspace carries formatting decisions for its exact captured review versions. */
export async function prepareWorkspaceFormatting(
  snapshot: WorkspaceSnapshot,
  formatter: ReviewFormatter,
): Promise<WorkspaceSnapshot> {
  const scopes = snapshot.projects.map((project) => project.path);
  const collections = snapshot.collections.map((collection) => collection.pin.id);
  const results = new Map<string, FormattingResult>();
  for (const change of snapshot.review.changes) {
    if (change.after.startsWith("000000:") || recordOwnerPath(change.path, scopes, collections) !== change.path)
      continue;
    const captured = snapshot.reviewDocuments.get(change.digest);
    if (captured?.error) {
      results.set(change.path, { state: "unavailable", problem: captured.error });
      continue;
    }
    const encoded = captured?.after;
    if (typeof encoded !== "string") {
      results.set(change.path, { state: "unavailable", problem: "record contents are unavailable" });
      continue;
    }
    const result = await formatter.prepare(
      change.path,
      Buffer.from(encoded, "base64"),
      change.after.startsWith("100755:") ? "100755" : "100644",
      snapshot.formatting.width,
    );
    if (result.state !== "current") results.set(change.path, result);
  }
  const publication = {
    ...snapshot,
    formatting: { ...snapshot.formatting, results },
    revision: createHash("sha256")
      .update(snapshot.revision)
      .update(JSON.stringify([...results]))
      .digest("hex"),
  };
  if (workspaceSnapshotBytes(publication) > 64 * 1024 * 1024)
    throw new Error("workspace browser snapshot exceeds 64 MiB; use the CLI for this workspace");
  return publication;
}
export function workspaceFormattingProposal(snapshot: WorkspaceSnapshot, selected?: string) {
  return formattingProposal(
    snapshot.formatting.width,
    snapshot.formatting.results,
    (path) => {
      const change = snapshot.review.changes.find((change) => change.path === path);
      const encoded = change && snapshot.reviewDocuments.get(change.digest)?.after;
      return typeof encoded === "string" ? Buffer.from(encoded, "base64") : undefined;
    },
    selected,
  );
}
