import type { WorkspaceView } from "../workspace-service.js";
import type { BrowserRecord } from "../record-service.js";
export type PageKey = BrowserRecord["type"] | "" | "records" | "review" | "collections" | "queue";
export type SearchType = BrowserRecord["type"] | "";
export type ViewContext = WorkspaceView & {
  collectionApplication?: import("./collection-service.js").CollectionApplication;
  csrf: string;
  refreshing: boolean;
  problem: string;
  requestLocation?: string;
  reviewTarget?: { id?: string; path?: string };
  basePath?: string;
  projectName?: string;
  demonstration?: boolean;
  collectionDefaults?: { source: string; commit: string };
};
