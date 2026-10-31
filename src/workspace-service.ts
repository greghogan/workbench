import { GitSnapshot } from "./git-snapshot.js";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { citationDocumentSources, type CitationDocumentSource } from "./citations.js";
import type { CollectionPin } from "./collection-schema.js";
import { localCollectionDirectories, resolveCollections } from "./collections.js";
import { readProjects } from "./project-configuration.js";
import { type Project } from "./project-model.js";
import { MissingResource, StateConflict } from "./input-errors.js";
import { projectBreadcrumb, projectName } from "./project-hierarchy.js";
import { contentDigest, recordBytes, RecordCatalog, supportingFiles, type BrowserRecord } from "./record-service.js";
import { RecordLookup } from "./record-lookup.js";
import {
  reviewedBaselines,
  reviewFileContents,
  reviewGit,
  ReviewSource,
  stagedReview,
  workingReviewContents,
} from "./review-service.js";
import { CollectionComparisons, type CollectionComparison } from "./web/collection-comparison.js";
import { acquireComparison, type ComparisonResult } from "./web/comparison-result.js";
import { sourceDifference, workingDiff, type SourceDifference } from "./web/diff.js";

export interface RecordDocument {
  contents: string;
  digest: string;
  error: string;
  files: { path: string; size: number }[];
  head: ComparisonResult;
  reviewed: ComparisonResult;
  reviewedAt: string;
  citation?: { sources: CitationDocumentSource[]; error: string };
}
export interface ReviewDocument {
  reviewedAt: string;
  head: ComparisonResult;
  before: string | null;
  after: string | null;
  reviewed: ComparisonResult;
  error: string;
}
export interface WorkspaceSnapshot {
  root: string;
  projects: Project[];
  revision: string;
  collectedAt: string;
  records: BrowserRecord[];
  collections: { pin: CollectionPin; local: boolean; directory: string }[];
  review: ReturnType<typeof stagedReview>;
  workingReview: ReturnType<typeof stagedReview>;
  documents: Map<string, RecordDocument>;
  reviewDocuments: Map<string, ReviewDocument>;
  comparisons: Map<string, CollectionComparison>;
  upstreamDiffs: Map<string, SourceDifference>;
  removedHeadDiffs: Map<string, { diff: SourceDifference | null; error: string }>;
  directories: string[];
}
export const reviewCollection = (path: string): string =>
  /^workbench\/collections\/([a-z][a-z0-9_-]*)\//.exec(path)?.[1] ?? "";

