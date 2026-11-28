import { withRepositoryReads } from "../../core/git/repository-reads.js";
import { reviewTaskPaths, reviewTaskOwner, reviewTasksByPath } from "../review/task-review-groups.js";
import { taskLifecycle, TaskLifecycle, taskPhase, TaskPhase } from "../../core/tasks/task-workflow.js";
import { observeTaskVerifications, treeTasks } from "../../core/tasks/task-snapshot.js";
import { allCommitReviews, reviewRecordGroups } from "../../core/review/review-units.js";
import { readPlanOperations } from "../../core/tasks/planning/plan-operation-store.js";
import { workGraph } from "../../core/tasks/planning/work-plans.js";
import { planningInputs } from "../../core/tasks/planning/planning-inputs.js";
import {
  readPlanningRecords,
  planningBrowserRecord,
  type PlanningRecord,
} from "../../core/tasks/planning/planning-read-model.js";
import { taskRecordState } from "./task-state.js";
import { projectPaths } from "../../core/projects/project-paths.js";
import { pendingRecordOutputs } from "../../core/review/review-preparation-state.js";
import { existingParentResolver } from "./input-watch.js";
import type { ReviewPreparation } from "../review/review-state.js";
import { retainedBytes } from "../../core/runtime/retained-bytes.js";
import { workerFailure } from "../http/error-response.js";
import { withConfigurationSnapshot } from "../../core/configuration/configuration-snapshot.js";
import { taskImplementationPath } from "../../core/tasks/task-implementations.js";
import { taskDecisionPath } from "../../core/tasks/task-decisions.js";
import {
  latestTaskReviews,
  taskFileChanges,
  taskPlanFiles,
  taskReviewedVersion,
  type TaskApprovalView,
} from "../../core/tasks/task-approvals.js";
import { terminalTask } from "../../core/records/record-document.js";
import {
  policyCompatibility,
  policyCompatibilityReceipt,
  compatibilityFindingsPath,
  type PolicyCompatibilityReport,
} from "../../core/collections/policy-compatibility.js";
import { type TaskGraph, type TaskRecord } from "../../core/tasks/task-model.js";
import {
  taskQueuePath,
  readTaskQueue,
  inspectQueue,
  taskStarted,
  TaskReadiness,
  type TaskQueue,
} from "../../core/tasks/task-queue.js";
import { GitSnapshot, gitBytes } from "../../core/git/git-snapshot.js";
import { inputStamp, observeGitInputs } from "../../core/projects/workspace-inputs.js";
import { dirname, join, relative, sep } from "node:path";
import { citationDocumentSources, type CitationDocumentSource } from "../../core/citations/citations.js";
import type { CollectionPin } from "../../core/collections/collection-schema.js";
import {
  localCollectionDirectories,
  localCollectionScope,
  resolveCollections,
  type LocalCollectionScope,
} from "../../core/collections/collections.js";
import { readProjects, readConfig } from "../../core/projects/project-configuration.js";
import { userConfigPath } from "../../core/configuration/user-config.js";
import { type Project } from "../../core/projects/project-model.js";
import { MissingResource, StateConflict } from "../../core/runtime/input-errors.js";
import { ProjectHierarchy, projectName } from "../../core/projects/project-hierarchy.js";
import {
  contentDigest,
  previewLimit,
  recordBytes,
  RecordCatalog,
  supportingFiles,
  type BrowserRecord,
} from "../../core/records/record-service.js";
import { RecordLookup } from "../../core/records/record-lookup.js";
import {
  reviewedBaselines,
  reviewFileContents,
  ReviewSource,
  reviewStatus,
  presentedReviewDigest,
  workingReviewContents,
} from "../../core/review/review-service.js";
import { CollectionComparisons, type CollectionComparison } from "../review/collection-comparison.js";
import { acquireComparison, type ComparisonResult, type ReviewBaseline } from "../review/comparison-result.js";
import { ReviewQueue, reviewCollection, type ReviewSection } from "../review/review-queue.js";
import { isSvg } from "../documents/document-image.js";
import { ownedFileBytes } from "../../core/collections/collection-files.js";

