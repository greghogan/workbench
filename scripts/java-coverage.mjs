// Generated from java-coverage.mts; edit the TypeScript source.
import { required } from "../app/src/core/runtime/values.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const names = { LINE: "lines", BRANCH: "branches", METHOD: "functions" };
function counters(xml) {
  const result = {};
  for (const match of xml.matchAll(/<counter type="([A-Z]+)" missed="(\d+)" covered="(\d+)"\s*\/>/g)) {
    const name = names[required(match[1], "Missing JaCoCo counter name")];
    if (!name) continue;
    const covered = Number(match[3]);
    const total = covered + Number(match[2]);
    if (result[name] || !Number.isSafeInteger(total)) throw new Error("Invalid JaCoCo counters");
    result[name] = { total, covered, skipped: 0, pct: total ? Math.floor(covered / total * 1e4) / 100 : 100 };
  }
  if (!result.lines) throw new Error("JaCoCo report has no line counters");
  return result;
}
function javaCoverageSummary(xml) {
  if (!/^<\?xml[^>]*>\s*(?:<!DOCTYPE report[^>]*>\s*)?<report\b/.test(xml)) throw new Error("Invalid JaCoCo report");
  const summary = {};
  for (const packageMatch of xml.matchAll(/<package name="([\w/$.]*)">([\s\S]*?)<\/package>/g)) {
    for (const file of required(packageMatch[2], "Missing JaCoCo package body").matchAll(
      /<sourcefile name="([\w$.-]+\.java)">([\s\S]*?)<\/sourcefile>/g
    )) {
      const path = `src/main/java/${packageMatch[1] ? packageMatch[1] + "/" : ""}${String(file[1])}`;
      if (path.split("/").some((part) => part === "." || part === "..") || summary[path])
        throw new Error("Invalid JaCoCo source path");
      summary[path] = counters(required(file[2], "Missing JaCoCo file counters"));
    }
  }
  if (!Object.keys(summary).length) throw new Error("JaCoCo report has no source files");
  const total = counters(xml.replace(/<package\b[\s\S]*?<\/package>/g, ""));
  return { total, ...Object.fromEntries(Object.entries(summary).sort(([a], [b]) => a.localeCompare(b))) };
}
function writeJavaCoverage(xml, root) {
  const summary = javaCoverageSummary(xml);
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeFileSync(join(root, "coverage/coverage-summary.json"), JSON.stringify(summary, null, 2) + "\n");
}
export {
  javaCoverageSummary,
  writeJavaCoverage
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImphdmEtY292ZXJhZ2UubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlsZVN1bW1hcnksIFN1bW1hcnksIE1ldHJpY05hbWUgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaGVja3MvY292ZXJhZ2Utc3VtbWFyeS5tanNcIjtcbmltcG9ydCB7IHJlcXVpcmVkIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5jb25zdCBuYW1lczogUmVjb3JkPHN0cmluZywgTWV0cmljTmFtZT4gPSB7IExJTkU6IFwibGluZXNcIiwgQlJBTkNIOiBcImJyYW5jaGVzXCIsIE1FVEhPRDogXCJmdW5jdGlvbnNcIiB9O1xuZnVuY3Rpb24gY291bnRlcnMoeG1sOiBzdHJpbmcpIHtcbiAgY29uc3QgcmVzdWx0OiBGaWxlU3VtbWFyeSA9IHt9O1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHhtbC5tYXRjaEFsbCgvPGNvdW50ZXIgdHlwZT1cIihbQS1aXSspXCIgbWlzc2VkPVwiKFxcZCspXCIgY292ZXJlZD1cIihcXGQrKVwiXFxzKlxcLz4vZykpIHtcbiAgICBjb25zdCBuYW1lID0gbmFtZXNbcmVxdWlyZWQobWF0Y2hbMV0sIFwiTWlzc2luZyBKYUNvQ28gY291bnRlciBuYW1lXCIpXTtcbiAgICBpZiAoIW5hbWUpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvdmVyZWQgPSBOdW1iZXIobWF0Y2hbM10pO1xuICAgIGNvbnN0IHRvdGFsID0gY292ZXJlZCArIE51bWJlcihtYXRjaFsyXSk7XG4gICAgaWYgKHJlc3VsdFtuYW1lXSB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIodG90YWwpKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIEphQ29DbyBjb3VudGVyc1wiKTtcbiAgICByZXN1bHRbbmFtZV0gPSB7IHRvdGFsLCBjb3ZlcmVkLCBza2lwcGVkOiAwLCBwY3Q6IHRvdGFsID8gTWF0aC5mbG9vcigoY292ZXJlZCAvIHRvdGFsKSAqIDEwMDAwKSAvIDEwMCA6IDEwMCB9O1xuICB9XG4gIGlmICghcmVzdWx0LmxpbmVzKSB0aHJvdyBuZXcgRXJyb3IoXCJKYUNvQ28gcmVwb3J0IGhhcyBubyBsaW5lIGNvdW50ZXJzXCIpO1xuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKiogUmVhZCBvbmx5IEphQ29DbydzIGdlbmVyYXRlZCByZXBvcnQgc2hhcGU7IG5ldmVyIHJlc29sdmUgaXRzIGV4dGVybmFsIERURCBvciBvdGhlciBlbnRpdGllcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBqYXZhQ292ZXJhZ2VTdW1tYXJ5KHhtbDogc3RyaW5nKTogU3VtbWFyeSB7XG4gIGlmICghL148XFw/eG1sW14+XSo+XFxzKig/OjwhRE9DVFlQRSByZXBvcnRbXj5dKj5cXHMqKT88cmVwb3J0XFxiLy50ZXN0KHhtbCkpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgSmFDb0NvIHJlcG9ydFwiKTtcbiAgY29uc3Qgc3VtbWFyeTogU3VtbWFyeSA9IHt9O1xuICBmb3IgKGNvbnN0IHBhY2thZ2VNYXRjaCBvZiB4bWwubWF0Y2hBbGwoLzxwYWNrYWdlIG5hbWU9XCIoW1xcdy8kLl0qKVwiPihbXFxzXFxTXSo/KTxcXC9wYWNrYWdlPi9nKSkge1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiByZXF1aXJlZChwYWNrYWdlTWF0Y2hbMl0sIFwiTWlzc2luZyBKYUNvQ28gcGFja2FnZSBib2R5XCIpLm1hdGNoQWxsKFxuICAgICAgLzxzb3VyY2VmaWxlIG5hbWU9XCIoW1xcdyQuLV0rXFwuamF2YSlcIj4oW1xcc1xcU10qPyk8XFwvc291cmNlZmlsZT4vZyxcbiAgICApKSB7XG4gICAgICBjb25zdCBwYXRoID0gYHNyYy9tYWluL2phdmEvJHtwYWNrYWdlTWF0Y2hbMV0gPyBwYWNrYWdlTWF0Y2hbMV0gKyBcIi9cIiA6IFwiXCJ9JHtTdHJpbmcoZmlsZVsxXSl9YDtcbiAgICAgIGlmIChwYXRoLnNwbGl0KFwiL1wiKS5zb21lKChwYXJ0KSA9PiBwYXJ0ID09PSBcIi5cIiB8fCBwYXJ0ID09PSBcIi4uXCIpIHx8IHN1bW1hcnlbcGF0aF0pXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgSmFDb0NvIHNvdXJjZSBwYXRoXCIpO1xuICAgICAgc3VtbWFyeVtwYXRoXSA9IGNvdW50ZXJzKHJlcXVpcmVkKGZpbGVbMl0sIFwiTWlzc2luZyBKYUNvQ28gZmlsZSBjb3VudGVyc1wiKSk7XG4gICAgfVxuICB9XG4gIGlmICghT2JqZWN0LmtleXMoc3VtbWFyeSkubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJKYUNvQ28gcmVwb3J0IGhhcyBubyBzb3VyY2UgZmlsZXNcIik7XG4gIGNvbnN0IHRvdGFsID0gY291bnRlcnMoeG1sLnJlcGxhY2UoLzxwYWNrYWdlXFxiW1xcc1xcU10qPzxcXC9wYWNrYWdlPi9nLCBcIlwiKSk7XG4gIHJldHVybiB7IHRvdGFsLCAuLi5PYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoc3VtbWFyeSkuc29ydCgoW2FdLCBbYl0pID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIH07XG59XG5leHBvcnQgZnVuY3Rpb24gd3JpdGVKYXZhQ292ZXJhZ2UoeG1sOiBzdHJpbmcsIHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBzdW1tYXJ5ID0gamF2YUNvdmVyYWdlU3VtbWFyeSh4bWwpO1xuICBta2RpclN5bmMoam9pbihyb290LCBcImNvdmVyYWdlXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHJvb3QsIFwiY292ZXJhZ2UvY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShzdW1tYXJ5LCBudWxsLCAyKSArIFwiXFxuXCIpO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FB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
