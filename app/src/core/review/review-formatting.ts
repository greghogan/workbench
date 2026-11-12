import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
import { pendingRecordOutputs, ReviewPreparation } from "./review-preparation-state.js";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { readConfig, readProjects } from "../projects/project-configuration.js";
import { ProjectEdits } from "../projects/project-edits.js";
import { formatDocument } from "../records/formatting.js";
import { syncRecordOutputs } from "../records/record-outputs.js";
import { classifyRecordPath, recordOwnerPath } from "../records/staged-records.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { InvalidInput, MissingResource, StateConflict } from "../runtime/input-errors.js";
import { reviewFileLimit } from "./review-snapshot.js";
import { proposedReview, ReviewSource } from "./review-service.js";

/** Format real record files, then repair only the generated outputs depending on those records. */
export async function formatPendingReviews(root: string, selected?: string): Promise<void> {
  const config = readConfig(root);
  const width = config.markdown?.wrap_width ?? 120;
  const scopes = readProjects(root).map((project) => project.path);
  const collections = (config.collections?.sources ?? []).map((source) => source.id);
  const changes = proposedReview(root, ReviewSource.Working).changes;
  const source = selected === undefined ? undefined : relative(root, selected).replaceAll("\\", "/");
  if (source !== undefined) {
    const classification = classifyRecordPath(source, scopes, collections);
    const primary = recordOwnerPath(source, scopes, collections) === source;
    const owned = classification.protected && primary;
    const deleted = primary && changes.some((change) => change.path === source && change.after.startsWith("000000:"));
    if (!owned && !deleted) throw new InvalidInput("select a protected record for review preparation");
    if (!existsSync(join(root, source)) && !deleted)
      throw new MissingResource("protected record not found; refresh the review queue");
  }
  const paths = source
    ? [source]
    : [
        ...new Set([
          ...changes
            .filter((change) => recordOwnerPath(change.path, scopes, collections) === change.path)
            .map((change) => change.path),
          ...pendingRecordOutputs(root),
        ]),
      ];
  const formatter = new ReviewFormatter();
  const preparation = new ReviewPreparation(root);
  const affected = new Set<string>();
  let batch: { path: string; original: Buffer; formatted: string }[] = [];
  let bytes = 0;
  const repairOutputs = (paths: string[]) => {
    try {
      syncRecordOutputs(root, paths);
    } catch (cause) {
      throw new StateConflict(
        "Generated record outputs could not be updated. Formatting already saved is preserved. Retry review preparation or run 'workbench sync'.",
        { cause },
      );
    }
  };
  const publish = () => {
    if (!batch.length) return;
    const edits = new ProjectEdits(root);
    const paths = batch.map((file) => file.path);
    preparation.mark(paths);
    for (const path of paths) affected.add(path);
    for (const file of batch) {
      if (file.original.toString("utf8") === file.formatted) continue;
      edits.replace(file.path, file.original, file.formatted);
    }
    edits.apply();
    batch = [];
    bytes = 0;
  };
  let failure: Error | undefined;
  try {
    for (const path of paths) {
      if (!existsSync(join(root, path))) {
        preparation.mark([path]);
        affected.add(path);
        continue;
      }
      const raw = readBoundedFile(join(root, path), reviewFileLimit, "record formatting");
      const result = await formatter.prepare(path, raw, width);
      if (result.state === "unavailable") throw new FormattingProblem(path, result.problem);
      const formatted = result.state === "changed" ? result.formatted : raw.toString("utf8");
      const size = raw.length + Buffer.byteLength(formatted);
      if (size > 16 * 1024 * 1024) throw new FormattingProblem(path, "formatted record exceeds its preparation limit");
      if (batch.length >= 100 || bytes + size > 16 * 1024 * 1024) publish();
      batch.push({ path, original: raw, formatted });
      bytes += size;
    }
    publish();
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Review formatting failed", { cause: error });
  }
  try {
    if (affected.size) {
      repairOutputs([...affected]);
      preparation.complete();
    }
  } catch (error) {
    if (failure !== undefined) throw combineFailures(failure, error, "Review formatting and output repair failed");
    throw error;
  }
  if (failure !== undefined) throw failure;
}

export class FormattingProblem extends StateConflict {
  constructor(
    readonly path: string,
    problem: string,
  ) {
    super(`${path}: ${problem}. Edit the file and refresh before reviewing`);
  }
}
export type FormattingResult =
  { state: "current" } | { state: "changed"; formatted: string } | { state: "unavailable"; problem: string };

/** Formatting consumes captured bytes; its bounded cache belongs to one operation or read worker. */
export class ReviewFormatter {
  private readonly cache = new Map<string, { key: string; result: FormattingResult; bytes: number }>();
  private bytes = 0;
  async prepare(path: string, raw: Buffer, width: number): Promise<FormattingResult> {
    const key = createHash("sha256")
      .update(JSON.stringify([width]))
      .update(raw)
      .digest("hex");
    const cacheKey = `${path}:${key}`;
    const saved = this.cache.get(cacheKey);
    if (saved?.key === key) return saved.result;
    let result: FormattingResult;
    try {
      if (raw.length > reviewFileLimit) throw new Error("record formatting exceeds its size limit");
      if (!isUtf8(raw)) throw new Error("record formatting requires valid UTF-8; the file is unchanged");
      const original = raw.toString("utf8");
      const formatted = await formatDocument(original, path, width);
      result =
        original === formatted
          ? { state: "current" }
          : {
              state: "changed",
              formatted,
            };
    } catch (error) {
      result = { state: "unavailable", problem: error instanceof Error ? error.message : String(error) };
    }
    if (saved) {
      this.bytes -= saved.bytes;
      this.cache.delete(cacheKey);
    }
    const bytes =
      256 +
      2 *
        (path.length +
          key.length +
          (result.state === "changed"
            ? result.formatted.length
            : result.state === "unavailable"
              ? result.problem.length
              : 0));
    if (result.state !== "unavailable" && bytes <= 16 * 1024 * 1024) {
      while (this.cache.size >= 256 || this.bytes + bytes > 16 * 1024 * 1024) {
        const oldest = this.cache.entries().next().value;
        if (!oldest) break;
        this.cache.delete(oldest[0]);
        this.bytes -= oldest[1].bytes;
      }
      this.cache.set(cacheKey, { key, result, bytes });
      this.bytes += bytes;
    }
    return result;
  }
}
