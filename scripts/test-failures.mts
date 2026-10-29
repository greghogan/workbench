import { stripVTControlCharacters } from "node:util";
import { isRecord } from "./values.mjs";
import { boundedText, redact } from "./diagnostic-text.mjs";

/** Keep the useful failed assertions inside the gate's bounded failure excerpt. */
export function testFailureSummary(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.testResults)) return "";
  const failures: string[] = [];
  let omitted = 0;
  for (const suite of value.testResults) {
    if (!isRecord(suite) || !Array.isArray(suite.assertionResults)) continue;
    for (const result of suite.assertionResults) {
      if (!isRecord(result) || result.status !== "failed") continue;
      if (failures.length >= 6) {
        omitted++;
        continue;
      }
      const name =
        typeof result.fullName === "string"
          ? result.fullName
          : typeof result.title === "string"
            ? result.title
            : "Unnamed test";
      const messages = Array.isArray(result.failureMessages)
        ? result.failureMessages.filter((entry): entry is string => typeof entry === "string")
        : [];
      const message = stripVTControlCharacters(messages.join(" "))
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 2)
        .join(" ");
      failures.push(boundedText(redact(`${name}: ${message}`).replace(/\s+/g, " "), 500).text);
    }
  }
  return failures.length
    ? `Failed tests:\n${failures.map((line) => `- ${line}`).join("\n")}${omitted ? `\n${String(omitted)} additional failed tests; see the retained test report and full log.` : ""}`
    : "";
}
