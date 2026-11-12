import { diagnosticError, restoreDiagnosticError, type DiagnosticError } from "./diagnostic-errors.mjs";

/** Bound both retained causes and the record explaining omissions. */
export class DiagnosticIssues {
  private readonly retained: DiagnosticError[] = [];
  private omitted = 0;
  add(error: unknown): void {
    const decoded = diagnosticError(
      error && typeof error === "object" && !(error instanceof Error) && "name" in error && "message" in error
        ? restoreDiagnosticError(error)
        : error,
    );
    if (decoded.name === "Omitted" && decoded.omittedCauses) this.omitted += decoded.omittedCauses;
    else if (this.retained.length < 31) this.retained.push(decoded);
    else this.omitted++;
  }
  clear(): void {
    this.retained.length = 0;
    this.omitted = 0;
  }
  get count(): number {
    return this.retained.length + this.omitted;
  }
  snapshot(): DiagnosticError[] {
    return [
      ...this.retained,
      ...(this.omitted
        ? [{ name: "Omitted", message: "Additional diagnostic issues omitted", omittedCauses: this.omitted }]
        : []),
    ];
  }
}
