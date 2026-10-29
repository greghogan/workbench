import { appendFileSync } from "node:fs";
import { describeError } from "./diagnostic-errors.mjs";
import { redact, boundedText } from "./diagnostic-text.mjs";

/** The same actionable cause appears in plain logs, a job annotation, and the job summary. */
export function reportCIFailure(operation: string, error: unknown): void {
  const description = describeError(error);
  const message = boundedText(
    redact(description.startsWith(operation + ":") ? description : `${operation}: ${description}`),
    12000,
  ).text;
  console.error(
    process.env.GITHUB_ACTIONS === "true"
      ? `::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`
      : message,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### Operation failed\n\n<pre>${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>\n\nFull command output is retained in this job’s logs and any uploaded operation evidence.\n`,
      );
    } catch (cause) {
      console.error(`Could not append the CI failure summary: ${describeError(cause)}`);
    }
  }
}

export async function runCIEntry(operation: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    reportCIFailure(operation, error);
    process.exitCode = 1;
  }
}
