import { workerFailure } from "./web/error-response.js";
import { withConfigurationSnapshot } from "./configuration-snapshot.js";
import type { FormattingResult } from "./review-formatting.js";
import { attachTaskImplementations, taskImplementationPath } from "./task-implementations.js";
import { experimentIsResult } from "./experiment-workflow.js";
import {
  policyCompatibility,
  policyCompatibilityReceipt,
  compatibilityFindingsPath,
  type PolicyCompatibilityReport,
} from "./policy-compatibility.js";
import { parseTask, TaskGraph, type TaskRecord } from "./task-model.js";
import {
  taskQueuePath,
  readTaskQueue,
  inspectQueue,
  TaskReadiness,
  TaskExecution,
  type TaskQueue,
} from "./task-queue.js";
import { normalizedNumber } from "./record-identity.js";
import { recordOwnerPath } from "./staged-records.js";
import { GitSnapshot } from "./git-snapshot.js";
import { spawnSync } from "node:child_process";
import { inputStamp, observeGitInputs } from "./workspace-inputs.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { citationDocumentSources, type CitationDocumentSource } from "./citations.js";
import type { CollectionPin } from "./collection-schema.js";
import {
  localCollectionDirectories,
  localCollectionScope,
  resolveCollections,
  type LocalCollectionScope,
} from "./collections.js";
import { readProjects, readConfig } from "./project-configuration.js";
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
  reviewStatus,
  presentedReviewDigest,
  workingReviewContents,
} from "./review-service.js";
import { CollectionComparisons, type CollectionComparison } from "./web/collection-comparison.js";
import { acquireComparison, type ComparisonResult, type ReviewBaseline } from "./web/comparison-result.js";
import { sourceDifference, type SourceDifference } from "./web/diff.js";

export interface RecordDocument {
  contents: string;
  digest: string;
  error: string;
  files: { path: string; size: number }[];
  reviewed: ComparisonResult;
  baseline: ReviewBaseline;
  modeChange?: { before: string; after: string };
  citation?: { sources: CitationDocumentSource[]; error: string; failure?: ReturnType<typeof workerFailure> };
}
export interface ReviewDocument {
  baseline: ReviewBaseline;
  baselineContents: string | null;
  before: string | null;
  after: string | null;
  reviewed: ComparisonResult;
  error: string;
}
export interface WorkspaceTasks {
  decisionsRequired: boolean;
  records: TaskRecord[];
  errors: Map<string, string>;
  queue: TaskQueue;
  problem: string;
}
export interface WorkspaceSnapshot {
  compatibility: { report: PolicyCompatibilityReport | null; error: string };
  tasks: WorkspaceTasks;
  root: string;
  projects: Project[];
  revision: string;
  collectedAt: string;
  records: BrowserRecord[];
  collections: { pin: CollectionPin; local: boolean; directory: string; localScope?: LocalCollectionScope }[];
  review: ReturnType<typeof reviewStatus>;
  documents: Map<string, RecordDocument>;
  reviewDocuments: Map<string, ReviewDocument>;
  comparisons: Map<string, CollectionComparison>;
  upstreamDiffs: Map<string, SourceDifference>;
  removedReviews: Map<string, ComparisonResult>;
  directories: string[];
  inputs: Map<string, string>;
  formatting: { width: number; results: Map<string, FormattingResult> };
}
export const reviewCollection = (path: string): string =>
  /^workbench\/collections\/([a-z][a-z0-9_-]*)\//.exec(path)?.[1] ?? "";

export interface ReviewGroup {
  id: string | undefined;
  path: string;
  record: BrowserRecord | undefined;
  changes: WorkspaceSnapshot["review"]["changes"];
  scope: string;
  collection: string;
  pending: number;
}

