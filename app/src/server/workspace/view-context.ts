import type { WorkspaceView } from "./workspace-service.js";
import type { BrowserRecord } from "../../core/records/record-service.js";
export type PageKey = BrowserRecord["type"] | "" | "records" | "review" | "collections" | "plans" | "work";
export type SearchType = BrowserRecord["type"] | "";
export type ViewContext = WorkspaceView & {
  collectionApplication?: import("../projects/collection-service.js").CollectionApplication;
  csrf: string;
  refreshing: boolean;
  problem: string;
  requestLocation?: string;
  workflow?: boolean;
  reviewTarget?: { id?: string; path?: string };
  basePath?: string;
  projectName?: string;
  demonstration?: boolean;
  collectionDefaults?: { source: string; commit: string };
};
