import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizedNumber, relativeRecordPath, writeAtomic } from "./core.js";
import { ownedPath } from "./paths.js";
import { withCacheLockSync } from "./cache-lock.js";
import {
  inspectCollection,
  registryPins,
  selectInstalledCollections,
  storeCollection,
  writeCollectionManifest,
} from "./collections.js";
import { collectionName, validateCollectionPins, type CollectionPin } from "./collection-schema.js";
import {
  authoritativeFiles,
  bytesHash,
  collectionWorkingFiles,
  mergeCollectionFiles,
  collectionFilesHash,
} from "./collection-files.js";
import { readDecision } from "./decision-record.js";
import { renderCollectionMap } from "./collection-maps.js";
import { syncLocalContext } from "./local-context.js";

interface Upstream {
  source: string;
  pin: CollectionPin;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function draftPath(base: string, id: string): string {
  if (!collectionName.test(id)) throw new Error("invalid local collection identity");
  return ownedPath(base, `.drafts/${id}`);
}
function upstreamAt(base: string, pin: CollectionPin): string {
  return ownedPath(base, `.originals/${pin.id}/${pin.revision}`);
}
function upstreamDraft(base: string, id: string): Upstream {
  const value = JSON.parse(readFileSync(join(draftPath(base, id), "upstream.json"), "utf8")) as Upstream;
  validateCollectionPins([value.pin], "local collection draft");
  if (value.pin.id !== id || typeof value.source !== "string")
    throw new Error("invalid local collection draft provenance");
  return value;
}
function writeFiles(directory: string, files: Map<string, Buffer>): void {
  for (const [name, bytes] of files) {
    const path = ownedPath(directory, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
}

/** Updates only the editable candidate; the previously approved selection stays active. */
export function prepareLocalPolicy(base: string, source: string, expected: string, resolved?: string): CollectionPin {
  return withCacheLockSync(join(base, ".policy"), () => {
    const pin = storeCollection(source, expected, join(base, ".originals"));
    const incoming = authoritativeFiles(inspectCollection(upstreamAt(base, pin), pin).files);
    const draft = draftPath(base, pin.id);
    if (existsSync(join(draft, "remove.json")))
      throw new Error("removal is pending; cancel it before preparing an update");
    const previous = existsSync(join(draft, "upstream.json")) ? upstreamDraft(base, pin.id) : undefined;
    const active = registryPins(base).find((entry) => entry.id === pin.id);
    const baseline = previous
      ? authoritativeFiles(inspectCollection(upstreamAt(base, previous.pin), previous.pin).files)
      : active
        ? authoritativeFiles(inspectCollection(ownedPath(base, `${active.id}/${active.revision}`), active).files)
        : new Map<string, Buffer>();
    const local = existsSync(join(draft, "workbench"))
      ? authoritativeFiles(collectionWorkingFiles(join(draft, "workbench")))
      : active
        ? authoritativeFiles(inspectCollection(ownedPath(base, `${active.id}/${active.revision}`), active).files)
        : baseline;
    const temporary = mkdtempSync(join(tmpdir(), "workbench-local-merge-"));
    let preparation: string | undefined;
    try {
      let selected: Map<string, Buffer>;
      if (resolved) {
        const report = JSON.parse(readFileSync(join(resolve(resolved), "../conflicts.json"), "utf8")) as {
          before: string | null;
          after: string;
          local: string;
        };
        if (
          report.before !== (previous?.pin.sha256 ?? null) ||
          report.after !== pin.sha256 ||
          report.local !== collectionFilesHash(local)
        )
          throw new Error("local resolution is stale; preserve it and prepare a new update");
        selected = authoritativeFiles(collectionWorkingFiles(resolve(resolved)));
      } else {
        const merged = mergeCollectionFiles(baseline, local, incoming, temporary);
        if (merged.conflicts.length) {
          const proposal = ownedPath(base, `.proposals/${randomUUID()}`);
          writeFiles(
            join(proposal, "resolved"),
            new Map([...merged.proposed].map(([name, bytes]) => [name.slice("workbench/".length), bytes])),
          );
          writeAtomic(
            join(proposal, "conflicts.json"),
            JSON.stringify(
              {
                before: previous?.pin.sha256 ?? null,
                after: pin.sha256,
                local: collectionFilesHash(local),
                conflicts: merged.conflicts,
              },
              null,
              2,
            ),
          );
          throw new Error(
            `local collection conflicts; drafts and active policy are unchanged. Resolve ${proposal}/resolved and repeat with --resolved.`,
          );
        }
        selected = merged.proposed;
      }
      if ([...selected.values()].some((bytes) => /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(bytes.toString("utf8"))))
        throw new Error("local resolution still contains merge markers");
      mkdirSync(dirname(draft), { recursive: true, mode: 0o700 });
      const candidate = ownedPath(base, `.drafts/.${pin.id}.${randomUUID()}.pending`);
      preparation = candidate;
      writeFiles(candidate, selected);
      writeAtomic(join(candidate, "upstream.json"), JSON.stringify({ source: resolve(source), pin }, null, 2));
      // Validate the complete candidate before replacing the editable working copy.
      snapshotCandidate(candidate, pin);
      mkdirSync(dirname(draft), { recursive: true, mode: 0o700 });
      const backup = `${draft}.${randomUUID()}.previous`;
      if (existsSync(draft)) renameSync(draft, backup);
      try {
        renameSync(candidate, draft);
      } catch (error) {
        if (existsSync(backup)) renameSync(backup, draft);
        throw error;
      }
      if (existsSync(backup)) rmSync(backup, { recursive: true });
      syncLocalContext(base);
      return pin;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      if (preparation) rmSync(preparation, { recursive: true, force: true });
    }
  });
}

/** Regenerate the map and manifest from edited records, including added and removed ADRs. */
function snapshotCandidate(directory: string, upstream: CollectionPin): CollectionPin {
  const files = authoritativeFiles(collectionWorkingFiles(join(directory, "workbench")));
  const decisions = [...files.keys()]
    .flatMap((name) => {
      const match = /\/ADR-([0-9A-Z]+)\.md$/.exec(name);
      if (!match?.[1]) return [];
      const number = normalizedNumber(match[1]);
      if (name !== `workbench/${relativeRecordPath("ADR", number).replaceAll("\\", "/")}`)
        throw new Error("noncanonical local ADR path");
      return [number];
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!decisions.length || new Set(decisions).size !== decisions.length)
    throw new Error("local collection needs distinct nonempty decisions");
  const project = { id: upstream.id, path: "." };
  writeAtomic(
    join(directory, "workbench/decision-map.md"),
    renderCollectionMap(
      decisions.map((number) =>
        readDecision(project, number, join(directory, "workbench", relativeRecordPath("ADR", number))),
      ),
    ),
  );
  const pin = writeCollectionManifest(directory, {
    id: upstream.id,
    revision: collectionFilesHash(files),
    visibility: upstream.visibility,
    decisions,
  });
  const verified = authoritativeFiles(inspectCollection(directory, pin).files);
  if (verified.size !== files.size || [...files.keys()].some((name) => !verified.has(name)))
    throw new Error("local drafts may contain only the collection charter, ADRs and their supporting files");
  return pin;
}

function candidateReview(base: string, id: string) {
  const active = registryPins(base);
  const previous = active.find((pin) => pin.id === id);
  const draft = draftPath(base, id);
  const removing = existsSync(join(draft, "remove.json"));
  if (removing && !previous) throw new Error("local collection is no longer active");
  const upstream = removing ? undefined : upstreamDraft(base, id);
  const temporary = mkdtempSync(join(tmpdir(), "workbench-local-review-"));
  try {
    let candidate: CollectionPin | undefined;
    if (upstream) {
      writeFiles(temporary, authoritativeFiles(collectionWorkingFiles(join(draft, "workbench"))));
      candidate = snapshotCandidate(temporary, upstream.pin);
    }
    const before = previous
      ? authoritativeFiles(inspectCollection(ownedPath(base, `${previous.id}/${previous.revision}`), previous).files)
      : new Map<string, Buffer>();
    const after = candidate
      ? authoritativeFiles(inspectCollection(temporary, candidate).files)
      : new Map<string, Buffer>();
    const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
      const a = before.get(path),
        b = after.get(path);
      if (bytesHash(a) === bytesHash(b)) return [];
      return [
        {
          path,
          before_sha256: bytesHash(a),
          after_sha256: bytesHash(b),
          before: a && !a.includes(0) ? a.toString("utf8") : undefined,
          after: b && !b.includes(0) ? b.toString("utf8") : undefined,
        },
      ];
    });
    return {
      id,
      draft: join(draft, "workbench"),
      digest: hash({ active, upstream, candidate, removing }),
      upstream,
      candidate,
      changes,
      temporary,
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function reviewLocalPolicy(base: string, id: string) {
  const review = candidateReview(base, id);
  try {
    const { id, digest, upstream, candidate, changes, draft } = review;
    return { id, digest, upstream, candidate, changes, draft };
  } finally {
    rmSync(review.temporary, { recursive: true, force: true });
  }
}

/** Cooperative human attestation, bound to exact candidate bytes and the previous active selection. */
export function approveLocalPolicy(base: string, id: string, expected: string, humanApproved: boolean): void {
  if (!humanApproved)
    throw new Error("local activation requires --human-approved after explicit human approval of the reviewed digest");
  withCacheLockSync(join(base, ".policy"), () => {
    const review = candidateReview(base, id);
    try {
      if (review.digest !== expected)
        throw new Error("local policy review changed; inspect collection local review again");
      if (review.candidate) storeCollection(review.temporary, review.candidate.sha256, base);
      const path = join(base, "index.toml"),
        context = join(base, "AGENTS.md");
      const oldIndex = existsSync(path) ? readFileSync(path) : undefined;
      const oldContext = existsSync(context) ? readFileSync(context) : undefined;
      const receipt = join(base, ".approvals", `${expected}.json`);
      const oldReceipt = existsSync(receipt) ? readFileSync(receipt, "utf8") : undefined;
      try {
        writeAtomic(
          receipt,
          JSON.stringify(
            {
              digest: expected,
              id,
              previous: registryPins(base),
              upstream: review.upstream,
              candidate: review.candidate ?? null,
              human_approved: true,
              approved_at: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        selectInstalledCollections(
          base,
          review.candidate ? [review.candidate] : [],
          undefined,
          review.candidate ? [] : [id],
        );
        syncLocalContext(base);
      } catch (error) {
        if (oldIndex) writeAtomic(path, oldIndex.toString("utf8"));
        else rmSync(path, { force: true });
        if (oldContext) writeAtomic(context, oldContext.toString("utf8"));
        else rmSync(context, { force: true });
        if (oldReceipt !== undefined) writeAtomic(receipt, oldReceipt);
        else rmSync(receipt, { force: true });
        throw error;
      }
      // Removing active policy must preserve unapproved edits in its working draft.
      if (!review.candidate) rmSync(join(draftPath(base, id), "remove.json"));
    } finally {
      rmSync(review.temporary, { recursive: true, force: true });
    }
  });
}

export function prepareLocalRemoval(base: string, id: string): void {
  withCacheLockSync(join(base, ".policy"), () => {
    if (!registryPins(base).some((pin) => pin.id === id)) throw new Error(`local collection is not active: ${id}`);
    writeAtomic(join(draftPath(base, id), "remove.json"), "{}\n");
  });
}

export function cancelLocalRemoval(base: string, id: string): void {
  withCacheLockSync(join(base, ".policy"), () => {
    rmSync(join(draftPath(base, id), "remove.json"), { force: true });
  });
}
