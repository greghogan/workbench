// Generated from java-coverage.mts; edit the TypeScript source.
import { required } from "../app/src/core/runtime/values.mjs";
import { mkdirSync } from "node:fs";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";
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
    result[name] = { total, covered };
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
  return Object.fromEntries(Object.entries(summary).sort(([a], [b]) => a.localeCompare(b)));
}
function writeJavaCoverage(xml, root) {
  const summary = javaCoverageSummary(xml);
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeAtomic(join(root, "coverage/coverage-summary.json"), JSON.stringify(summary, null, 2) + "\n");
}
export {
  javaCoverageSummary,
  writeJavaCoverage
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImphdmEtY292ZXJhZ2UubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlsZVN1bW1hcnksIFN1bW1hcnksIE1ldHJpY05hbWUgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaGVja3MvY292ZXJhZ2Utc3VtbWFyeS5tanNcIjtcbmltcG9ydCB7IHJlcXVpcmVkIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IG1rZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB3cml0ZUF0b21pYyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS9maWxlLXB1YmxpY2F0aW9uLm1qc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuY29uc3QgbmFtZXM6IFJlY29yZDxzdHJpbmcsIE1ldHJpY05hbWU+ID0geyBMSU5FOiBcImxpbmVzXCIsIEJSQU5DSDogXCJicmFuY2hlc1wiLCBNRVRIT0Q6IFwiZnVuY3Rpb25zXCIgfTtcbmZ1bmN0aW9uIGNvdW50ZXJzKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHJlc3VsdDogRmlsZVN1bW1hcnkgPSB7fTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB4bWwubWF0Y2hBbGwoLzxjb3VudGVyIHR5cGU9XCIoW0EtWl0rKVwiIG1pc3NlZD1cIihcXGQrKVwiIGNvdmVyZWQ9XCIoXFxkKylcIlxccypcXC8+L2cpKSB7XG4gICAgY29uc3QgbmFtZSA9IG5hbWVzW3JlcXVpcmVkKG1hdGNoWzFdLCBcIk1pc3NpbmcgSmFDb0NvIGNvdW50ZXIgbmFtZVwiKV07XG4gICAgaWYgKCFuYW1lKSBjb250aW51ZTtcbiAgICBjb25zdCBjb3ZlcmVkID0gTnVtYmVyKG1hdGNoWzNdKTtcbiAgICBjb25zdCB0b3RhbCA9IGNvdmVyZWQgKyBOdW1iZXIobWF0Y2hbMl0pO1xuICAgIGlmIChyZXN1bHRbbmFtZV0gfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRvdGFsKSkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBKYUNvQ28gY291bnRlcnNcIik7XG4gICAgcmVzdWx0W25hbWVdID0geyB0b3RhbCwgY292ZXJlZCB9O1xuICB9XG4gIGlmICghcmVzdWx0LmxpbmVzKSB0aHJvdyBuZXcgRXJyb3IoXCJKYUNvQ28gcmVwb3J0IGhhcyBubyBsaW5lIGNvdW50ZXJzXCIpO1xuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKiogUmVhZCBvbmx5IEphQ29DbydzIGdlbmVyYXRlZCByZXBvcnQgc2hhcGU7IG5ldmVyIHJlc29sdmUgaXRzIGV4dGVybmFsIERURCBvciBvdGhlciBlbnRpdGllcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBqYXZhQ292ZXJhZ2VTdW1tYXJ5KHhtbDogc3RyaW5nKTogU3VtbWFyeSB7XG4gIGlmICghL148XFw/eG1sW14+XSo+XFxzKig/OjwhRE9DVFlQRSByZXBvcnRbXj5dKj5cXHMqKT88cmVwb3J0XFxiLy50ZXN0KHhtbCkpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgSmFDb0NvIHJlcG9ydFwiKTtcbiAgY29uc3Qgc3VtbWFyeTogU3VtbWFyeSA9IHt9O1xuICBmb3IgKGNvbnN0IHBhY2thZ2VNYXRjaCBvZiB4bWwubWF0Y2hBbGwoLzxwYWNrYWdlIG5hbWU9XCIoW1xcdy8kLl0qKVwiPihbXFxzXFxTXSo/KTxcXC9wYWNrYWdlPi9nKSkge1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiByZXF1aXJlZChwYWNrYWdlTWF0Y2hbMl0sIFwiTWlzc2luZyBKYUNvQ28gcGFja2FnZSBib2R5XCIpLm1hdGNoQWxsKFxuICAgICAgLzxzb3VyY2VmaWxlIG5hbWU9XCIoW1xcdyQuLV0rXFwuamF2YSlcIj4oW1xcc1xcU10qPyk8XFwvc291cmNlZmlsZT4vZyxcbiAgICApKSB7XG4gICAgICBjb25zdCBwYXRoID0gYHNyYy9tYWluL2phdmEvJHtwYWNrYWdlTWF0Y2hbMV0gPyBwYWNrYWdlTWF0Y2hbMV0gKyBcIi9cIiA6IFwiXCJ9JHtTdHJpbmcoZmlsZVsxXSl9YDtcbiAgICAgIGlmIChwYXRoLnNwbGl0KFwiL1wiKS5zb21lKChwYXJ0KSA9PiBwYXJ0ID09PSBcIi5cIiB8fCBwYXJ0ID09PSBcIi4uXCIpIHx8IHN1bW1hcnlbcGF0aF0pXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgSmFDb0NvIHNvdXJjZSBwYXRoXCIpO1xuICAgICAgc3VtbWFyeVtwYXRoXSA9IGNvdW50ZXJzKHJlcXVpcmVkKGZpbGVbMl0sIFwiTWlzc2luZyBKYUNvQ28gZmlsZSBjb3VudGVyc1wiKSk7XG4gICAgfVxuICB9XG4gIGlmICghT2JqZWN0LmtleXMoc3VtbWFyeSkubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJKYUNvQ28gcmVwb3J0IGhhcyBubyBzb3VyY2UgZmlsZXNcIik7XG4gIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoc3VtbWFyeSkuc29ydCgoW2FdLCBbYl0pID0+IGEubG9jYWxlQ29tcGFyZShiKSkpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlSmF2YUNvdmVyYWdlKHhtbDogc3RyaW5nLCByb290OiBzdHJpbmcpIHtcbiAgY29uc3Qgc3VtbWFyeSA9IGphdmFDb3ZlcmFnZVN1bW1hcnkoeG1sKTtcbiAgbWtkaXJTeW5jKGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlQXRvbWljKGpvaW4ocm9vdCwgXCJjb3ZlcmFnZS9jb3ZlcmFnZS1zdW1tYXJ5Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHN1bW1hcnksIG51bGwsIDIpICsgXCJcXG5cIik7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFDQSxTQUFTLGdCQUFnQjtBQUN6QixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLFlBQVk7QUFFckIsTUFBTSxRQUFvQyxFQUFFLE1BQU0sU0FBUyxRQUFRLFlBQVksUUFBUSxZQUFZO0FBQ25HLFNBQVMsU0FBUyxLQUFhO0FBQzdCLFFBQU0sU0FBc0IsQ0FBQztBQUM3QixhQUFXLFNBQVMsSUFBSSxTQUFTLGdFQUFnRSxHQUFHO0FBQ2xHLFVBQU0sT0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsNkJBQTZCLENBQUM7QUFDcEUsUUFBSSxDQUFDLEtBQU07QUFDWCxVQUFNLFVBQVUsT0FBTyxNQUFNLENBQUMsQ0FBQztBQUMvQixVQUFNLFFBQVEsVUFBVSxPQUFPLE1BQU0sQ0FBQyxDQUFDO0FBQ3ZDLFFBQUksT0FBTyxJQUFJLEtBQUssQ0FBQyxPQUFPLGNBQWMsS0FBSyxFQUFHLE9BQU0sSUFBSSxNQUFNLHlCQUF5QjtBQUMzRixXQUFPLElBQUksSUFBSSxFQUFFLE9BQU8sUUFBUTtBQUFBLEVBQ2xDO0FBQ0EsTUFBSSxDQUFDLE9BQU8sTUFBTyxPQUFNLElBQUksTUFBTSxvQ0FBb0M7QUFDdkUsU0FBTztBQUNUO0FBR08sU0FBUyxvQkFBb0IsS0FBc0I7QUFDeEQsTUFBSSxDQUFDLDBEQUEwRCxLQUFLLEdBQUcsRUFBRyxPQUFNLElBQUksTUFBTSx1QkFBdUI7QUFDakgsUUFBTSxVQUFtQixDQUFDO0FBQzFCLGFBQVcsZ0JBQWdCLElBQUksU0FBUyxtREFBbUQsR0FBRztBQUM1RixlQUFXLFFBQVEsU0FBUyxhQUFhLENBQUMsR0FBRyw2QkFBNkIsRUFBRTtBQUFBLE1BQzFFO0FBQUEsSUFDRixHQUFHO0FBQ0QsWUFBTSxPQUFPLGlCQUFpQixhQUFhLENBQUMsSUFBSSxhQUFhLENBQUMsSUFBSSxNQUFNLEVBQUUsR0FBRyxPQUFPLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDNUYsVUFBSSxLQUFLLE1BQU0sR0FBRyxFQUFFLEtBQUssQ0FBQyxTQUFTLFNBQVMsT0FBTyxTQUFTLElBQUksS0FBSyxRQUFRLElBQUk7QUFDL0UsY0FBTSxJQUFJLE1BQU0sNEJBQTRCO0FBQzlDLGNBQVEsSUFBSSxJQUFJLFNBQVMsU0FBUyxLQUFLLENBQUMsR0FBRyw4QkFBOEIsQ0FBQztBQUFBLElBQzVFO0FBQUEsRUFDRjtBQUNBLE1BQUksQ0FBQyxPQUFPLEtBQUssT0FBTyxFQUFFLE9BQVEsT0FBTSxJQUFJLE1BQU0sbUNBQW1DO0FBQ3JGLFNBQU8sT0FBTyxZQUFZLE9BQU8sUUFBUSxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQUMxRjtBQUNPLFNBQVMsa0JBQWtCLEtBQWEsTUFBYztBQUMzRCxRQUFNLFVBQVUsb0JBQW9CLEdBQUc7QUFDdkMsWUFBVSxLQUFLLE1BQU0sVUFBVSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckQsY0FBWSxLQUFLLE1BQU0sZ0NBQWdDLEdBQUcsS0FBSyxVQUFVLFNBQVMsTUFBTSxDQUFDLElBQUksSUFBSTtBQUNuRzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL2phdmEtY292ZXJhZ2UubWpzIn0=
