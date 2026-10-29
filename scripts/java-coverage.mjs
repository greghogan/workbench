// Generated from java-coverage.mts; edit the TypeScript source.
import { required } from "./values.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImphdmEtY292ZXJhZ2UubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlsZVN1bW1hcnksIFN1bW1hcnksIE1ldHJpY05hbWUgfSBmcm9tIFwiLi9jb3ZlcmFnZS1zdW1tYXJ5Lm1qc1wiO1xuaW1wb3J0IHsgcmVxdWlyZWQgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuY29uc3QgbmFtZXM6IFJlY29yZDxzdHJpbmcsIE1ldHJpY05hbWU+ID0geyBMSU5FOiBcImxpbmVzXCIsIEJSQU5DSDogXCJicmFuY2hlc1wiLCBNRVRIT0Q6IFwiZnVuY3Rpb25zXCIgfTtcbmZ1bmN0aW9uIGNvdW50ZXJzKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHJlc3VsdDogRmlsZVN1bW1hcnkgPSB7fTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB4bWwubWF0Y2hBbGwoLzxjb3VudGVyIHR5cGU9XCIoW0EtWl0rKVwiIG1pc3NlZD1cIihcXGQrKVwiIGNvdmVyZWQ9XCIoXFxkKylcIlxccypcXC8+L2cpKSB7XG4gICAgY29uc3QgbmFtZSA9IG5hbWVzW3JlcXVpcmVkKG1hdGNoWzFdLCBcIk1pc3NpbmcgSmFDb0NvIGNvdW50ZXIgbmFtZVwiKV07XG4gICAgaWYgKCFuYW1lKSBjb250aW51ZTtcbiAgICBjb25zdCBjb3ZlcmVkID0gTnVtYmVyKG1hdGNoWzNdKTtcbiAgICBjb25zdCB0b3RhbCA9IGNvdmVyZWQgKyBOdW1iZXIobWF0Y2hbMl0pO1xuICAgIGlmIChyZXN1bHRbbmFtZV0gfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRvdGFsKSkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBKYUNvQ28gY291bnRlcnNcIik7XG4gICAgcmVzdWx0W25hbWVdID0geyB0b3RhbCwgY292ZXJlZCwgc2tpcHBlZDogMCwgcGN0OiB0b3RhbCA/IE1hdGguZmxvb3IoKGNvdmVyZWQgLyB0b3RhbCkgKiAxMDAwMCkgLyAxMDAgOiAxMDAgfTtcbiAgfVxuICBpZiAoIXJlc3VsdC5saW5lcykgdGhyb3cgbmV3IEVycm9yKFwiSmFDb0NvIHJlcG9ydCBoYXMgbm8gbGluZSBjb3VudGVyc1wiKTtcbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLyoqIFJlYWQgb25seSBKYUNvQ28ncyBnZW5lcmF0ZWQgcmVwb3J0IHNoYXBlOyBuZXZlciByZXNvbHZlIGl0cyBleHRlcm5hbCBEVEQgb3Igb3RoZXIgZW50aXRpZXMuICovXG5leHBvcnQgZnVuY3Rpb24gamF2YUNvdmVyYWdlU3VtbWFyeSh4bWw6IHN0cmluZyk6IFN1bW1hcnkge1xuICBpZiAoIS9ePFxcP3htbFtePl0qPlxccyooPzo8IURPQ1RZUEUgcmVwb3J0W14+XSo+XFxzKik/PHJlcG9ydFxcYi8udGVzdCh4bWwpKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIEphQ29DbyByZXBvcnRcIik7XG4gIGNvbnN0IHN1bW1hcnk6IFN1bW1hcnkgPSB7fTtcbiAgZm9yIChjb25zdCBwYWNrYWdlTWF0Y2ggb2YgeG1sLm1hdGNoQWxsKC88cGFja2FnZSBuYW1lPVwiKFtcXHcvJC5dKilcIj4oW1xcc1xcU10qPyk8XFwvcGFja2FnZT4vZykpIHtcbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgcmVxdWlyZWQocGFja2FnZU1hdGNoWzJdLCBcIk1pc3NpbmcgSmFDb0NvIHBhY2thZ2UgYm9keVwiKS5tYXRjaEFsbChcbiAgICAgIC88c291cmNlZmlsZSBuYW1lPVwiKFtcXHckLi1dK1xcLmphdmEpXCI+KFtcXHNcXFNdKj8pPFxcL3NvdXJjZWZpbGU+L2csXG4gICAgKSkge1xuICAgICAgY29uc3QgcGF0aCA9IGBzcmMvbWFpbi9qYXZhLyR7cGFja2FnZU1hdGNoWzFdID8gcGFja2FnZU1hdGNoWzFdICsgXCIvXCIgOiBcIlwifSR7U3RyaW5nKGZpbGVbMV0pfWA7XG4gICAgICBpZiAocGF0aC5zcGxpdChcIi9cIikuc29tZSgocGFydCkgPT4gcGFydCA9PT0gXCIuXCIgfHwgcGFydCA9PT0gXCIuLlwiKSB8fCBzdW1tYXJ5W3BhdGhdKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIEphQ29DbyBzb3VyY2UgcGF0aFwiKTtcbiAgICAgIHN1bW1hcnlbcGF0aF0gPSBjb3VudGVycyhyZXF1aXJlZChmaWxlWzJdLCBcIk1pc3NpbmcgSmFDb0NvIGZpbGUgY291bnRlcnNcIikpO1xuICAgIH1cbiAgfVxuICBpZiAoIU9iamVjdC5rZXlzKHN1bW1hcnkpLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiSmFDb0NvIHJlcG9ydCBoYXMgbm8gc291cmNlIGZpbGVzXCIpO1xuICBjb25zdCB0b3RhbCA9IGNvdW50ZXJzKHhtbC5yZXBsYWNlKC88cGFja2FnZVxcYltcXHNcXFNdKj88XFwvcGFja2FnZT4vZywgXCJcIikpO1xuICByZXR1cm4geyB0b3RhbCwgLi4uT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKHN1bW1hcnkpLnNvcnQoKFthXSwgW2JdKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB9O1xufVxuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlSmF2YUNvdmVyYWdlKHhtbDogc3RyaW5nLCByb290OiBzdHJpbmcpIHtcbiAgY29uc3Qgc3VtbWFyeSA9IGphdmFDb3ZlcmFnZVN1bW1hcnkoeG1sKTtcbiAgbWtkaXJTeW5jKGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihyb290LCBcImNvdmVyYWdlL2NvdmVyYWdlLXN1bW1hcnkuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoc3VtbWFyeSwgbnVsbCwgMikgKyBcIlxcblwiKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUNBLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsV0FBVyxxQkFBcUI7QUFDekMsU0FBUyxZQUFZO0FBRXJCLE1BQU0sUUFBb0MsRUFBRSxNQUFNLFNBQVMsUUFBUSxZQUFZLFFBQVEsWUFBWTtBQUNuRyxTQUFTLFNBQVMsS0FBYTtBQUM3QixRQUFNLFNBQXNCLENBQUM7QUFDN0IsYUFBVyxTQUFTLElBQUksU0FBUyxnRUFBZ0UsR0FBRztBQUNsRyxVQUFNLE9BQU8sTUFBTSxTQUFTLE1BQU0sQ0FBQyxHQUFHLDZCQUE2QixDQUFDO0FBQ3BFLFFBQUksQ0FBQyxLQUFNO0FBQ1gsVUFBTSxVQUFVLE9BQU8sTUFBTSxDQUFDLENBQUM7QUFDL0IsVUFBTSxRQUFRLFVBQVUsT0FBTyxNQUFNLENBQUMsQ0FBQztBQUN2QyxRQUFJLE9BQU8sSUFBSSxLQUFLLENBQUMsT0FBTyxjQUFjLEtBQUssRUFBRyxPQUFNLElBQUksTUFBTSx5QkFBeUI7QUFDM0YsV0FBTyxJQUFJLElBQUksRUFBRSxPQUFPLFNBQVMsU0FBUyxHQUFHLEtBQUssUUFBUSxLQUFLLE1BQU8sVUFBVSxRQUFTLEdBQUssSUFBSSxNQUFNLElBQUk7QUFBQSxFQUM5RztBQUNBLE1BQUksQ0FBQyxPQUFPLE1BQU8sT0FBTSxJQUFJLE1BQU0sb0NBQW9DO0FBQ3ZFLFNBQU87QUFDVDtBQUdPLFNBQVMsb0JBQW9CLEtBQXNCO0FBQ3hELE1BQUksQ0FBQywwREFBMEQsS0FBSyxHQUFHLEVBQUcsT0FBTSxJQUFJLE1BQU0sdUJBQXVCO0FBQ2pILFFBQU0sVUFBbUIsQ0FBQztBQUMxQixhQUFXLGdCQUFnQixJQUFJLFNBQVMsbURBQW1ELEdBQUc7QUFDNUYsZUFBVyxRQUFRLFNBQVMsYUFBYSxDQUFDLEdBQUcsNkJBQTZCLEVBQUU7QUFBQSxNQUMxRTtBQUFBLElBQ0YsR0FBRztBQUNELFlBQU0sT0FBTyxpQkFBaUIsYUFBYSxDQUFDLElBQUksYUFBYSxDQUFDLElBQUksTUFBTSxFQUFFLEdBQUcsT0FBTyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQzVGLFVBQUksS0FBSyxNQUFNLEdBQUcsRUFBRSxLQUFLLENBQUMsU0FBUyxTQUFTLE9BQU8sU0FBUyxJQUFJLEtBQUssUUFBUSxJQUFJO0FBQy9FLGNBQU0sSUFBSSxNQUFNLDRCQUE0QjtBQUM5QyxjQUFRLElBQUksSUFBSSxTQUFTLFNBQVMsS0FBSyxDQUFDLEdBQUcsOEJBQThCLENBQUM7QUFBQSxJQUM1RTtBQUFBLEVBQ0Y7QUFDQSxNQUFJLENBQUMsT0FBTyxLQUFLLE9BQU8sRUFBRSxPQUFRLE9BQU0sSUFBSSxNQUFNLG1DQUFtQztBQUNyRixRQUFNLFFBQVEsU0FBUyxJQUFJLFFBQVEsa0NBQWtDLEVBQUUsQ0FBQztBQUN4RSxTQUFPLEVBQUUsT0FBTyxHQUFHLE9BQU8sWUFBWSxPQUFPLFFBQVEsT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN4RztBQUNPLFNBQVMsa0JBQWtCLEtBQWEsTUFBYztBQUMzRCxRQUFNLFVBQVUsb0JBQW9CLEdBQUc7QUFDdkMsWUFBVSxLQUFLLE1BQU0sVUFBVSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckQsZ0JBQWMsS0FBSyxNQUFNLGdDQUFnQyxHQUFHLEtBQUssVUFBVSxTQUFTLE1BQU0sQ0FBQyxJQUFJLElBQUk7QUFDckc7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9qYXZhLWNvdmVyYWdlLm1qcyJ9
