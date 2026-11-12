import { basename } from "node:path";
import * as feedback from "../core/feedback/feedback.js";
export function addFeedback(title: string): void {
  const path = feedback.addFeedback(title);
  console.log(`Created feedback ${basename(path, ".md")} at ${path}`);
}
export function resolveFeedback(...args: Parameters<typeof feedback.resolveFeedback>): void {
  console.log(`Resolved feedback at ${feedback.resolveFeedback(...args)}`);
}
export function showFeedback(id: string, json = false): void {
  const record = feedback.readFeedback(id);
  console.log(json ? JSON.stringify(record, null, 2) : `${record.path}\n${record.contents}`);
}
export function queryFeedback(options: { all?: boolean; json?: boolean }, query?: string): void {
  const results = feedback.queryFeedback(options, query);
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else if (!results.length) console.log("No matching feedback.");
  else for (const result of results) console.log(`${result.id}: ${result.title} (${String(result.disposition)})`);
}
