// Generated from clean.mts; edit the TypeScript source.
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";
function remove(path) {
  if (isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))
    throw new Error(`cleanup requires a project-relative path: ${path}`);
  const parts = path.split(/[\\/]/);
  for (let index = 1; index < parts.length; index++) {
    const parent = join(...parts.slice(0, index));
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error(`cleanup refuses a symlinked parent: ${parent}`);
  }
  rmSync(path, { force: true, recursive: true });
}
function pythonCaches(directory) {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name === "__pycache__" || entry.name.endsWith(".egg-info")) remove(path);
    else pythonCaches(path);
  }
}
for (const path of process.argv.slice(2)) {
  if (path === "--python-caches") {
    pythonCaches("src");
    pythonCaches("tests");
  } else remove(path);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNsZWFuLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBleGlzdHNTeW5jLCBsc3RhdFN5bmMsIHJlYWRkaXJTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgaXNBYnNvbHV0ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLy8gVGhlIHByb2plY3QgZGVjbGFyZXMgZGlzcG9zYWJsZSBwYXRocy4gTmV2ZXIgZm9sbG93IGxpbmtzIGludG8gc2hhcmVkIGNhY2hlcy5cbmZ1bmN0aW9uIHJlbW92ZShwYXRoOiBzdHJpbmcpIHtcbiAgaWYgKGlzQWJzb2x1dGUocGF0aCkgfHwgcGF0aC5zcGxpdCgvW1xcXFwvXS8pLnNvbWUoKHBhcnQ6IHN0cmluZykgPT4gIXBhcnQgfHwgcGFydCA9PT0gXCIuXCIgfHwgcGFydCA9PT0gXCIuLlwiKSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGNsZWFudXAgcmVxdWlyZXMgYSBwcm9qZWN0LXJlbGF0aXZlIHBhdGg6ICR7cGF0aH1gKTtcbiAgY29uc3QgcGFydHMgPSBwYXRoLnNwbGl0KC9bXFxcXC9dLyk7XG4gIGZvciAobGV0IGluZGV4ID0gMTsgaW5kZXggPCBwYXJ0cy5sZW5ndGg7IGluZGV4KyspIHtcbiAgICBjb25zdCBwYXJlbnQgPSBqb2luKC4uLnBhcnRzLnNsaWNlKDAsIGluZGV4KSk7XG4gICAgaWYgKGV4aXN0c1N5bmMocGFyZW50KSAmJiBsc3RhdFN5bmMocGFyZW50KS5pc1N5bWJvbGljTGluaygpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBjbGVhbnVwIHJlZnVzZXMgYSBzeW1saW5rZWQgcGFyZW50OiAke3BhcmVudH1gKTtcbiAgfVxuICBybVN5bmMocGF0aCwgeyBmb3JjZTogdHJ1ZSwgcmVjdXJzaXZlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiBweXRob25DYWNoZXMoZGlyZWN0b3J5OiBzdHJpbmcpIHtcbiAgaWYgKCFleGlzdHNTeW5jKGRpcmVjdG9yeSkgfHwgbHN0YXRTeW5jKGRpcmVjdG9yeSkuaXNTeW1ib2xpY0xpbmsoKSkgcmV0dXJuO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKGRpcmVjdG9yeSwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKSB7XG4gICAgaWYgKCFlbnRyeS5pc0RpcmVjdG9yeSgpKSBjb250aW51ZTtcbiAgICBjb25zdCBwYXRoID0gam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpO1xuICAgIGlmIChlbnRyeS5uYW1lID09PSBcIl9fcHljYWNoZV9fXCIgfHwgZW50cnkubmFtZS5lbmRzV2l0aChcIi5lZ2ctaW5mb1wiKSkgcmVtb3ZlKHBhdGgpO1xuICAgIGVsc2UgcHl0aG9uQ2FjaGVzKHBhdGgpO1xuICB9XG59XG5cbmZvciAoY29uc3QgcGF0aCBvZiBwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpIHtcbiAgaWYgKHBhdGggPT09IFwiLS1weXRob24tY2FjaGVzXCIpIHtcbiAgICBweXRob25DYWNoZXMoXCJzcmNcIik7XG4gICAgcHl0aG9uQ2FjaGVzKFwidGVzdHNcIik7XG4gIH0gZWxzZSByZW1vdmUocGF0aCk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFlBQVksV0FBVyxhQUFhLGNBQWM7QUFDM0QsU0FBUyxNQUFNLGtCQUFrQjtBQUdqQyxTQUFTLE9BQU8sTUFBYztBQUM1QixNQUFJLFdBQVcsSUFBSSxLQUFLLEtBQUssTUFBTSxPQUFPLEVBQUUsS0FBSyxDQUFDLFNBQWlCLENBQUMsUUFBUSxTQUFTLE9BQU8sU0FBUyxJQUFJO0FBQ3ZHLFVBQU0sSUFBSSxNQUFNLDZDQUE2QyxJQUFJLEVBQUU7QUFDckUsUUFBTSxRQUFRLEtBQUssTUFBTSxPQUFPO0FBQ2hDLFdBQVMsUUFBUSxHQUFHLFFBQVEsTUFBTSxRQUFRLFNBQVM7QUFDakQsVUFBTSxTQUFTLEtBQUssR0FBRyxNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUM7QUFDNUMsUUFBSSxXQUFXLE1BQU0sS0FBSyxVQUFVLE1BQU0sRUFBRSxlQUFlO0FBQ3pELFlBQU0sSUFBSSxNQUFNLHVDQUF1QyxNQUFNLEVBQUU7QUFBQSxFQUNuRTtBQUNBLFNBQU8sTUFBTSxFQUFFLE9BQU8sTUFBTSxXQUFXLEtBQUssQ0FBQztBQUMvQztBQUVBLFNBQVMsYUFBYSxXQUFtQjtBQUN2QyxNQUFJLENBQUMsV0FBVyxTQUFTLEtBQUssVUFBVSxTQUFTLEVBQUUsZUFBZSxFQUFHO0FBQ3JFLGFBQVcsU0FBUyxZQUFZLFdBQVcsRUFBRSxlQUFlLEtBQUssQ0FBQyxHQUFHO0FBQ25FLFFBQUksQ0FBQyxNQUFNLFlBQVksRUFBRztBQUMxQixVQUFNLE9BQU8sS0FBSyxXQUFXLE1BQU0sSUFBSTtBQUN2QyxRQUFJLE1BQU0sU0FBUyxpQkFBaUIsTUFBTSxLQUFLLFNBQVMsV0FBVyxFQUFHLFFBQU8sSUFBSTtBQUFBLFFBQzVFLGNBQWEsSUFBSTtBQUFBLEVBQ3hCO0FBQ0Y7QUFFQSxXQUFXLFFBQVEsUUFBUSxLQUFLLE1BQU0sQ0FBQyxHQUFHO0FBQ3hDLE1BQUksU0FBUyxtQkFBbUI7QUFDOUIsaUJBQWEsS0FBSztBQUNsQixpQkFBYSxPQUFPO0FBQUEsRUFDdEIsTUFBTyxRQUFPLElBQUk7QUFDcEI7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9jbGVhbi5tanMifQ==
