export interface TargetResult {
  id: string;
  success: boolean;
  error?: string;
  report: string;
  started?: string;
  finished?: string;
}
export interface InfrastructureError {
  phase: string;
  message: string;
}
export interface RunReport {
  version: 1;
  targets: TargetResult[];
  errors: InfrastructureError[];
}
export function errorMessage(error: unknown): string;
export function reportDirectory(reports: string, id: string): string;
export function createRunReport(ids: string[], reports: string): RunReport;
export function parseRunReport(value: unknown, ids: string[], reports: string): RunReport;
export function writeRunReport(path: string, report: RunReport): void;
export function runReportedTarget(run: RunReport, id: string, coverage: string, action: (report: string) => void): void;
export function runSucceeded(run: RunReport): boolean;
export function runSummary(run: RunReport, reports: string): string;