/** Shared read model for interfaces. Publication replaces a complete snapshot and its indexes together. */
export class WorkspaceIndex {
  private readonly searchable = new Map<string, string>();
  private searchBytes = 0;
  readonly taskGraph: TaskGraph;
  readonly taskReadiness: TaskReadiness;
  readonly taskQueue: ReturnType<typeof inspectQueue>;
  readonly byId: Map<string, BrowserRecord>;
  readonly byPath: Map<string, BrowserRecord>;
  readonly references: RecordLookup;
  readonly reviewByPath: Map<string, WorkspaceSnapshot["review"]["changes"][number]>;
  readonly sources: string[];
  readonly pendingReviewPaths = new Set<string>();
  readonly reviewGroups = new Map<string, ReviewGroup>();
  readonly reviewGroupById = new Map<string, ReviewGroup>();
  readonly reviewGroupByDigest = new Map<string, ReviewGroup>();
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
    this.taskGraph = new TaskGraph(snapshot.tasks.records);
    this.taskReadiness = new TaskReadiness(this.taskGraph, snapshot.tasks.queue);
    this.taskQueue = inspectQueue(this.taskReadiness);
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
    this.sources = [
      ...new Set([
        ...snapshot.collections.map((collection) => collection.pin.id),
        ...snapshot.review.changes.map((change) => reviewCollection(change.path)).filter(Boolean),
      ]),
    ].sort();
    for (const change of snapshot.review.changes) {
      const path = this.reviewOwnerPath(change.path);
      const collection = reviewCollection(path);
      const scope = collection || (this.projectForPath(path)?.id ?? "");
      const name = /\/(ADR|EXP|ENV)-([0-9A-Z]+)\.md$/.exec(path);
      const id =
        this.byPath.get(path)?.id ??
        (name?.[1] && name[2]
          ? `${scope}:${name[1]}-${normalizedNumber(name[2])}`
          : path.endsWith("/CHARTER.md")
            ? `${scope}:CHARTER`
            : undefined);
      const group = this.reviewGroups.get(path) ?? {
        id,
        path,
        record: this.byPath.get(path),
        changes: [],
        collection,
        scope: collection ? "" : (this.projectForPath(path)?.id ?? ""),
        pending: 0,
      };
      group.changes.push(change);
      if (!change.approved) {
        group.pending++;
        this.pendingReviewPaths.add(path);
      }
      this.reviewGroups.set(path, group);
      if (group.id) this.reviewGroupById.set(group.id, group);
      this.reviewGroupByDigest.set(change.digest, group);
    }
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
  reviewChange(path: string) {
    return this.reviewByPath.get(path);
  }
  reviewOwnerPath(path: string): string {
    const owner = recordOwnerPath(
      path,
      this.snapshot.projects.map((project) => project.path),
      this.sources,
    );
    return owner && (this.byPath.has(owner) || this.reviewByPath.has(owner)) ? owner : path;
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
    const review = parameters.id ? this.reviewGroupById.get(parameters.id) : undefined;
    let selection = parameters.collection ?? "";
    let scope = parameters.scope ?? this.snapshot.projects[0]?.id ?? "";
    let all = parameters.all === "1";
    if (record) {
      selection = record.collection ? record.scope : "";
      scope = record.collection ? "" : record.scope;
      all = false;
    } else if (review && !all) {
      selection = review.collection;
      scope = review.scope;
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
  readonly reviewGroups: ReviewGroup[];
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
        (all && !record.collection) ||
        (selection ? record.collection && record.scope === selection : !record.collection && record.scope === scope),
    );
    this.reviewGroups = [...index.reviewGroups.values()];
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
      ? this.rootName
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
  get reviewQueue(): ReviewGroup[] {
    return this.reviewGroups.filter((group) => group.pending > 0);
  }
  get compatibility() {
    return this.index.snapshot.compatibility;
  }
  get pendingCompatibilityFindings() {
    return this.compatibility.report?.assessment?.findings.filter((finding) => !finding.decision) ?? [];
  }
  get compatibilityNeedsHumanReview(): boolean {
    return (
      !!this.compatibility.report?.sources.length &&
      (!!this.compatibility.report.conflicts.length || this.pendingCompatibilityFindings.length > 0)
    );
  }
  get experimentWorkflow() {
    return this.index.snapshot.records.flatMap<{ record: BrowserRecord; phase: "work" | "outcome" }>((record) => {
      if (record.type !== "EXP" || record.local || record.collection) return [];
      const document = this.index.snapshot.documents.get(record.id);
      if (!document || document.error) return [];
      if (experimentIsResult(record.status))
        return this.index.reviewGroupById.get(record.id)?.pending ? [{ record, phase: "outcome" }] : [];
      return [{ record, phase: "work" }];
    });
  }
  get taskReviews() {
    const prepared = this.index.snapshot.tasks;
    const entries = new Map(prepared.queue.entries.map((entry) => [entry.reference, entry]));
    const tasks = (prepared.problem ? [] : prepared.records).flatMap<{
      record: BrowserRecord;
      decision: "plan" | "outcome";
    }>((task) => {
      const record = this.index.byId.get(task.reference);
      if (!record || record.collection || record.local) return [];
      if (task.metadata.status === "Planned") return [{ record, decision: "plan" as const }];
      const entry = entries.get(task.reference);
      if (
        task.metadata.status === "Approved" &&
        ((entry?.state === TaskExecution.Implemented && entry.planDigest === task.planDigest) ||
          (!entry && task.implementation))
      )
        return [{ record, decision: "outcome" as const }];
      return [];
    });
    return [
      ...tasks,
      ...this.experimentWorkflow.flatMap<{ record: BrowserRecord; decision: "plan" | "outcome" }>((item) =>
        item.phase === "work" ? [] : [{ record: item.record, decision: item.phase }],
      ),
    ];
  }
  get pendingReviews(): number {
    return this.reviewQueue.length + (this.compatibilityNeedsHumanReview ? 1 : 0);
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
  document(id: string): RecordDocument {
    const document = this.index.snapshot.documents.get(id);
    if (!document) throw new MissingResource("record not found");
    if (document.error) throw new StateConflict(document.error);
    return document;
  }
  reviewDocument(digest: string): ReviewDocument {
    const document = this.index.snapshot.reviewDocuments.get(digest);
    if (!document) throw new StateConflict("current file changed; refresh the review");
    if (document.error) throw new StateConflict(document.error);
    return document;
  }
}

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
    return withConfigurationSnapshot(() => this.acquire(fresh));
  }
  private acquire(fresh: boolean): WorkspaceSnapshot {
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
    const observeOne = (path: string) => {
      paths.add(path);
      if (!observed.has(path)) observed.set(path, inputStamp(path));
    };
    const observe = (path: string) => {
      observeOne(path);
      for (
        let directory = dirname(path);
        directory === this.root || directory.startsWith(this.root + sep);
        directory = dirname(directory)
      ) {
        observeOne(join(directory, ".gitignore"));
        if (directory === this.root) break;
      }
    };
    const policyReceipt = policyCompatibilityReceipt(this.root);
    observe(policyReceipt);
    observe(compatibilityFindingsPath(policyReceipt));
    observe(taskQueuePath(this.root));
    const implementationPath = taskImplementationPath(this.root);
    if (implementationPath) observe(implementationPath);
    observe(join(this.root, "workbench/config.toml"));
    observe(join(this.root, "workbench/projects.toml"));
    for (const base of localCollectionDirectories(this.root)) {
      observe(join(base, "index.toml"));
      observe(join(base, "AGENTS.md"));
    }
    const gitIndex = observeGitInputs(this.root, observe);
    const selected = spawnSync("git", ["-C", this.root, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8" });
    if (selected.error || (selected.status !== 0 && selected.status !== 1))
      throw new Error("cannot inspect the current Git branch");
    if (selected.stdout.trim().startsWith("refs/"))
      observe(resolve(this.root, reviewGit(this.root, ["rev-parse", "--git-path", selected.stdout.trim()]).trim()));
    const projects = readProjects(this.root);
    const collections = resolveCollections(this.root);
    const git = new GitSnapshot(this.root, { staged: false, review: true });
    const committedRecords = new Set([...git.committed.keys()].map((path) => join(this.root, path)));
    const records = this.catalog.records(collections, observe, committedRecords);
    const status = reviewStatus(this.root, ReviewSource.Working, git);
    const review = {
      ...status,
      changes: status.changes.map((change) => ({ ...change, digest: presentedReviewDigest(change, status.head) })),
    };
    git.prefetch([
      ...records
        .filter((record) => record.type === "ADR" && !record.local)
        .flatMap((record) => {
          const entry = git.committed.get(record.path);
          return entry ? [entry.oid] : [];
        }),
      ...review.changes.flatMap((change) =>
        [change.before]
          .filter((identity) => !identity.startsWith("000000:"))
          .map((identity) => identity.split(":")[1] ?? ""),
      ),
    ]);
    const documents = new Map<string, RecordDocument>(),
      reviewDocuments = new Map<string, ReviewDocument>();
    const comparisons = new Map<string, CollectionComparison>(),
      upstreamDiffs = new Map<string, SourceDifference>();
    const removedReviews = new Map<string, ComparisonResult>();
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
      const saved = nextDiffs.get(id) ?? this.diffs.get(id);
      if (saved?.key === key) {
        nextDiffs.set(id, saved);
        return saved.diff;
      }
      const diff = read();
      nextDiffs.set(id, { key, diff });
      return diff;
    };
    const baselineFor = (path: string): ReviewBaseline => {
      const saved = baselines.get(path);
      return saved
        ? { kind: "review", approvedAt: saved.approvedAt }
        : { kind: git.committed.has(path) ? "commit" : "new" };
    };
    const compareCurrent = (path: string, contents: string): ComparisonResult =>
      acquireComparison(() => {
        const before = baselines.get(path)?.contents ?? git.committedBytes(path)?.toString("utf8") ?? "";
        return cachedDiff(`current:${path}`, contentDigest(JSON.stringify([before, contents])), () =>
          sourceDifference(before, contents, path),
        );
      });
    const currentModes = new Map(review.changes.map((change) => [change.path, change.after.split(":")[0]]));
    for (const record of records) {
      observe(join(record.directory, record.path));
      let contents = "",
        digest = "",
        error = "",
        reviewedComparison = acquireComparison(() => null),
        baseline: ReviewBaseline = { kind: "new" },
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
        baseline = baselineFor(record.path);
        reviewedComparison = compareCurrent(record.path, contents);
      }
      const beforeMode = baselines.get(record.path)?.mode ?? git.committed.get(record.path)?.mode;
      const afterMode = currentModes.get(record.path) ?? git.committed.get(record.path)?.mode;
      const modeChange =
        beforeMode && afterMode && beforeMode !== afterMode && beforeMode !== "000000" && afterMode !== "000000"
          ? { before: beforeMode, after: afterMode }
          : undefined;
      let citation: RecordDocument["citation"];
      if (record.type === "CIT") {
        try {
          const sources = citationDocumentSources(this.root, record.id);
          for (const source of sources) {
            observe(source.path);
            observe(source.originalPath);
          }
          citation = { sources, error: "" };
          record.citationPresence = {
            present: sources.filter((source) => source.present).length,
            total: sources.length,
          };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          citation = { sources: [], error: message, failure: workerFailure(cause) };
          record.citationPresence = { error: message };
        }
      }
      charge(contents, JSON.stringify(reviewedComparison), citation ? JSON.stringify(citation) : "");
      documents.set(record.id, {
        contents,
        digest,
        error,
        reviewed: reviewedComparison,
        ...(modeChange ? { modeChange } : {}),
        baseline,
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
            const comparison = compareCurrent(path, "");
            removedReviews.set(decision.id, comparison);
            charge(JSON.stringify(comparison));
          }
        }
    }
    for (const change of review.changes) {
      observe(join(this.root, change.path));
      try {
        const before = reviewFileContents(this.root, change.before, git),
          after = workingReviewContents(this.root, change);
        const isADR = /\/ADR-[0-9A-Z]+\.md$/.test(change.path);
        const baseline = baselineFor(change.path);
        const baselineContents = change.path.endsWith(".md")
          ? (baselines.get(change.path)?.contents ?? before?.toString("utf8") ?? null)
          : null;
        const reviewed = isADR
          ? compareCurrent(change.path, after?.toString("utf8") ?? "")
          : acquireComparison(() => null);
        charge(before?.toString("base64"), after?.toString("base64"), baselineContents, JSON.stringify(reviewed));
        reviewDocuments.set(change.digest, {
          before: before?.toString("base64") ?? null,
          after: after?.toString("base64") ?? null,
          reviewed,
          baseline,
          baselineContents,
          error: "",
        });
      } catch (cause) {
        reviewDocuments.set(change.digest, {
          before: null,
          after: null,
          reviewed: acquireComparison(() => null),
          baseline: baselineFor(change.path),
          baselineContents: null,
          error: String(cause),
        });
      }
    }
    for (const base of localCollectionDirectories(this.root)) paths.add(join(base, "index.toml"));
    for (const name of ["HEAD", "packed-refs", "workbench/review.json"])
      paths.add(resolve(this.root, reviewGit(this.root, ["rev-parse", "--git-path", name]).trim()));
    let compatibility: WorkspaceSnapshot["compatibility"];
    try {
      compatibility = { report: policyCompatibility(this.root), error: "" };
    } catch (error) {
      compatibility = { report: null, error: error instanceof Error ? error.message : String(error) };
    }
    this.diffs = nextDiffs;
    const tasks: WorkspaceTasks = {
      decisionsRequired: readConfig(this.root).review?.task_approvals === true,
      records: [],
      errors: new Map(),
      queue: readTaskQueue(this.root),
      problem: "",
    };
    for (const record of records.filter((record) => record.type === "TSK")) {
      try {
        const document = documents.get(record.id);
        if (!document || document.error) throw new Error(document?.error ?? "Task document unavailable");
        tasks.records.push(parseTask(this.root, record.id, join(record.directory, record.path), document.contents));
      } catch (error) {
        tasks.errors.set(record.id, error instanceof Error ? error.message : String(error));
      }
    }
    try {
      new TaskGraph(tasks.records).validate();
      attachTaskImplementations(this.root, tasks.records);
    } catch (error) {
      tasks.problem = String(error);
    }
    for (const [path, before] of observed)
      if (inputStamp(path) !== before)
        throw new StateConflict(`workspace changed during refresh (${path}); retaining the last complete snapshot`);
    const stamps = [...paths].sort().map((path) => [path, inputStamp(path)] as const);
    const directories = new Set<string>([join(this.root, "workbench")]);
    for (const path of paths) {
      let parent = dirname(path);
      while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
      directories.add(parent);
    }
    const snapshot: WorkspaceSnapshot = {
      compatibility,
      tasks,
      root: this.root,
      projects,
      revision: contentDigest(
        JSON.stringify({
          // The index invalidates discovery; only its derived visible outcomes identify the publication.
          stamps: stamps.filter(([path]) => path !== gitIndex),
          compatibility,
          head,
          projects,
          review: review.changes.map((change) => [change.digest, change.approved]),
          records,
          documents: [...documents].map(([id, document]) => [
            id,
            document.digest,
            document.error,
            document.baseline,
            document.modeChange,
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
          tasks: [tasks.queue, [...tasks.errors], tasks.problem],
          removed: [...removedReviews].map(([id, comparison]) => [id, comparison]),
        }),
      ),
      collectedAt: new Date().toISOString(),
      records,
      collections: collections.map(({ pin, local, directory }) => ({
        pin,
        local,
        directory,
        ...(local ? { localScope: localCollectionScope(this.root, directory) } : {}),
      })),
      review,
      documents,
      reviewDocuments,
      comparisons,
      upstreamDiffs,
      removedReviews,
      directories: [...directories],
      inputs: new Map(stamps),
      formatting: { width: readConfig(this.root).markdown?.wrap_width ?? 120, results: new Map() },
    };
    if (workspaceSnapshotBytes(snapshot) > 64 * 1024 * 1024)
      throw new Error("workspace browser snapshot exceeds 64 MiB; use the CLI for this workspace");
    this.previous = { snapshot, stamps: new Map(stamps), acquiredAt: Date.now() };
    return snapshot;
  }
}
