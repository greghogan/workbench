// Generated from managed-files.mts; edit the TypeScript source.
import { stageFile } from "../app/src/core/runtime/file-publication.mjs";
function replaceManagedFiles(files, beforeReplace) {
  if (new Set(files.map(([path]) => path)).size !== files.length) throw new Error("Duplicate managed output path");
  const staged = [], published = [], failures = [];
  try {
    for (const [path, bytes] of files) staged.push(stageFile(path, bytes, 420));
    for (const file of staged) {
      file.publish(() => beforeReplace?.(file.path));
      published.push(file.path);
    }
  } catch (error) {
    failures.push(error);
  }
  for (const file of staged)
    try {
      file.discard();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length)
    throw new AggregateError(
      failures,
      `Managed file replacement failed; published files: ${published.join(", ") || "none"}`,
      { cause: failures[0] }
    );
}
export {
  replaceManagedFiles
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtZmlsZXMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHN0YWdlRmlsZSwgdHlwZSBTdGFnZWRGaWxlIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL2ZpbGUtcHVibGljYXRpb24ubWpzXCI7XG5cbi8qKiBBbGwgY2FuZGlkYXRlcyBhcmUgY29tcGxldGUgYmVmb3JlIHRoZSBmaXJzdCBhdG9taWMgcHVibGljYXRpb24uICovXG5leHBvcnQgZnVuY3Rpb24gcmVwbGFjZU1hbmFnZWRGaWxlcyhcbiAgZmlsZXM6IHJlYWRvbmx5IChyZWFkb25seSBbc3RyaW5nLCBzdHJpbmcgfCBVaW50OEFycmF5XSlbXSxcbiAgYmVmb3JlUmVwbGFjZT86IChwYXRoOiBzdHJpbmcpID0+IHZvaWQsXG4pIHtcbiAgaWYgKG5ldyBTZXQoZmlsZXMubWFwKChbcGF0aF0pID0+IHBhdGgpKS5zaXplICE9PSBmaWxlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIkR1cGxpY2F0ZSBtYW5hZ2VkIG91dHB1dCBwYXRoXCIpO1xuICBjb25zdCBzdGFnZWQ6IFN0YWdlZEZpbGVbXSA9IFtdLFxuICAgIHB1Ymxpc2hlZDogc3RyaW5nW10gPSBbXSxcbiAgICBmYWlsdXJlczogdW5rbm93bltdID0gW107XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBbcGF0aCwgYnl0ZXNdIG9mIGZpbGVzKSBzdGFnZWQucHVzaChzdGFnZUZpbGUocGF0aCwgYnl0ZXMsIDBvNjQ0KSk7XG4gICAgZm9yIChjb25zdCBmaWxlIG9mIHN0YWdlZCkge1xuICAgICAgZmlsZS5wdWJsaXNoKCgpID0+IGJlZm9yZVJlcGxhY2U/LihmaWxlLnBhdGgpKTtcbiAgICAgIHB1Ymxpc2hlZC5wdXNoKGZpbGUucGF0aCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGZhaWx1cmVzLnB1c2goZXJyb3IpO1xuICB9XG4gIGZvciAoY29uc3QgZmlsZSBvZiBzdGFnZWQpXG4gICAgdHJ5IHtcbiAgICAgIGZpbGUuZGlzY2FyZCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsdXJlcy5wdXNoKGVycm9yKTtcbiAgICB9XG4gIGlmIChmYWlsdXJlcy5sZW5ndGgpXG4gICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKFxuICAgICAgZmFpbHVyZXMsXG4gICAgICBgTWFuYWdlZCBmaWxlIHJlcGxhY2VtZW50IGZhaWxlZDsgcHVibGlzaGVkIGZpbGVzOiAke3B1Ymxpc2hlZC5qb2luKFwiLCBcIikgfHwgXCJub25lXCJ9YCxcbiAgICAgIHsgY2F1c2U6IGZhaWx1cmVzWzBdIH0sXG4gICAgKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsaUJBQWtDO0FBR3BDLFNBQVMsb0JBQ2QsT0FDQSxlQUNBO0FBQ0EsTUFBSSxJQUFJLElBQUksTUFBTSxJQUFJLENBQUMsQ0FBQyxJQUFJLE1BQU0sSUFBSSxDQUFDLEVBQUUsU0FBUyxNQUFNLE9BQVEsT0FBTSxJQUFJLE1BQU0sK0JBQStCO0FBQy9HLFFBQU0sU0FBdUIsQ0FBQyxHQUM1QixZQUFzQixDQUFDLEdBQ3ZCLFdBQXNCLENBQUM7QUFDekIsTUFBSTtBQUNGLGVBQVcsQ0FBQyxNQUFNLEtBQUssS0FBSyxNQUFPLFFBQU8sS0FBSyxVQUFVLE1BQU0sT0FBTyxHQUFLLENBQUM7QUFDNUUsZUFBVyxRQUFRLFFBQVE7QUFDekIsV0FBSyxRQUFRLE1BQU0sZ0JBQWdCLEtBQUssSUFBSSxDQUFDO0FBQzdDLGdCQUFVLEtBQUssS0FBSyxJQUFJO0FBQUEsSUFDMUI7QUFBQSxFQUNGLFNBQVMsT0FBTztBQUNkLGFBQVMsS0FBSyxLQUFLO0FBQUEsRUFDckI7QUFDQSxhQUFXLFFBQVE7QUFDakIsUUFBSTtBQUNGLFdBQUssUUFBUTtBQUFBLElBQ2YsU0FBUyxPQUFPO0FBQ2QsZUFBUyxLQUFLLEtBQUs7QUFBQSxJQUNyQjtBQUNGLE1BQUksU0FBUztBQUNYLFVBQU0sSUFBSTtBQUFBLE1BQ1I7QUFBQSxNQUNBLHFEQUFxRCxVQUFVLEtBQUssSUFBSSxLQUFLLE1BQU07QUFBQSxNQUNuRixFQUFFLE9BQU8sU0FBUyxDQUFDLEVBQUU7QUFBQSxJQUN2QjtBQUNKOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvbWFuYWdlZC1maWxlcy5tanMifQ==