export interface RecordDocument {
  contents: string;
  digest: string;
  error: string;
  files: { path: string; size: number }[];
  reviewed: ComparisonResult;
  baseline: ReviewBaseline;
  taskFiles?: TaskApprovalView["files"];
  taskImages?: {
    previous: Map<string, { digest: string; contents: string }>;
    current: Map<string, string>;
  };
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
  plans: PlanningRecord[];
  decisionsRequired: boolean;
  records: TaskRecord[];
  errors: Map<string, string>;
  queue: TaskQueue;
  problem: string;
}
export interface WorkspaceSnapshot {
  retainedSize: number;
  compatibility: { report: PolicyCompatibilityReport | null; error: string };
  tasks: WorkspaceTasks;
  root: string;
  projects: Project[];
  revision: string;
  collectedAt: string;
  records: BrowserRecord[];
  collections: { pin: CollectionPin; local: boolean; directory: string; localScope?: LocalCollectionScope }[];
  review: ReturnType<typeof reviewStatus>;
  commitReviews: { revision: string; subject: string; paths: string[]; files: number; taskPaths: string[] }[];
  documents: Map<string, RecordDocument>;
  reviewDocuments: Map<string, ReviewDocument>;
  comparisons: Map<string, CollectionComparison>;
  removedReviews: Map<string, ComparisonResult>;
  directories: string[];
  inputs: Map<string, string>;
  reviewPreparation: { width: number; pendingOutputs: string[]; files: Map<string, ReviewPreparation> };
}

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
  private scopedReviewCounts?: ReadonlyMap<string, number>;
  readonly hierarchy: ProjectHierarchy;
  readonly taskGraph: TaskGraph;
  readonly taskReadiness: TaskReadiness;
  readonly taskQueue: ReturnType<typeof inspectQueue>;
  readonly byId: Map<string, BrowserRecord>;
  readonly byPath: Map<string, BrowserRecord>;
  readonly references: RecordLookup;
  readonly sources: string[];
  readonly reviews: ReviewQueue;
  readonly reviewTaskOwners: ReadonlyMap<string, TaskRecord>;
  private readonly reviewScopeOrder: ReadonlyMap<string, number>;
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
    this.hierarchy = new ProjectHierarchy(snapshot.projects);
    this.reviewScopeOrder = new Map(this.hierarchy.ordered().map((project, position) => [project.id, position]));
    this.taskGraph = workGraph(snapshot.tasks.records, snapshot.tasks.plans);
    this.taskReadiness = new TaskReadiness(this.taskGraph, snapshot.tasks.queue);
    this.taskQueue = inspectQueue(this.taskReadiness);
    const taskPaths = reviewTasksByPath(snapshot.root, snapshot.tasks.records);
    this.reviewTaskOwners = new Map(
      (snapshot.tasks.problem ? [] : snapshot.commitReviews).flatMap((unit) => {
        const task = unit.paths.length ? reviewTaskOwner(unit.taskPaths, taskPaths) : undefined;
        return task ? [[unit.revision, task] as const] : [];
      }),
    );
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
    for (const plan of snapshot.tasks.plans.filter(
      (plan) => !plan.implementation || !this.taskGraph.byReference.has(plan.implementation.task),
    ))
      this.byId.set(
        plan.reference,
        planningBrowserRecord(
          snapshot.root,
          plan,
          this.taskGraph.byReference.get(plan.reference)?.metadata.status ?? plan.status,
        ),
      );
    this.byPath = new Map(
      [...this.byId.values()].filter((record) => !record.local).map((record) => [record.path, record]),
    );
    this.references = new RecordLookup(this.byId.values());
    this.sources = [
      ...new Set([
        ...snapshot.collections.map((collection) => collection.pin.id),
        ...snapshot.review.changes.map((change) => reviewCollection(change.path)).filter(Boolean),
      ]),
    ].sort();
    this.reviews = new ReviewQueue(
      this.hierarchy,
      this.byPath,
      this.sources,
      snapshot.review.changes,
      snapshot.reviewPreparation.files,
      (path) => this.projectForPath(path),
    );
  }

  matches(record: BrowserRecord, query: string): boolean {
    const metadata = [record.id, record.title, record.summary, record.status].join(" ").toLowerCase();
    if (metadata.includes(query)) return true;
    const document = this.snapshot.documents.get(record.id);
    if (document?.error) return false;
    const plan = this.taskGraph.byReference.get(record.id),
      contents = document?.contents ?? (plan?.planning ? plan.contents : undefined);
    if (contents === undefined) return false;
    const saved = this.searchable.get(record.id);
    if (saved !== undefined) return saved.includes(query);
    const text = contents.toLowerCase();
    const bytes = Buffer.byteLength(text);
    // Search acceleration is disposable and bounded independently of the acquired snapshot.
    if (this.searchBytes + bytes <= 8 * 1024 * 1024) {
      this.searchable.set(record.id, text);
      this.searchBytes += bytes;
    }
    return text.includes(query);
  }
  reviewChange(path: string) {
    return this.reviews.byPath.get(path);
  }
  reviewOwnerPath(path: string): string {
    return this.reviews.owner(path);
  }
  projectForPath(path: string): Project | undefined {
    return this.hierarchy.recordOwner(path);
  }
  commitReviewGroups(paths: readonly string[]) {
    return reviewRecordGroups(paths)
      .map((group) => ({
        group,
        position: reviewCollection(group.path)
          ? this.reviewScopeOrder.size
          : (this.reviewScopeOrder.get(this.projectForPath(group.path)?.id ?? "") ?? this.reviewScopeOrder.size),
      }))
      .sort((a, b) => a.position - b.position)
      .map(({ group }) => ({ ...group, record: this.byPath.get(group.path) }));
  }
  /** Share scoped queue counts across page renders and live updates of this snapshot. */
  get subprojectReviewCounts(): ReadonlyMap<string, number> {
    this.scopedReviewCounts ??= new Map(
      this.snapshot.projects.flatMap((project) =>
        project.path === "." ? [] : [[project.id, this.select({ scope: project.id }).pendingReviews] as const],
      ),
    );
    return this.scopedReviewCounts;
  }
  select(parameters: { id?: string; path?: string; collection?: string; scope?: string; all?: string }): WorkspaceView {
    const record = parameters.id ? this.byId.get(parameters.id) : undefined;
    const review = parameters.id ? this.reviews.byId.get(parameters.id) : undefined;
    let selection = parameters.collection ?? "";
    let scope = parameters.scope ?? this.snapshot.projects[0]?.id ?? "";
    let all = parameters.all === "1";
    if (record) {
      selection = record.collection ? record.scope : "";
      const owner = this.snapshot.projects.find((project) => project.id === record.scope);
      const ancestor =
        owner && parameters.scope && this.hierarchy.lineage(owner).some((project) => project.id === parameters.scope);
      scope = record.collection ? "" : ancestor ? (parameters.scope ?? record.scope) : record.scope;
      all = !record.collection && parameters.all === "1";
    } else if (review && !all) {
      selection = review.collection;
      scope = review.scope;
    } else if (parameters.path && !all) {
      selection = reviewCollection(parameters.path);
      scope = selection ? "" : (this.projectForPath(parameters.path)?.id ?? scope);
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
  private readonly searchableRecords: BrowserRecord[];
  readonly reviewGroups: ReviewGroup[];
  readonly comparison: CollectionComparison | undefined;
  private readonly workflowScopes: ReadonlySet<string>;
  constructor(
    readonly index: WorkspaceIndex,
    readonly selection: string,
    readonly scope: string,
    readonly all: boolean,
  ) {
    this.records = [...index.byId.values()];
    this.searchableRecords = this.records.filter(
      (record) =>
        (all && !record.collection) ||
        (selection ? record.collection && record.scope === selection : !record.collection && record.scope === scope),
    );
    this.selectedRecords = this.searchableRecords.filter((record) => !record.id.includes(":plan/"));
    this.workflowScopes = new Set(
      index.snapshot.projects
        .filter((project) => all || index.hierarchy.lineage(project).some((ancestor) => ancestor.id === scope))
        .map((project) => project.id),
    );
    this.reviewGroups =
      !selection && (all || scope === index.snapshot.projects[0]?.id)
        ? index.reviews.groups
        : index.reviews.groups.filter((group) => this.includesWorkflow(group.scope, group.collection));
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
          ? this.index.hierarchy.breadcrumb(this.selectedProject)
          : "Project records";
  }
  get rootName(): string {
    const root = this.projects[0];
    return root ? projectName(root) : "";
  }
  get reviewQueue(): ReviewGroup[] {
    if (this.reviewGroups === this.index.reviews.groups) return this.index.reviews.pending;
    return this.reviewGroups.filter((group) => group.pending > 0);
  }
  get reviewSections(): ReviewSection[] {
    if (this.reviewGroups === this.index.reviews.groups) return this.index.reviews.sections;
    return this.index.reviews.sections
      .map((section) => ({
        ...section,
        groups: section.groups.filter((group) => this.includesWorkflow(group.scope, group.collection)),
      }))
      .filter((section) => section.groups.length > 0);
  }

  includesWorkflow(scope: string, collection = ""): boolean {
    if (this.selection) return collection === this.selection;
    return this.all || this.scope === this.projects[0]?.id || (!collection && this.workflowScopes.has(scope));
  }
  get taskQueue() {
    const queue = this.index.taskQueue;
    if (!this.selection && (this.all || this.scope === this.projects[0]?.id)) return queue;
    return {
      ...queue,
      entries: queue.entries.filter((entry) => this.includesWorkflow(entry.reference.split(":")[0] ?? "")),
      ready: queue.ready.filter((reference) => this.includesWorkflow(reference.split(":")[0] ?? "")),
    };
  }
  get workflowPlans() {
    return this.taskReviews
      .filter((item) => item.decision === "plan")
      .map((item) => item.record)
      .sort(
        (left, right) => (left.addedAt ?? "").localeCompare(right.addedAt ?? "") || left.id.localeCompare(right.id),
      );
  }
  taskState(reference: string): TaskLifecycle | undefined {
    const task = this.index.taskGraph.byReference.get(reference);
    return task ? taskLifecycle(task, this.index.taskReadiness.entries.get(reference)) : undefined;
  }
  taskHasDelivery(reference: string): boolean {
    return this.index.taskGraph.byReference.get(reference)?.committedDelivery === true;
  }
  get workflowApprovals() {
    const started = (record: BrowserRecord) =>
      taskStarted(this.index.taskReadiness.entries.get(record.id)) ||
      !!this.index.taskGraph.byReference.get(record.id)?.implementation;
    return this.taskReviews
      .filter((item) => item.decision === "reapproval")
      .map((item) => item.record)
      .sort(
        (left, right) =>
          Number(started(right)) - Number(started(left)) ||
          (left.addedAt ?? "").localeCompare(right.addedAt ?? "") ||
          left.id.localeCompare(right.id),
      );
  }
  get workflowOutcomes() {
    const outcomes = this.taskReviews.filter((item) => item.decision === "outcome").map((item) => item.record);
    if (outcomes.length < 2) return outcomes;
    const order = new Map(this.index.hierarchy.ordered().map((project, position) => [project.id, position]));
    return outcomes.sort((a, b) => (order.get(a.scope) ?? 0) - (order.get(b.scope) ?? 0));
  }
  get workflowWork() {
    return this.taskQueue.entries.flatMap(({ reference }) => {
      const task = this.index.taskGraph.byReference.get(reference);
      return task && taskPhase(task, this.index.taskReadiness.entries.get(reference)) === TaskPhase.Work ? [task] : [];
    });
  }
  get workCount(): number {
    return this.workflowWork.length;
  }

  get compatibility() {
    return this.index.snapshot.compatibility;
  }
  get pendingCompatibilityFindings() {
    return this.compatibility.report?.assessment?.findings.filter((finding) => !finding.decision) ?? [];
  }
  get compatibilityNeedsHumanReview(): boolean {
    return (
      !this.selection &&
      (this.all || this.scope === this.projects[0]?.id) &&
      !!this.compatibility.report?.sources.length &&
      (!!this.compatibility.report.conflicts.length || this.pendingCompatibilityFindings.length > 0)
    );
  }
  get taskReviews() {
    const prepared = this.index.snapshot.tasks;
    const tasks = (prepared.problem ? [] : this.index.taskGraph.tasks).flatMap<{
      record: BrowserRecord;
      decision: "plan" | "reapproval" | "outcome";
    }>((task) => {
      const record = this.index.byId.get(task.reference);
      if (!record || task.archived || record.collection || record.local || !this.includesWorkflow(record.scope))
        return [];
      const state = this.taskState(task.reference);
      if (state === TaskLifecycle.Planned) return [{ record, decision: "plan" as const }];
      if (state === TaskLifecycle.AwaitingApproval) return [{ record, decision: "reapproval" as const }];
      if (state === TaskLifecycle.AwaitingAcceptance) return [{ record, decision: "outcome" as const }];
      return [];
    });
    return tasks;
  }
  get commitReviews() {
    return this.index.snapshot.commitReviews
      .map((unit) => ({
        ...unit,
        paths: unit.paths.filter((path) => {
          const record = this.index.byPath.get(path);
          if (record) return this.includesWorkflow(record.scope, record.collection ? record.scope : undefined);
          if (this.selection) return path.startsWith(`workbench/collections/${this.selection}/`);
          if (this.all || !this.scope || this.scope === this.projects[0]?.id) return true;
          const scope = this.index.snapshot.projects.find((project) => project.id === this.scope);
          return !!scope && path.startsWith(`${scope.path === "." ? "" : scope.path + "/"}workbench/`);
        }),
      }))
      .filter((unit) => unit.paths.length > 0)
      .map((unit) => ({
        ...unit,
        groups: this.index.commitReviewGroups(unit.paths),
      }));
  }
  get standaloneCommitReviews() {
    const outcomes = new Set(this.workflowOutcomes.map((record) => record.id));
    return this.commitReviews.filter(
      (unit) => !outcomes.has(this.index.reviewTaskOwners.get(unit.revision)?.reference ?? ""),
    );
  }
  taskDocumentReviews(reference: string) {
    return this.index.snapshot.commitReviews
      .filter((unit) => this.index.reviewTaskOwners.get(unit.revision)?.reference === reference)
      .map((unit) => ({
        revision: unit.revision,
        subject: unit.subject,
        groups: this.index.commitReviewGroups(unit.paths),
      }));
  }
  commitReviewFor(path: string) {
    const prefix = path.slice(0, -3) + "/";
    return this.commitReviews.find((unit) => unit.paths.some((member) => member === path || member.startsWith(prefix)));
  }
  hasPendingReview(path: string): boolean {
    return this.index.reviews.pendingPaths.has(path) || this.commitReviewFor(path) !== undefined;
  }
  get pendingReviews(): number {
    return (
      this.standaloneCommitReviews.reduce((count, unit) => count + unit.groups.length, 0) +
      this.reviewQueue.length +
      this.workflowApprovals.length +
      this.workflowOutcomes.length +
      (this.compatibilityNeedsHumanReview ? 1 : 0)
    );
  }

  searchRecords({ type, scope, query }: { type: string; scope: string; query: string }): BrowserRecord[] {
    const normalized = query.toLowerCase();
    return (normalized ? this.searchableRecords : this.selectedRecords).filter(
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

/** Synchronous acquisition belongs to a dedicated worker, never the listener or a renderer. */
export class WorkspaceCollector {
  private readonly catalog: RecordCatalog;
  private readonly comparisons = new CollectionComparisons();
  private previous:
    | {
        snapshot: WorkspaceSnapshot;
        stamps: Map<string, string>;
        supportInputs: Map<string, ReadonlySet<string>>;
        supportDigests: Map<string, string>;
        hashes: Map<string, { algorithm: string; hash: string }>;
        acquiredAt: number;
      }
    | undefined;
  private history:
    | {
        key: string;
        at: number;
        baselines: ReturnType<typeof reviewedBaselines>;
        units: WorkspaceSnapshot["commitReviews"];
        onHead: ReadonlySet<string>;
      }
    | undefined;
  constructor(private readonly root: string) {
    this.catalog = new RecordCatalog(root);
  }
  collect(fresh = false, changed: readonly string[] = []): WorkspaceSnapshot {
    return withRepositoryReads(() => withConfigurationSnapshot(() => this.acquire(fresh, changed)));
  }
  private acquire(fresh: boolean, changed: readonly string[]): WorkspaceSnapshot {
    const previous = this.previous;
    const dirty = new Set(changed.filter((path) => previous?.stamps.has(path)));
    if (
      !fresh &&
      !dirty.size &&
      previous &&
      Date.now() - previous.acquiredAt < 60_000 &&
      [...previous.stamps].every(([path, stamp]) => inputStamp(path) === stamp)
    )
      return previous.snapshot;
    const observed = new Map<string, string>();
    const ignoreDirectories = new Set<string>();
    const observeOne = (path: string) => {
      let stamp = observed.get(path);
      if (stamp === undefined) {
        stamp = inputStamp(path);
        observed.set(path, stamp);
      }
      return stamp;
    };
    const observe = (path: string) => {
      observeOne(path);
      for (
        let directory = dirname(path);
        (directory === this.root || directory.startsWith(this.root + sep)) && !ignoreDirectories.has(directory);
        directory = dirname(directory)
      ) {
        ignoreDirectories.add(directory);
        observeOne(join(directory, ".gitignore"));
        if (directory === this.root) break;
      }
    };
    const policyReceipt = policyCompatibilityReceipt(this.root);
    observe(policyReceipt);
    observe(compatibilityFindingsPath(policyReceipt));
    observe(taskQueuePath(this.root));
    for (const path of planningInputs(this.root)) observe(path);
    const pendingPlan = readPlanOperations(this.root).find((operation) => !operation.operation.completed);
    if (pendingPlan)
      throw new StateConflict(
        `Planning ${pendingPlan.operation.kind} requires recovery in ${pendingPlan.operation.checkout}; retaining the last complete workspace`,
      );
    observe(taskDecisionPath(this.root));
    const implementationPath = taskImplementationPath(this.root);
    if (implementationPath) observe(implementationPath);
    observe(join(this.root, projectPaths.config));
    observe(join(this.root, projectPaths.projects));
    observe(join(process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? this.root, projectPaths.local));
    observe(userConfigPath());
    for (const base of localCollectionDirectories(this.root)) {
      observe(join(base, "index.toml"));
      observe(join(base, "AGENTS.md"));
    }
    const gitPaths = new Set<string>();
    const observeGitPath = (path: string) => {
      observe(path);
      gitPaths.add(path);
    };
    const gitIndex = observeGitInputs(this.root, observeGitPath);
    const projects = readProjects(this.root);
    const collections = resolveCollections(this.root);
    const git = new GitSnapshot(this.root, { staged: false });
    const committedRecords = new Set([...git.committed.keys()].map((path) => join(this.root, path)));
    const oldRecords = new Map(previous?.snapshot.records.map((record) => [record.id, record]));
    const oldDocument = (record: BrowserRecord) => {
      const old = oldRecords.get(record.id);
      if (
        old?.directory !== record.directory ||
        old.path !== record.path ||
        old.archive?.revision !== record.archive?.revision ||
        old.archive?.path !== record.archive?.path
      )
        return undefined;
      const document = previous?.snapshot.documents.get(record.id);
      return document?.error ? undefined : document;
    };
    const unchanged = (path: string) => !fresh && !dirty.has(path) && previous?.stamps.get(path) === observeOne(path);
    const bodies = new Map<string, { contents: string; digest: string }>();
    const captureBody = (record: BrowserRecord) => {
      const saved = bodies.get(record.id);
      if (saved) return saved;
      const old = oldDocument(record);
      const value =
        old && !fresh && (record.archive || unchanged(join(record.directory, record.path)))
          ? { contents: old.contents, digest: old.digest }
          : (() => {
              const bytes = recordBytes(record);
              return { contents: bytes.toString("utf8"), digest: contentDigest(bytes) };
            })();
      bodies.set(record.id, value);
      return value;
    };
    const records = this.catalog.records(
      collections,
      observe,
      committedRecords,
      (record) => captureBody(record).contents,
    );
    const primaryReviewPaths = new Set(records.map((record) => record.path));
    const hashes = new Map<string, { algorithm: string; hash: string }>();
    const status = reviewStatus(this.root, ReviewSource.Working, git, (path, algorithm, read) => {
      observe(path);
      const old = previous?.hashes.get(path);
      const hash = old?.algorithm === algorithm && unchanged(path) ? old.hash : read();
      hashes.set(path, { algorithm, hash });
      return hash;
    });
    const review = {
      ...status,
      changes: status.changes.map((change) => ({ ...change, digest: presentedReviewDigest(change, status.head) })),
    };
    git.prefetch([
      ...review.changes.flatMap((change) =>
        [change.before]
          .filter((identity) => !identity.startsWith("000000:"))
          .map((identity) => identity.split(":")[1] ?? ""),
      ),
    ]);
    const documents = new Map<string, RecordDocument>(),
      reviewDocuments = new Map<string, ReviewDocument>();
    const comparisons = new Map<string, CollectionComparison>();
    const removedReviews = new Map<string, ComparisonResult>();
    let retained = 0;
    const charge = (...values: (string | null | undefined)[]) => {
      for (const value of values) if (value) retained += Buffer.byteLength(value);
      if (retained > 64 * 1024 * 1024)
        throw new Error("workspace browser snapshot exceeds 64 MiB; use the CLI for this workspace");
    };
    const head = git.head;
    const historyKey = contentDigest(
      JSON.stringify([
        head,
        [...gitPaths].filter((path) => path !== gitIndex).map((path) => [path, observed.get(path)]),
      ]),
    );
    const savedHistory =
      !fresh && this.history?.key === historyKey && Date.now() - this.history.at < 60_000 ? this.history : undefined;
    const baselines = savedHistory?.baselines ?? reviewedBaselines(this.root, head);
    const baselineFor = (path: string): ReviewBaseline => {
      const saved = baselines.get(path);
      return saved
        ? { kind: "review", approvedAt: saved.approvedAt }
        : { kind: git.committed.has(path) ? "commit" : "new" };
    };
    const recordComparisons = new Map<string, { contents: string; comparison: ComparisonResult }>();
    const compareCurrent = (path: string, contents: string): ComparisonResult => {
      const existing = recordComparisons.get(path);
      if (existing?.contents === contents) return existing.comparison;
      const comparison = acquireComparison(() => ({
        before: baselines.get(path)?.contents ?? git.committedBytes(path)?.toString("utf8") ?? "",
        after: contents,
      }));
      recordComparisons.set(path, { contents, comparison });
      return comparison;
    };
    const currentModes = new Map(review.changes.map((change) => [change.path, change.after.split(":")[0]]));
    const supportInputs = new Map<string, ReadonlySet<string>>();
    const supportDigests = new Map<string, string>();
    for (const record of records) {
      if (!record.archive) observe(join(record.directory, record.path));
      let contents = "",
        digest = "",
        error = "",
        reviewedComparison = acquireComparison(() => null),
        baseline: ReviewBaseline = { kind: "new" },
        files: RecordDocument["files"] = [];
      try {
        ({ contents, digest } = captureBody(record));
        const old = oldDocument(record);
        const tracked = previous?.supportInputs.get(record.id);
        if (!fresh && old && tracked && [...tracked].every(unchanged)) {
          files = old.files;
          supportInputs.set(record.id, tracked);
          for (const path of tracked) observe(path);
        } else {
          const tracked = new Set<string>();
          files = supportingFiles(record, (path) => {
            observe(path);
            tracked.add(path);
          });
          supportInputs.set(record.id, tracked);
        }
        // The browser previews bounded files. Compare their bytes when an input stamp changes.
        for (const file of files) {
          if (record.archive || file.size > previewLimit) continue;
          const path = join(record.directory, file.path);
          const saved = unchanged(path) ? previous?.supportDigests.get(path) : undefined;
          supportDigests.set(path, saved ?? contentDigest(ownedFileBytes(record.directory, file.path, previewLimit)));
        }
      } catch (cause) {
        error = String(cause);
      }
      if (!error && record.type === "ADR" && !record.local) {
        baseline = baselineFor(record.path);
        reviewedComparison =
          baseline.kind === "commit" && !currentModes.has(record.path)
            ? acquireComparison(() => ({ before: contents, after: contents }))
            : compareCurrent(record.path, contents);
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
        const old = !fresh ? previous?.snapshot.reviewDocuments.get(change.digest) : undefined;
        const before =
          old && !old.error
            ? old.before === null
              ? undefined
              : Buffer.from(old.before, "base64")
            : reviewFileContents(this.root, change.before, git);
        const after =
          old && !old.error
            ? old.after === null
              ? undefined
              : Buffer.from(old.after, "base64")
            : workingReviewContents(this.root, change);
        const readableMarkdown =
          primaryReviewPaths.has(change.path) &&
          change.path.endsWith(".md") &&
          !before?.includes(0) &&
          !after?.includes(0);
        const baseline = baselineFor(change.path);
        const baselineContents = change.path.endsWith(".md")
          ? (baselines.get(change.path)?.contents ?? before?.toString("utf8") ?? null)
          : null;
        const reviewed = readableMarkdown
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
    let compatibility: WorkspaceSnapshot["compatibility"];
    try {
      compatibility = { report: policyCompatibility(this.root), error: "" };
    } catch (error) {
      compatibility = { report: null, error: error instanceof Error ? error.message : String(error) };
    }
    const plans = readPlanningRecords(this.root);
    for (const plan of plans) charge(plan.contents, plan.approval?.contents);
    const tasks: WorkspaceTasks = {
      ...taskRecordState(
        this.root,
        records
          .filter((record) => record.type === "TSK")
          .map((record) => ({
            reference: record.id,
            path: join(record.directory, record.path),
            archived: !!record.archive,
            read: () => {
              const document = documents.get(record.id);
              if (!document || document.error) throw new Error(document?.error ?? "Task document unavailable");
              return document.contents;
            },
          })),
      ),
      plans,
      decisionsRequired: readConfig(this.root).review?.task_approvals === true,
      queue: readTaskQueue(this.root),
    };
    observeTaskVerifications(this.root, tasks.records, tasks.queue.entries, observe);
    const taskReviews = tasks.problem ? undefined : latestTaskReviews(this.root);
    for (const task of tasks.records) {
      charge(task.approval?.contents);
      if (task.archived || (terminalTask.has(task.metadata.status) && !task.acceptanceNeedsReview)) continue;
      const document = documents.get(task.reference);
      if (!document) continue;
      const decision = taskReviews?.get(task.reference),
        path = relative(this.root, task.path).replaceAll("\\", "/");
      if (!decision) {
        document.baseline = baselineFor(path);
        if (document.baseline.kind !== "new") document.reviewed = compareCurrent(path, task.contents);
        continue;
      }
      document.baseline = { kind: "review", approvedAt: decision.updated };
      document.reviewed = acquireComparison(() => {
        const prior = taskReviewedVersion(this.root, task, decision);
        if (!prior) throw new Error("The previous task review is recorded, but its contents are unavailable.");
        const files = taskPlanFiles(this.root, task);
        document.taskFiles = taskFileChanges(prior.files, files);
        const base = path.slice(0, -3) + "/";
        const imageFiles = (files: typeof prior.files) =>
          files.filter(({ name, contents }) => isSvg(name) && Buffer.byteLength(contents, "base64") <= previewLimit);
        const previous = new Map(
          imageFiles(prior.files).map(
            ({ name, contents }) =>
              [base + name, { digest: contentDigest(Buffer.from(contents, "base64")), contents }] as const,
          ),
        );
        const current = new Map(
          imageFiles(files).map(
            ({ name, contents }) => [base + name, contentDigest(Buffer.from(contents, "base64"))] as const,
          ),
        );
        if (previous.size || current.size) document.taskImages = { previous, current };
        return { before: prior.contents, after: task.contents };
      });
      charge(JSON.stringify(document.reviewed), JSON.stringify(document.taskFiles));
      for (const image of document.taskImages?.previous.values() ?? []) charge(image.contents);
    }
    const onHead = new Set(savedHistory?.onHead);
    const commitReviews =
      savedHistory?.units ??
      allCommitReviews(this.root, head).map((unit) => {
        if (unit.onHead) onHead.add(unit.revision);
        return {
          revision: unit.revision,
          subject: unit.message.split("\n")[0] ?? "",
          paths: unit.changes.filter((change) => !change.approved).map((change) => change.path),
          files: unit.changes.length,
          taskPaths: reviewTaskPaths(this.root, unit),
        };
      });
    if (head && tasks.records.length) {
      try {
        const retained = treeTasks(this.root, head);
        const completeHistory =
          gitBytes(this.root, ["rev-parse", "--is-shallow-repository"]).toString().trim() === "false";
        const pending = new Set(commitReviews.flatMap((unit) => (onHead.has(unit.revision) ? unit.taskPaths : [])));
        for (const task of tasks.records) {
          const record = retained.get(task.reference);
          if (!record) continue;
          if (record.status === "Approved" || record.status === "Accepted") {
            task.previouslyApproved = true;
            task.committedDelivery = true;
          }
          if (
            record.status === "Accepted" &&
            task.metadata.status === "Accepted" &&
            record.digest === task.digest &&
            completeHistory &&
            !pending.has(record.path) &&
            (task.archived || record.outcome() === task.reviewDigest)
          ) {
            task.finalized = true;
          }
        }
      } catch {
        // A missing or unreadable retained version leaves the outcome accepted without confirmation of finalization.
      }
    }
    const reviewPreparation = {
      width: readConfig(this.root).markdown?.wrap_width ?? 120,
      pendingOutputs: [...pendingRecordOutputs(this.root, observe)],
      files: new Map(),
    };
    const existingParent = existingParentResolver();
    const directories = new Set<string>([join(this.root, "workbench")]);
    for (const path of observed.keys()) directories.add(existingParent(path));
    for (const [path, before] of observed)
      if (inputStamp(path) !== before)
        throw new StateConflict(`workspace changed during refresh (${path}); retaining the last complete snapshot`);
    const stamps = [...observed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const collectionViews = collections.map(({ pin, local, directory }) => ({
      pin,
      local,
      directory,
      ...(local ? { localScope: localCollectionScope(this.root, directory) } : {}),
    }));
    const snapshot: WorkspaceSnapshot = {
      retainedSize: 0,
      commitReviews,
      compatibility,
      tasks,
      root: this.root,
      projects,
      revision: contentDigest(
        JSON.stringify({
          compatibility,
          head,
          commitReviews,
          projects,
          collections: collectionViews,
          review: review.changes.map((change) => [change.digest, change.approved]),
          records,
          documents: [...documents].map(([id, document]) => [
            id,
            document.digest,
            document.error,
            document.baseline,
            document.modeChange,
            document.taskFiles,
            document.files,
            document.citation,
            document.reviewed.state === "available"
              ? ["available", contentDigest(document.reviewed.difference?.before ?? "")]
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
          support: [...supportDigests],
          tasks: [
            tasks.queue,
            [...tasks.errors],
            tasks.problem,
            tasks.decisionsRequired,
            tasks.records.map((task) => ({
              ...task,
              contents: task.digest,
              approval: task.approval && { ...task.approval, contents: contentDigest(task.approval.contents) },
            })),
            plans.map((plan) => ({
              ...plan,
              contents: plan.digest,
              approval: plan.approval && { ...plan.approval, contents: contentDigest(plan.approval.contents) },
            })),
          ],
          reviewPreparation: [reviewPreparation.width, reviewPreparation.pendingOutputs],
          removed: [...removedReviews].map(([id, comparison]) => [id, comparison]),
        }),
      ),
      collectedAt: new Date().toISOString(),
      records,
      collections: collectionViews,
      review,
      documents,
      reviewDocuments,
      comparisons,
      removedReviews,
      directories: [...directories],
      inputs: new Map(stamps),
      reviewPreparation,
    };
    snapshot.retainedSize = retainedBytes(snapshot, 64 * 1024 * 1024);
    if (snapshot.retainedSize > 64 * 1024 * 1024)
      throw new Error("workspace browser snapshot exceeds 64 MiB; use the CLI for this workspace");
    this.history = savedHistory ?? { key: historyKey, at: Date.now(), baselines, units: commitReviews, onHead };
    this.previous = {
      snapshot,
      stamps: snapshot.inputs,
      supportInputs,
      supportDigests,
      hashes,
      acquiredAt: Date.now(),
    };
    return snapshot;
  }
}
