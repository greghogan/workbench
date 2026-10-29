// Generated from java-test-reports.mts; edit the TypeScript source.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { publishDirectory } from "./directory-publication.mjs";
function retainJavaTestReports(reports, root, run) {
  const coverage = join(root, "coverage"), destination = join(coverage, "surefire");
  for (const path of [coverage, destination])
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Java test reports must not traverse a symbolic link: ${path}`);
  mkdirSync(coverage, { recursive: true });
  const transaction = mkdtempSync(join(coverage, ".surefire-"));
  const incoming = join(transaction, "incoming"), previous = join(transaction, "previous");
  let published = false;
  try {
    mkdirSync(incoming);
    if (existsSync(reports)) {
      if (lstatSync(reports).isSymbolicLink()) throw new Error("Java test reports must not be symbolic links");
      for (const entry of readdirSync(reports, { recursive: true, withFileTypes: true }))
        if (entry.isSymbolicLink()) throw new Error("Java test reports must not contain symbolic links");
      cpSync(reports, incoming, { recursive: true });
    }
    const hasReports = readdirSync(incoming).some((name) => name.endsWith(".xml"));
    writeFileSync(
      join(incoming, ".workbench-run.json"),
      JSON.stringify(
        {
          schema: 1,
          runId: randomUUID(),
          ...run,
          finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
          outcome: !hasReports ? "missing" : run.status === 0 && !run.signal && !run.error ? "passed" : "failed"
        },
        null,
        2
      ) + "\n"
    );
    publishDirectory(incoming, destination, previous);
    published = true;
  } finally {
    if (published || !existsSync(previous)) rmSync(transaction, { recursive: true, force: true });
  }
}
export {
  retainJavaTestReports
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImphdmEtdGVzdC1yZXBvcnRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcFN5bmMsIGV4aXN0c1N5bmMsIGxzdGF0U3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhZGRpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgcHVibGlzaERpcmVjdG9yeSB9IGZyb20gXCIuL2RpcmVjdG9yeS1wdWJsaWNhdGlvbi5tanNcIjtcbmV4cG9ydCBpbnRlcmZhY2UgSmF2YVRlc3RSdW4ge1xuICByb2xlOiBzdHJpbmc7XG4gIHN0YXJ0ZWRBdDogc3RyaW5nO1xuICBzdGF0dXM6IG51bWJlciB8IG51bGw7XG4gIHNpZ25hbDogTm9kZUpTLlNpZ25hbHMgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqIFJldGFpbiBvbmUgY29tcGxldGUgcmVwb3J0IHNldDsgYSBmYWlsZWQgb3IgbWlzc2luZyBydW4gbmV2ZXIgYm9ycm93cyBldmlkZW5jZSBmcm9tIGl0cyBwcmVkZWNlc3Nvci4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXRhaW5KYXZhVGVzdFJlcG9ydHMocmVwb3J0czogc3RyaW5nLCByb290OiBzdHJpbmcsIHJ1bjogSmF2YVRlc3RSdW4pOiB2b2lkIHtcbiAgY29uc3QgY292ZXJhZ2UgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiksXG4gICAgZGVzdGluYXRpb24gPSBqb2luKGNvdmVyYWdlLCBcInN1cmVmaXJlXCIpO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgW2NvdmVyYWdlLCBkZXN0aW5hdGlvbl0pXG4gICAgaWYgKGxzdGF0U3luYyhwYXRoLCB7IHRocm93SWZOb0VudHJ5OiBmYWxzZSB9KT8uaXNTeW1ib2xpY0xpbmsoKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSmF2YSB0ZXN0IHJlcG9ydHMgbXVzdCBub3QgdHJhdmVyc2UgYSBzeW1ib2xpYyBsaW5rOiAke3BhdGh9YCk7XG4gIG1rZGlyU3luYyhjb3ZlcmFnZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHRyYW5zYWN0aW9uID0gbWtkdGVtcFN5bmMoam9pbihjb3ZlcmFnZSwgXCIuc3VyZWZpcmUtXCIpKTtcbiAgY29uc3QgaW5jb21pbmcgPSBqb2luKHRyYW5zYWN0aW9uLCBcImluY29taW5nXCIpLFxuICAgIHByZXZpb3VzID0gam9pbih0cmFuc2FjdGlvbiwgXCJwcmV2aW91c1wiKTtcbiAgbGV0IHB1Ymxpc2hlZCA9IGZhbHNlO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhpbmNvbWluZyk7XG4gICAgaWYgKGV4aXN0c1N5bmMocmVwb3J0cykpIHtcbiAgICAgIGlmIChsc3RhdFN5bmMocmVwb3J0cykuaXNTeW1ib2xpY0xpbmsoKSkgdGhyb3cgbmV3IEVycm9yKFwiSmF2YSB0ZXN0IHJlcG9ydHMgbXVzdCBub3QgYmUgc3ltYm9saWMgbGlua3NcIik7XG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKHJlcG9ydHMsIHsgcmVjdXJzaXZlOiB0cnVlLCB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKVxuICAgICAgICBpZiAoZW50cnkuaXNTeW1ib2xpY0xpbmsoKSkgdGhyb3cgbmV3IEVycm9yKFwiSmF2YSB0ZXN0IHJlcG9ydHMgbXVzdCBub3QgY29udGFpbiBzeW1ib2xpYyBsaW5rc1wiKTtcbiAgICAgIGNwU3luYyhyZXBvcnRzLCBpbmNvbWluZywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgfVxuICAgIGNvbnN0IGhhc1JlcG9ydHMgPSByZWFkZGlyU3luYyhpbmNvbWluZykuc29tZSgobmFtZSkgPT4gbmFtZS5lbmRzV2l0aChcIi54bWxcIikpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGluY29taW5nLCBcIi53b3JrYmVuY2gtcnVuLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeShcbiAgICAgICAge1xuICAgICAgICAgIHNjaGVtYTogMSxcbiAgICAgICAgICBydW5JZDogcmFuZG9tVVVJRCgpLFxuICAgICAgICAgIC4uLnJ1bixcbiAgICAgICAgICBmaW5pc2hlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgb3V0Y29tZTogIWhhc1JlcG9ydHMgPyBcIm1pc3NpbmdcIiA6IHJ1bi5zdGF0dXMgPT09IDAgJiYgIXJ1bi5zaWduYWwgJiYgIXJ1bi5lcnJvciA/IFwicGFzc2VkXCIgOiBcImZhaWxlZFwiLFxuICAgICAgICB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAyLFxuICAgICAgKSArIFwiXFxuXCIsXG4gICAgKTtcbiAgICBwdWJsaXNoRGlyZWN0b3J5KGluY29taW5nLCBkZXN0aW5hdGlvbiwgcHJldmlvdXMpO1xuICAgIHB1Ymxpc2hlZCA9IHRydWU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHB1Ymxpc2hlZCB8fCAhZXhpc3RzU3luYyhwcmV2aW91cykpIHJtU3luYyh0cmFuc2FjdGlvbiwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsWUFBWSxXQUFXLFdBQVcsYUFBYSxhQUFhLFFBQVEscUJBQXFCO0FBQzFHLFNBQVMsWUFBWTtBQUNyQixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLHdCQUF3QjtBQVUxQixTQUFTLHNCQUFzQixTQUFpQixNQUFjLEtBQXdCO0FBQzNGLFFBQU0sV0FBVyxLQUFLLE1BQU0sVUFBVSxHQUNwQyxjQUFjLEtBQUssVUFBVSxVQUFVO0FBQ3pDLGFBQVcsUUFBUSxDQUFDLFVBQVUsV0FBVztBQUN2QyxRQUFJLFVBQVUsTUFBTSxFQUFFLGdCQUFnQixNQUFNLENBQUMsR0FBRyxlQUFlO0FBQzdELFlBQU0sSUFBSSxNQUFNLHdEQUF3RCxJQUFJLEVBQUU7QUFDbEYsWUFBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsUUFBTSxjQUFjLFlBQVksS0FBSyxVQUFVLFlBQVksQ0FBQztBQUM1RCxRQUFNLFdBQVcsS0FBSyxhQUFhLFVBQVUsR0FDM0MsV0FBVyxLQUFLLGFBQWEsVUFBVTtBQUN6QyxNQUFJLFlBQVk7QUFDaEIsTUFBSTtBQUNGLGNBQVUsUUFBUTtBQUNsQixRQUFJLFdBQVcsT0FBTyxHQUFHO0FBQ3ZCLFVBQUksVUFBVSxPQUFPLEVBQUUsZUFBZSxFQUFHLE9BQU0sSUFBSSxNQUFNLDhDQUE4QztBQUN2RyxpQkFBVyxTQUFTLFlBQVksU0FBUyxFQUFFLFdBQVcsTUFBTSxlQUFlLEtBQUssQ0FBQztBQUMvRSxZQUFJLE1BQU0sZUFBZSxFQUFHLE9BQU0sSUFBSSxNQUFNLG1EQUFtRDtBQUNqRyxhQUFPLFNBQVMsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFDQSxVQUFNLGFBQWEsWUFBWSxRQUFRLEVBQUUsS0FBSyxDQUFDLFNBQVMsS0FBSyxTQUFTLE1BQU0sQ0FBQztBQUM3RTtBQUFBLE1BQ0UsS0FBSyxVQUFVLHFCQUFxQjtBQUFBLE1BQ3BDLEtBQUs7QUFBQSxRQUNIO0FBQUEsVUFDRSxRQUFRO0FBQUEsVUFDUixPQUFPLFdBQVc7QUFBQSxVQUNsQixHQUFHO0FBQUEsVUFDSCxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsVUFDbkMsU0FBUyxDQUFDLGFBQWEsWUFBWSxJQUFJLFdBQVcsS0FBSyxDQUFDLElBQUksVUFBVSxDQUFDLElBQUksUUFBUSxXQUFXO0FBQUEsUUFDaEc7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsSUFBSTtBQUFBLElBQ047QUFDQSxxQkFBaUIsVUFBVSxhQUFhLFFBQVE7QUFDaEQsZ0JBQVk7QUFBQSxFQUNkLFVBQUU7QUFDQSxRQUFJLGFBQWEsQ0FBQyxXQUFXLFFBQVEsRUFBRyxRQUFPLGFBQWEsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM5RjtBQUNGOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvamF2YS10ZXN0LXJlcG9ydHMubWpzIn0=