/** Shared read model for interfaces. Publication replaces a complete snapshot and its indexes together. */
export class WorkspaceIndex {
  private readonly searchable = new Map<string, string>();
  private searchBytes = 0;
  readonly byId: Map<string, BrowserRecord>;
  readonly byPath: Map<string, BrowserRecord>;
  readonly references: RecordLookup;
  readonly reviewByPath: Map<string, WorkspaceSnapshot["review"]["changes"][number]>;
  readonly workingReviewByPath: Map<string, WorkspaceSnapshot["review"]["changes"][number]>;
  readonly sources: string[];
  constructor(
    readonly snapshot: WorkspaceSnapshot,
    previous?: WorkspaceIndex,
  ) {
    if (previous?.snapshot.root === snapshot.root)
      for (const [id, text] of previous.searchable) {
        const current = snapshot.documents.get(id),
          old = previous.snapshot.documents.get(id);
        if (current && !current.error && current.digest === old?.digest) {
          this.searchable.set(id, text);
          this.searchBytes += Buffer.byteLength(text);
        }
      }
    const adaptations = new Map(
      [...snapshot.comparisons.values()]
        .flatMap((comparison) => (comparison.state === "compared" ? comparison.decisions : []))
        .filter((decision) => decision.status === "modified" || decision.status === "added")
        .map((decision) => [decision.id, decision.status] as const),
    );
    this.byId = new Map(
      snapshot.records.map((record) => {
        const adaptation = adaptations.get(record.id);
        const current = adaptation === "modified" || adaptation === "added" ? { ...record, adaptation } : record;
        return [current.id, current];
      }),
    );
    this.byPath = new Map(
      [...this.byId.values()].filter((record) => !record.local).map((record) => [record.path, record]),
    );
    this.references = new RecordLookup(this.byId.values());
    this.reviewByPath = new Map(snapshot.review.changes.map((change) => [change.path, change]));
    this.workingReviewByPath = new Map(snapshot.workingReview.changes.map((change) => [change.path, change]));
    this.sources = [
      ...new Set([
        ...snapshot.collections.map((collection) => collection.pin.id),
        ...[...snapshot.review.changes, ...snapshot.workingReview.changes]
          .map((change) => reviewCollection(change.path))
          .filter(Boolean),
      ]),
    ].sort();
  }
  matches(record: BrowserRecord, query: string): boolean {
    const metadata = [record.id, record.title, record.summary, record.status].join(" ").toLowerCase();
    if (metadata.includes(query)) return true;
    const document = this.snapshot.documents.get(record.id);
    if (!document || document.error) return false;
    const saved = this.searchable.get(record.id);
    if (saved !== undefined) return saved.includes(query);
    const text = document.contents.toLowerCase();
    const bytes = Buffer.byteLength(text);
    // Search acceleration is disposable and bounded independently of the acquired snapshot.
    if (this.searchBytes + bytes <= 8 * 1024 * 1024) {
      this.searchable.set(record.id, text);
      this.searchBytes += bytes;
    }
    return text.includes(query);
  }
  reviewChange(path: string, source?: ReviewSource) {
    const selected = source ?? (this.reviewByPath.has(path) ? ReviewSource.Staged : ReviewSource.Working);
    const change = (selected === ReviewSource.Staged ? this.reviewByPath : this.workingReviewByPath).get(path);
    return change ? { ...change, source: selected } : undefined;
  }
  projectForPath(path: string): Project | undefined {
    return (
      this.snapshot.projects
        .filter((project) => path.startsWith(`${project.path === "." ? "" : `${project.path}/`}workbench/`))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? this.snapshot.projects[0]
    );
  }
  select(parameters: { id?: string; path?: string; collection?: string; scope?: string; all?: string }): WorkspaceView {
    const record = parameters.id ? this.byId.get(parameters.id) : undefined;
    let selection = parameters.collection ?? "";
    let scope = parameters.scope ?? this.snapshot.projects[0]?.id ?? "";
    let all = parameters.all === "1";
    if (record) {
      selection = record.collection ? record.scope : "";
      scope = record.collection ? "" : record.scope;
      all = false;
    } else if (parameters.path && !all) {
      selection = reviewCollection(parameters.path);
      scope = selection ? "" : (this.projectForPath(parameters.path)?.id ?? "");
      all = false;
    } else if (parameters.collection === undefined && parameters.id) {
      const namespace = parameters.id.split(":")[0];
      if (namespace && this.sources.includes(namespace)) selection = namespace;
      else if (namespace && this.snapshot.projects.some((project) => project.id === namespace)) scope = namespace;
    }
    if (selection && !this.sources.includes(selection)) throw new MissingResource("selected collection is unavailable");
    if (selection) {
      scope = "";
      all = false;
    } else if (all) scope = "";
    else if (!this.snapshot.projects.some((project) => project.id === scope))
      throw new MissingResource("selected project scope is unavailable");
    return new WorkspaceView(this, selection, scope, all);
  }
}
export class WorkspaceView {
  readonly records: BrowserRecord[];
  readonly selectedRecords: BrowserRecord[];
  readonly selectedReviews: (WorkspaceSnapshot["review"]["changes"][number] & { source: ReviewSource })[];
  readonly comparison: CollectionComparison | undefined;
  constructor(
    readonly index: WorkspaceIndex,
    readonly selection: string,
    readonly scope: string,
    readonly all: boolean,
  ) {
    this.records = [...index.byId.values()];
    this.selectedRecords = this.records.filter(
      (record) =>
        all ||
        (selection ? record.collection && record.scope === selection : !record.collection && record.scope === scope),
    );
    this.selectedReviews = [
      ...this.review.changes.map((change) => ({ ...change, source: ReviewSource.Staged })),
      ...index.snapshot.workingReview.changes
        .filter((change) => index.reviewByPath.get(change.path)?.digest !== change.digest)
        .map((change) => ({ ...change, source: ReviewSource.Working })),
    ]
      .filter(
        (change) =>
          all ||
          (selection
            ? reviewCollection(change.path) === selection
            : !reviewCollection(change.path) && index.projectForPath(change.path)?.id === scope),
      )
      .sort((a, b) => a.path.localeCompare(b.path));
    this.comparison = index.snapshot.comparisons.get(selection);
  }
  get root() {
    return this.index.snapshot.root;
  }
  get revision() {
    return this.index.snapshot.revision;
  }
  get review() {
    return this.index.snapshot.review;
  }
  get collections() {
    return this.index.snapshot.collections;
  }
  get sources() {
    return this.index.sources;
  }
  get projects(): Project[] {
    return this.index.snapshot.projects;
  }
  get selectedProject(): Project | undefined {
    return this.projects.find((project) => project.id === this.scope);
  }
  get sourceName(): string {
    return this.all
      ? "All sources"
      : this.selection
        ? this.selection
        : this.selectedProject
          ? projectBreadcrumb(this.selectedProject, this.projects)
          : "Project records";
  }
  get rootName(): string {
    const root = this.projects[0];
    return root ? projectName(root) : "";
  }
  get pendingReviews(): number {
    return new Set(this.selectedReviews.filter((change) => !change.approved).map((change) => change.path)).size;
  }
  searchRecords({ type, scope, query }: { type: string; scope: string; query: string }): BrowserRecord[] {
    const normalized = query.toLowerCase();
    return this.selectedRecords.filter(
      (record) =>
        (!type || type === record.type) &&
        (!scope || scope === record.scope) &&
        (!normalized || this.index.matches(record, normalized)),
    );
  }
  get otherReviews(): { scope: string; collection: string; label: string; count: number }[] {
    if (this.all) return [];
    const groups = new Map<string, { scope: string; collection: string; label: string; count: number }>();
    const seen = new Set<string>();
    for (const change of [...this.review.changes, ...this.index.snapshot.workingReview.changes]) {
      if (change.approved || seen.has(change.path)) continue;
      seen.add(change.path);
      const collection = reviewCollection(change.path);
      const project = collection ? undefined : this.index.projectForPath(change.path);
      const scope = project?.id ?? "";
      if (collection === this.selection && scope === this.scope) continue;
      const key = `${collection ? "collection" : "project"}:${collection || scope}`;
      const group = groups.get(key) ?? {
        collection,
        scope,
        label: collection || (project ? projectBreadcrumb(project, this.projects) : "Project records"),
        count: 0,
      };
      group.count++;
      groups.set(key, group);
    }
    return [...groups.values()];
  }
  document(id: string): RecordDocument {
    const document = this.index.snapshot.documents.get(id);
    if (!document) throw new MissingResource("record not found");
    if (document.error) throw new StateConflict(document.error);
    return document;
  }
  reviewDocument(digest: string): ReviewDocument {
    const document = this.index.snapshot.reviewDocuments.get(digest);
    if (!document) throw new StateConflict("staged file changed; refresh the review");
    if (document.error) throw new StateConflict(document.error);
    return document;
  }
}

