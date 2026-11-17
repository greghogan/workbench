import { ProjectHierarchy } from "../../core/projects/project-hierarchy.js";
import type { Project } from "../../core/projects/project-model.js";
import { compareRecordNumbers, normalizedNumber } from "../../core/records/record-identity.js";
import { reviewOwner } from "./review-membership.js";
import type { BrowserRecord } from "../../core/records/record-service.js";
import type { ReviewGroup, WorkspaceSnapshot } from "../workspace/workspace-service.js";
import { needsReview, type ReviewPreparation } from "./review-state.js";

export interface ReviewSection {
  key: string;
  title: string;
  groups: ReviewGroup[];
}
export type ReviewItem = ReviewGroup | { compatibility: true };
function compareGroups(a: ReviewGroup, b: ReviewGroup): number {
  const identity = (group: ReviewGroup) => {
    if (group.path.endsWith("/CHARTER.md")) return { rank: 0, number: "0" };
    const match = /\/(ADR|ENV|EXP)-([0-9A-Z]+)\.md$/.exec(group.path);
    return {
      rank: match?.[1] === "ADR" ? 1 : match?.[1] === "ENV" ? 2 : 3,
      number: normalizedNumber(match?.[2] ?? "0"),
    };
  };
  const left = identity(a),
    right = identity(b);
  return left.rank - right.rank || compareRecordNumbers(left.number, right.number) || a.path.localeCompare(b.path);
}
export const reviewCollection = (path: string): string =>
  /^workbench\/collections\/([a-z][a-z0-9_-]*)\//.exec(path)?.[1] ?? "";

/** One snapshot owns group membership, preparation eligibility, display order, and continuation. */
export class ReviewQueue {
  readonly byOwner = new Map<string, ReviewGroup>();
  readonly byId = new Map<string, ReviewGroup>();
  readonly byPath: Map<string, WorkspaceSnapshot["review"]["changes"][number]>;
  readonly pendingPaths = new Set<string>();
  readonly groups: ReviewGroup[];
  readonly pending: ReviewGroup[];
  readonly sections: ReviewSection[];
  private readonly scopes: string[];
  constructor(
    hierarchy: ProjectHierarchy,
    private readonly records: ReadonlyMap<string, BrowserRecord>,
    private readonly sources: string[],
    changes: WorkspaceSnapshot["review"]["changes"],
    private readonly preparation: ReadonlyMap<string, ReviewPreparation>,
    scopeForPath: (path: string) => Project | undefined,
  ) {
    this.scopes = hierarchy.projects.map((project) => project.path);
    this.byPath = new Map(changes.map((change) => [change.path, change]));
    for (const change of changes) {
      const path = this.owner(change.path);
      const collection = reviewCollection(path);
      const scope = collection || (scopeForPath(path)?.id ?? "");
      const name = /\/(ADR|EXP|ENV)-([0-9A-Z]+)\.md$/.exec(path);
      const id =
        records.get(path)?.id ??
        (name?.[1] && name[2]
          ? `${scope}:${name[1]}-${normalizedNumber(name[2])}`
          : path.endsWith("/CHARTER.md")
            ? `${scope}:CHARTER`
            : undefined);
      const group = this.byOwner.get(path) ?? {
        id,
        path,
        record: records.get(path),
        changes: [],
        collection,
        scope: collection ? "" : (scopeForPath(path)?.id ?? ""),
        pending: 0,
      };
      group.changes.push(change);
      if (this.needsReview(change)) {
        group.pending++;
        this.pendingPaths.add(path);
      }
      this.byOwner.set(path, group);
      if (group.id) this.byId.set(group.id, group);
    }
    const sections = new Map<string, ReviewSection>();
    for (const project of hierarchy.ordered())
      sections.set(`project:${project.id}`, {
        key: `project:${project.id}`,
        title: hierarchy.breadcrumb(project),
        groups: [],
      });
    const collections = new Map<string, ReviewSection>();
    for (const group of this.byOwner.values()) {
      const key = group.collection ? `collection:${group.collection}` : `project:${group.scope}`;
      if (group.collection && !collections.has(key))
        collections.set(key, { key, title: `Collection: ${group.collection}`, groups: [] });
      const section = group.collection ? collections.get(key) : sections.get(key);
      if (!section) throw new Error(`Review scope is unavailable: ${group.scope}`);
      section.groups.push(group);
    }
    const all = [...sections.values(), ...[...collections.values()].sort((a, b) => a.title.localeCompare(b.title))];
    for (const section of all) section.groups.sort(compareGroups);
    this.groups = all.flatMap((section) => section.groups);
    this.sections = all
      .map((section) => ({ ...section, groups: section.groups.filter((group) => group.pending > 0) }))
      .filter((section) => section.groups.length > 0);
    this.pending = this.sections.flatMap((section) => section.groups);
  }
  owner(path: string): string {
    return reviewOwner(path, this.scopes, this.sources, (owner) => this.records.has(owner) || this.byPath.has(owner));
  }
  needsReview(change: { path: string; approved: boolean }): boolean {
    return needsReview(change, this.preparation);
  }
  afterAcknowledgment(path: string, compatibility: boolean, groups = this.groups): ReviewItem | undefined {
    const group = this.byOwner.get(this.owner(path));
    if (group?.pending && groups.includes(group)) return group;
    const index = group ? groups.indexOf(group) : -1;
    for (let offset = 1; offset <= groups.length; offset++) {
      const next = groups[(index + offset) % groups.length];
      if (next?.pending) return next;
    }
    return compatibility ? { compatibility: true } : undefined;
  }
}
