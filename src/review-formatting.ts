import { recordOwnerPath } from "./staged-records.js";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { readFileSync } from "node:fs";
import { formatDocument } from "./formatting.js";
import { proposedReview, ReviewSource } from "./review-service.js";
import { readProjects, readConfig } from "./project-configuration.js";
import { readBoundedFile } from "./file-reads.js";
import { ProjectEdits } from "./project-edits.js";
import { StateConflict } from "./input-errors.js";
import { syncMaps } from "./maps.js";
import { syncAgents } from "./agents.js";

export interface ReviewFormatting {
  digest: string;
  remaining: boolean;
  files: { path: string; original: string; formatted: string; mode: "100644" | "100755" }[];
}
/** Only record sources are reformatted; retained experimental captures and other sidecars keep their bytes. */
export async function proposeReviewFormatting(root: string, selected?: string): Promise<ReviewFormatting> {
  const width = readConfig(root).markdown?.wrap_width ?? 120;
  const source = selected ? relative(root, selected).replaceAll("\\", "/") : undefined;
  const scopes = readProjects(root).map((project) => project.path);
  const collections = (readConfig(root).collections?.sources ?? []).map((source) => source.id);
  const changes = proposedReview(root, ReviewSource.Working).changes.filter(
    (change) =>
      !change.after.startsWith("000000:") &&
      (!source || source === change.path) &&
      recordOwnerPath(change.path, scopes, collections) === change.path,
  );
  const formatter = new ReviewFormatter();
  const results = new Map<string, FormattingResult>();
  const originals = new Map<string, Buffer>();
  for (const change of changes) {
    const path = join(root, change.path);
    const raw = readBoundedFile(path, 2 * 1024 * 1024, "record formatting");
    originals.set(change.path, raw);
    results.set(
      change.path,
      await formatter.prepare(change.path, raw, change.after.startsWith("100755:") ? "100755" : "100644", width),
    );
  }
  return formattingProposal(width, results, (path) => originals.get(path));
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
  | { state: "current" }
  | { state: "changed"; input: string; file: Omit<ReviewFormatting["files"][number], "original"> }
  | { state: "unavailable"; problem: string };

/** Formatting consumes captured bytes; its bounded cache belongs to one operation or read worker. */
export class ReviewFormatter {
  private readonly cache = new Map<string, { key: string; result: FormattingResult; bytes: number }>();
  private bytes = 0;
  async prepare(path: string, raw: Buffer, mode: "100644" | "100755", width: number): Promise<FormattingResult> {
    const key = createHash("sha256")
      .update(JSON.stringify([width, mode]))
      .update(raw)
      .digest("hex");
    const saved = this.cache.get(path);
    if (saved?.key === key) return saved.result;
    let result: FormattingResult;
    try {
      if (raw.length > 2 * 1024 * 1024) throw new Error("record formatting exceeds its size limit");
      if (!isUtf8(raw)) throw new Error("record formatting requires valid UTF-8; the file is unchanged");
      const original = raw.toString("utf8");
      const formatted = await formatDocument(original, path, width);
      result =
        original === formatted
          ? { state: "current" }
          : {
              state: "changed",
              input: createHash("sha256").update(raw).digest("hex"),
              file: { path, formatted, mode },
            };
    } catch (error) {
      result = { state: "unavailable", problem: error instanceof Error ? error.message : String(error) };
    }
    if (saved) {
      this.bytes -= saved.bytes;
      this.cache.delete(path);
    }
    const bytes =
      256 +
      2 *
        (path.length +
          key.length +
          (result.state === "changed"
            ? result.file.formatted.length + result.input.length
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
      this.cache.set(path, { key, result, bytes });
      this.bytes += bytes;
    }
    return result;
  }
}

export function formattingProposal(
  width: number,
  results: Map<string, FormattingResult>,
  contents: (path: string) => Buffer | undefined,
  selected?: string,
): ReviewFormatting {
  const files: ReviewFormatting["files"] = [];
  let bytes = 0,
    remaining = false;
  for (const [path, result] of results) {
    if (selected && path !== selected) continue;
    if (result.state === "unavailable") throw new FormattingProblem(path, result.problem);
    if (result.state !== "changed") continue;
    const raw = contents(path);
    if (!raw || createHash("sha256").update(raw).digest("hex") !== result.input)
      throw new StateConflict(`${path}: formatting contents changed; refresh before reviewing`);
    const file = { ...result.file, original: raw.toString("utf8") };
    const size = Buffer.byteLength(file.original) + Buffer.byteLength(file.formatted);
    if (size > 16 * 1024 * 1024) throw new Error(`${path}: formatting preview exceeds its size limit`);
    if (files.length >= 100 || bytes + size > 16 * 1024 * 1024) {
      remaining = true;
      break;
    }
    bytes += size;
    files.push(file);
  }
  return {
    files,
    remaining,
    digest: createHash("sha256")
      .update(JSON.stringify([width, files]))
      .digest("hex"),
  };
}

export function applyReviewFormatting(root: string, proposal: ReviewFormatting, expected: string): void {
  if (proposal.digest !== expected || !proposal.files.length)
    throw new StateConflict("Formatting proposal changed; reload and review it again");
  const edits = new ProjectEdits(root);
  for (const file of proposal.files) {
    if (readFileSync(join(root, file.path), "utf8") !== file.original)
      throw new StateConflict(`${file.path} changed while formatting was reviewed; reload before applying`);
    edits.write(file.path, file.formatted);
    if (edits.files.get(file.path)?.previous?.toString("utf8") !== file.original)
      throw new StateConflict(`${file.path} changed while formatting was reviewed`);
  }
  edits.apply();
  syncMaps(root);
  syncAgents(root);
}