const inputStamp = (path: string): string => {
  try {
    const stat = lstatSync(path);
    return JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch {
    return "missing";
  }
};

/** Conservative retained graph accounting includes metadata, arrays, errors, and shared references once. */
export function workspaceSnapshotBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return 24 + value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof Map)
    return (
      64 +
      [...value].reduce(
        (total, [key, entry]: [unknown, unknown]) =>
          total + 40 + workspaceSnapshotBytes(key, seen) + workspaceSnapshotBytes(entry, seen),
        0,
      )
    );
  if (Array.isArray(value))
    return 32 + value.reduce((total: number, entry: unknown) => total + 8 + workspaceSnapshotBytes(entry, seen), 0);
  return (
    32 +
    Object.entries(value).reduce(
      (total, [key, entry]) => total + 16 + workspaceSnapshotBytes(key, seen) + workspaceSnapshotBytes(entry, seen),
      0,
    )
  );
}

/** Synchronous acquisition belongs to a dedicated worker, never the listener or a renderer. */
export class WorkspaceCollector {
  private readonly catalog: RecordCatalog;
  private readonly comparisons = new CollectionComparisons();
  private diffs = new Map<string, { key: string; diff: SourceDifference }>();
  private previous: { snapshot: WorkspaceSnapshot; stamps: Map<string, string>; acquiredAt: number } | undefined;
  constructor(private readonly root: string) {
    this.catalog = new RecordCatalog(root);
  }
  collect(fresh = false): WorkspaceSnapshot {
    const previous = this.previous;
    if (
      !fresh &&
      previous &&
      Date.now() - previous.acquiredAt < 60_000 &&
      [...previous.stamps].every(([path, stamp]) => inputStamp(path) === stamp)
    )
      return previous.snapshot;
    const paths = new Set<string>();
    const observed = new Map<string, string>();
    const observe = (path: string) => {
      paths.add(path);
      if (!observed.has(path)) observed.set(path, inputStamp(path));
    };
    observe(join(this.root, "workbench/config.toml"));
    observe(join(this.root, "workbench/projects.toml"));
    for (const base of localCollectionDirectories(this.root)) observe(join(base, "index.toml"));
    for (const name of ["index", "HEAD", "packed-refs", "workbench/review.json"])
      observe(resolve(this.root, reviewGit(this.root, ["rev-parse", "--git-path", name]).trim()));
    const selected = spawnSync("git", ["-C", this.root, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8" });
    if (selected.error || (selected.status !== 0 && selected.status !== 1))
      throw new Error("cannot inspect the current Git branch");
    if (selected.stdout.trim().startsWith("refs/"))
      observe(resolve(this.root, reviewGit(this.root, ["rev-parse", "--git-path", selected.stdout.trim()]).trim()));
    const projects = readProjects(this.root);
    const collections = resolveCollections(this.root);
    const records = this.catalog.records(collections, observe);
    const git = new GitSnapshot(this.root);
    const review = stagedReview(this.root, ReviewSource.Staged, git);
    const workingReview = stagedReview(this.root, ReviewSource.Working, git);
    git.prefetch([
      ...records
        .filter((record) => record.type === "ADR" && !record.local)
        .flatMap((record) => {
          const entry = git.committed.get(record.path);
          return entry ? [entry.oid] : [];
        }),
      ...review.changes.flatMap((change) =>
        [change.before, change.after]
          .filter((identity) => !identity.startsWith("000000:"))
          .map((identity) => identity.split(":")[1] ?? ""),
      ),
    ]);
    const documents = new Map<string, RecordDocument>(),
      reviewDocuments = new Map<string, ReviewDocument>();
    const comparisons = new Map<string, CollectionComparison>(),
      upstreamDiffs = new Map<string, SourceDifference>();
    const removedHeadDiffs = new Map<string, { diff: SourceDifference | null; error: string }>();
    let retained = 0;
    const charge = (...values: (string | null | undefined)[]) => {
      for (const value of values) if (value) retained += Buffer.byteLength(value);
      if (retained > 64 * 1024 * 1024)
        throw new Error("workspace browser snapshot exceeds 64 MiB; use the CLI for this workspace");
    };
    const head = git.head;
    const baselines = reviewedBaselines(this.root, head);
    const nextDiffs = new Map<string, { key: string; diff: SourceDifference }>();
    const cachedDiff = (id: string, key: string, read: () => SourceDifference) => {
      const saved = this.diffs.get(id);
      if (saved?.key === key) {
        nextDiffs.set(id, saved);
        return saved.diff;
      }
      const diff = read();
      nextDiffs.set(id, { key, diff });
      return diff;
    };
    for (const record of records) {
      observe(join(record.directory, record.path));
      let contents = "",
        digest = "",
        error = "",
        headComparison = acquireComparison(() => null),
        reviewedComparison = headComparison,
        reviewedAt = "",
        files: RecordDocument["files"] = [];
      try {
        const bytes = recordBytes(record);
        contents = bytes.toString("utf8");
        digest = contentDigest(bytes);
        files = supportingFiles(record);
        const support = join(record.directory, record.path.replace(/\.[^.]+$/, ""));
        observe(support);
        for (const file of files) {
          const absolute = join(record.directory, file.path);
          observe(absolute);
          for (let directory = dirname(absolute); directory.startsWith(support); directory = dirname(directory))
            observe(directory);
        }
      } catch (cause) {
        error = String(cause);
      }
      if (!error && record.type === "ADR" && !record.local) {
        headComparison = acquireComparison(() =>
          cachedDiff(`head:${record.id}`, contentDigest(head + record.path + digest), () =>
            workingDiff(this.root, record.path, contents, git),
          ),
        );
        const baseline = baselines.get(record.path);
        reviewedAt = baseline?.approvedAt ?? "";
        reviewedComparison = baseline
          ? acquireComparison(() =>
              cachedDiff(`reviewed:${record.id}`, contentDigest(baseline.contents + record.path + digest), () =>
                sourceDifference(baseline.contents, contents, record.path),
              ),
            )
          : headComparison;
      }
      let citation: RecordDocument["citation"];
      if (record.type === "CIT") {
        try {
          const sources = citationDocumentSources(this.root, record.id);
          for (const source of sources) observe(source.path);
          citation = { sources, error: "" };
          record.citationPresence = {
            present: sources.filter((source) => source.present).length,
            total: sources.length,
          };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          citation = { sources: [], error: message };
          record.citationPresence = { error: message };
        }
      }
      charge(
        contents,
        JSON.stringify(headComparison),
        reviewedAt ? JSON.stringify(reviewedComparison) : "",
        citation ? JSON.stringify(citation) : "",
      );
      documents.set(record.id, {
        contents,
        digest,
        error,
        head: headComparison,
        reviewed: reviewedComparison,
        reviewedAt,
        files,
        ...(citation ? { citation } : {}),
      });
    }
    for (const collection of collections) {
      const comparison = this.comparisons.compare(this.root, collection, records);
      comparisons.set(collection.pin.id, comparison);
      if (comparison.state === "compared")
        for (const decision of comparison.decisions) {
          charge(decision.before, decision.after);
          upstreamDiffs.set(
            decision.id,
            cachedDiff(
              `upstream:${decision.id}`,
              contentDigest(JSON.stringify([decision.before, decision.after])),
              () => sourceDifference(decision.before ?? "", decision.after ?? "", decision.path),
            ),
          );
          charge(JSON.stringify(upstreamDiffs.get(decision.id)));
          if (decision.status === "removed") {
            const path = `workbench/collections/${collection.pin.id}/${decision.path}`;
            try {
              const diff = cachedDiff(`removed:${decision.id}`, head + path, () =>
                workingDiff(this.root, path, "", git),
              );
              removedHeadDiffs.set(decision.id, { diff, error: "" });
              charge(JSON.stringify(diff));
            } catch (cause) {
              removedHeadDiffs.set(decision.id, { diff: null, error: String(cause) });
            }
          }
        }
    }
    for (const [source, pending] of [
      [ReviewSource.Staged, review],
      [ReviewSource.Working, workingReview],
    ] as const)
      for (const change of pending.changes) {
        if (reviewDocuments.has(change.digest)) continue;
        observe(join(this.root, change.path));
        try {
          const before = reviewFileContents(this.root, change.before, git),
            after =
              source === ReviewSource.Working
                ? workingReviewContents(this.root, change)
                : reviewFileContents(this.root, change.after, git);
          const isADR = /\/ADR-[0-9A-Z]+\.md$/.test(change.path);
          const baseline = baselines.get(change.path);
          const headComparison = acquireComparison(() =>
            isADR
              ? cachedDiff(`review:${source}:${change.path}`, change.digest, () =>
                  sourceDifference(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "", change.path),
                )
              : null,
          );
          const reviewedComparison =
            isADR && baseline
              ? acquireComparison(() =>
                  cachedDiff(
                    `reviewed:${source}:${change.path}`,
                    contentDigest(baseline.contents + change.digest),
                    () => sourceDifference(baseline.contents, after?.toString("utf8") ?? "", change.path),
                  ),
                )
              : headComparison;
          charge(
            before?.toString("base64"),
            after?.toString("base64"),
            JSON.stringify(reviewedComparison),
            baseline ? JSON.stringify(headComparison) : "",
          );
          reviewDocuments.set(change.digest, {
            before: before?.toString("base64") ?? null,
            after: after?.toString("base64") ?? null,
            reviewed: reviewedComparison,
            head: headComparison,
            reviewedAt: baseline?.approvedAt ?? "",
            error: "",
          });
        } catch (cause) {
          reviewDocuments.set(change.digest, {
            before: null,
            after: null,
            reviewed: acquireComparison(() => null),
            head: acquireComparison(() => null),
            reviewedAt: "",
            error: String(cause),
          });
        }
      }
    for (const base of localCollectionDirectories(this.root)) paths.add(join(base, "index.toml"));
    for (const name of ["index", "HEAD", "packed-refs", "workbench/review.json"])
      paths.add(resolve(this.root, reviewGit(this.root, ["rev-parse", "--git-path", name]).trim()));
    for (const [path, before] of observed)
      if (inputStamp(path) !== before)
        throw new StateConflict(`workspace changed during refresh (${path}); retaining the last complete snapshot`);
    const stamps = [...paths].sort().map((path) => [path, inputStamp(path)] as const);
    this.diffs = nextDiffs;
    const directories = new Set<string>([join(this.root, "workbench")]);
    for (const path of paths) {
      let parent = dirname(path);
      while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
      directories.add(parent);
    }
    const snapshot: WorkspaceSnapshot = {
      root: this.root,
      projects,
      revision: contentDigest(
        JSON.stringify({
          stamps,
          head,
          projects,
          review: [review, workingReview].map((pending) =>
            pending.changes.map((change) => [change.digest, change.approved]),
          ),
          records,
          documents: [...documents].map(([id, document]) => [
            id,
            document.digest,
            document.error,
            document.head.state === "available"
              ? ["available", contentDigest(document.head.difference?.patch ?? "")]
              : ["unavailable", document.head.problem],
            document.reviewed.state === "available"
              ? ["available", contentDigest(document.reviewed.difference?.patch ?? "")]
              : ["unavailable", document.reviewed.problem],
          ]),
          comparisons: [...comparisons].map(([id, comparison]) => [
            id,
            comparison.state,
            comparison.revision,
            comparison.state === "compared"
              ? comparison.decisions.map((decision) => [
                  decision.id,
                  decision.status,
                  contentDigest(decision.before ?? ""),
                  contentDigest(decision.after ?? ""),
                ])
              : comparison.message,
          ]),
          removed: [...removedHeadDiffs].map(([id, difference]) => [
            id,
            difference.error,
            contentDigest(difference.diff?.patch ?? ""),
          ]),
        }),
      ),
      collectedAt: new Date().toISOString(),
      records,
      collections: collections.map(({ pin, local, directory }) => ({ pin, local, directory })),
      review,
      workingReview,
      documents,
      reviewDocuments,
      comparisons,
      upstreamDiffs,
      removedHeadDiffs,
      directories: [...directories],
    };
    if (workspaceSnapshotBytes(snapshot) > 64 * 1024 * 1024)
      throw new Error("workspace browser snapshot exceeds 64 MiB; use the CLI for this workspace");
    this.previous = { snapshot, stamps: new Map(stamps), acquiredAt: Date.now() };
    return snapshot;
  }
}
