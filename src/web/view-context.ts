import type { WorkspaceView } from "../workspace-service.js";
import type { BrowserRecord } from "../record-service.js";
export type PageKey = BrowserRecord["type"] | "" | "records" | "review" | "collections";
export type SearchType = BrowserRecord["type"] | "";
export type ViewContext = WorkspaceView & {
  csrf: string;
  refreshing: boolean;
  problem: string;
  requestLocation?: string;
  basePath?: string;
  projectName?: string;
  demonstration?: boolean;
  collectionDefaults?: { source: string; commit: string };
};
