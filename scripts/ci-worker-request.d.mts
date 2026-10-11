import type { CITarget } from "../src/ci-targets.js";
export interface CIWorkerRequest {
  version: 1;
  workspace: string;
  distribution: string;
  target: CITarget;
  reports: string;
  image?: string;
  cache: string;
  shared: Record<string, string>;
  adapter: string;
  uid: number;
  gid: number;
}
export function parseCIWorkerRequest(value: unknown): CIWorkerRequest;
