// Generated from managed-files.mts; edit the TypeScript source.
import { stageFile } from "./file-publication.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtZmlsZXMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHN0YWdlRmlsZSwgdHlwZSBTdGFnZWRGaWxlIH0gZnJvbSBcIi4vZmlsZS1wdWJsaWNhdGlvbi5tanNcIjtcblxuLyoqIEFsbCBjYW5kaWRhdGVzIGFyZSBjb21wbGV0ZSBiZWZvcmUgdGhlIGZpcnN0IGF0b21pYyBwdWJsaWNhdGlvbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBsYWNlTWFuYWdlZEZpbGVzKFxuICBmaWxlczogcmVhZG9ubHkgKHJlYWRvbmx5IFtzdHJpbmcsIHN0cmluZyB8IFVpbnQ4QXJyYXldKVtdLFxuICBiZWZvcmVSZXBsYWNlPzogKHBhdGg6IHN0cmluZykgPT4gdm9pZCxcbikge1xuICBpZiAobmV3IFNldChmaWxlcy5tYXAoKFtwYXRoXSkgPT4gcGF0aCkpLnNpemUgIT09IGZpbGVzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiRHVwbGljYXRlIG1hbmFnZWQgb3V0cHV0IHBhdGhcIik7XG4gIGNvbnN0IHN0YWdlZDogU3RhZ2VkRmlsZVtdID0gW10sXG4gICAgcHVibGlzaGVkOiBzdHJpbmdbXSA9IFtdLFxuICAgIGZhaWx1cmVzOiB1bmtub3duW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IFtwYXRoLCBieXRlc10gb2YgZmlsZXMpIHN0YWdlZC5wdXNoKHN0YWdlRmlsZShwYXRoLCBieXRlcywgMG82NDQpKTtcbiAgICBmb3IgKGNvbnN0IGZpbGUgb2Ygc3RhZ2VkKSB7XG4gICAgICBmaWxlLnB1Ymxpc2goKCkgPT4gYmVmb3JlUmVwbGFjZT8uKGZpbGUucGF0aCkpO1xuICAgICAgcHVibGlzaGVkLnB1c2goZmlsZS5wYXRoKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZXMucHVzaChlcnJvcik7XG4gIH1cbiAgZm9yIChjb25zdCBmaWxlIG9mIHN0YWdlZClcbiAgICB0cnkge1xuICAgICAgZmlsZS5kaXNjYXJkKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGZhaWx1cmVzLnB1c2goZXJyb3IpO1xuICAgIH1cbiAgaWYgKGZhaWx1cmVzLmxlbmd0aClcbiAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoXG4gICAgICBmYWlsdXJlcyxcbiAgICAgIGBNYW5hZ2VkIGZpbGUgcmVwbGFjZW1lbnQgZmFpbGVkOyBwdWJsaXNoZWQgZmlsZXM6ICR7cHVibGlzaGVkLmpvaW4oXCIsIFwiKSB8fCBcIm5vbmVcIn1gLFxuICAgICAgeyBjYXVzZTogZmFpbHVyZXNbMF0gfSxcbiAgICApO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxpQkFBa0M7QUFHcEMsU0FBUyxvQkFDZCxPQUNBLGVBQ0E7QUFDQSxNQUFJLElBQUksSUFBSSxNQUFNLElBQUksQ0FBQyxDQUFDLElBQUksTUFBTSxJQUFJLENBQUMsRUFBRSxTQUFTLE1BQU0sT0FBUSxPQUFNLElBQUksTUFBTSwrQkFBK0I7QUFDL0csUUFBTSxTQUF1QixDQUFDLEdBQzVCLFlBQXNCLENBQUMsR0FDdkIsV0FBc0IsQ0FBQztBQUN6QixNQUFJO0FBQ0YsZUFBVyxDQUFDLE1BQU0sS0FBSyxLQUFLLE1BQU8sUUFBTyxLQUFLLFVBQVUsTUFBTSxPQUFPLEdBQUssQ0FBQztBQUM1RSxlQUFXLFFBQVEsUUFBUTtBQUN6QixXQUFLLFFBQVEsTUFBTSxnQkFBZ0IsS0FBSyxJQUFJLENBQUM7QUFDN0MsZ0JBQVUsS0FBSyxLQUFLLElBQUk7QUFBQSxJQUMxQjtBQUFBLEVBQ0YsU0FBUyxPQUFPO0FBQ2QsYUFBUyxLQUFLLEtBQUs7QUFBQSxFQUNyQjtBQUNBLGFBQVcsUUFBUTtBQUNqQixRQUFJO0FBQ0YsV0FBSyxRQUFRO0FBQUEsSUFDZixTQUFTLE9BQU87QUFDZCxlQUFTLEtBQUssS0FBSztBQUFBLElBQ3JCO0FBQ0YsTUFBSSxTQUFTO0FBQ1gsVUFBTSxJQUFJO0FBQUEsTUFDUjtBQUFBLE1BQ0EscURBQXFELFVBQVUsS0FBSyxJQUFJLEtBQUssTUFBTTtBQUFBLE1BQ25GLEVBQUUsT0FBTyxTQUFTLENBQUMsRUFBRTtBQUFBLElBQ3ZCO0FBQ0o7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9tYW5hZ2VkLWZpbGVzLm1qcyJ9
