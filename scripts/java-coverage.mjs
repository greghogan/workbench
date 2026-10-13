import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const names = { LINE: "lines", BRANCH: "branches", METHOD: "functions" };
function counters(xml) {
  const result = {};
  for (const match of xml.matchAll(/<counter type="([A-Z]+)" missed="(\d+)" covered="(\d+)"\s*\/>/g)) {
    const name = names[match[1]];
    if (!name) continue;
    const covered = Number(match[3]);
    const total = covered + Number(match[2]);
    if (result[name] || !Number.isSafeInteger(total)) throw new Error("Invalid JaCoCo counters");
    result[name] = { total, covered, skipped: 0, pct: total ? Math.floor((covered / total) * 10000) / 100 : 100 };
  }
  if (!result.lines) throw new Error("JaCoCo report has no line counters");
  return result;
}

/** Read only JaCoCo's generated report shape; never resolve its external DTD or other entities. */
export function javaCoverageSummary(xml) {
  if (!/^<\?xml[^>]*>\s*(?:<!DOCTYPE report[^>]*>\s*)?<report\b/.test(xml)) throw new Error("Invalid JaCoCo report");
  const summary = {};
  for (const packageMatch of xml.matchAll(/<package name="([\w/$.]*)">([\s\S]*?)<\/package>/g)) {
    for (const file of packageMatch[2].matchAll(/<sourcefile name="([\w$.-]+\.java)">([\s\S]*?)<\/sourcefile>/g)) {
      const path = `src/main/java/${packageMatch[1] ? packageMatch[1] + "/" : ""}${file[1]}`;
      if (path.split("/").some((part) => part === "." || part === "..") || summary[path])
        throw new Error("Invalid JaCoCo source path");
      summary[path] = counters(file[2]);
    }
  }
  if (!Object.keys(summary).length) throw new Error("JaCoCo report has no source files");
  const total = counters(xml.replace(/<package\b[\s\S]*?<\/package>/g, ""));
  return { total, ...Object.fromEntries(Object.entries(summary).sort(([a], [b]) => a.localeCompare(b))) };
}
export function writeJavaCoverage(xml, root) {
  const summary = javaCoverageSummary(xml);
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeFileSync(join(root, "coverage/coverage-summary.json"), JSON.stringify(summary, null, 2) + "\n");
}
