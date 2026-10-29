// Generated from pnpm-lock.mts; edit the TypeScript source.
import { parseAllDocuments } from "yaml";
import { record, required } from "./values.mjs";
function pnpmPackages(text) {
  const packages = /* @__PURE__ */ Object.create(null);
  for (const document of parseAllDocuments(text)) {
    if (document.errors.length) throw required(document.errors[0], "Missing YAML parse error");
    Object.assign(
      packages,
      record(record(document.toJSON(), "Invalid pnpm lock").packages ?? {}, "Invalid pnpm packages")
    );
  }
  return packages;
}
function pnpmIdentity(key) {
  const match = /^([^()]+)@([^(@)]+)(?:\(.*\))?$/.exec(key);
  if (!match?.[1] || !match[2]) throw new Error(`unsupported npm lock identity: ${key}`);
  return { name: match[1], version: match[2] };
}
export {
  pnpmIdentity,
  pnpmPackages
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBucG0tbG9jay5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcGFyc2VBbGxEb2N1bWVudHMgfSBmcm9tIFwieWFtbFwiO1xuaW1wb3J0IHsgcmVjb3JkLCByZXF1aXJlZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcblxuLyoqIHBucG0gbG9ja3MgY2FuIGNvbnRhaW4gaW5kZXBlbmRlbnQgYm9vdHN0cmFwIGFuZCBwcm9qZWN0IFlBTUwgZG9jdW1lbnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBucG1QYWNrYWdlcyh0ZXh0OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IHBhY2thZ2VzID0gT2JqZWN0LmNyZWF0ZShudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgZm9yIChjb25zdCBkb2N1bWVudCBvZiBwYXJzZUFsbERvY3VtZW50cyh0ZXh0KSkge1xuICAgIGlmIChkb2N1bWVudC5lcnJvcnMubGVuZ3RoKSB0aHJvdyByZXF1aXJlZChkb2N1bWVudC5lcnJvcnNbMF0sIFwiTWlzc2luZyBZQU1MIHBhcnNlIGVycm9yXCIpO1xuICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICBwYWNrYWdlcyxcbiAgICAgIHJlY29yZChyZWNvcmQoZG9jdW1lbnQudG9KU09OKCksIFwiSW52YWxpZCBwbnBtIGxvY2tcIikucGFja2FnZXMgPz8ge30sIFwiSW52YWxpZCBwbnBtIHBhY2thZ2VzXCIpLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHBhY2thZ2VzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcG5wbUlkZW50aXR5KGtleTogc3RyaW5nKTogeyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9IHtcbiAgY29uc3QgbWF0Y2ggPSAvXihbXigpXSspQChbXihAKV0rKSg/OlxcKC4qXFwpKT8kLy5leGVjKGtleSk7XG4gIGlmICghbWF0Y2g/LlsxXSB8fCAhbWF0Y2hbMl0pIHRocm93IG5ldyBFcnJvcihgdW5zdXBwb3J0ZWQgbnBtIGxvY2sgaWRlbnRpdHk6ICR7a2V5fWApO1xuICByZXR1cm4geyBuYW1lOiBtYXRjaFsxXSwgdmVyc2lvbjogbWF0Y2hbMl0gfTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsUUFBUSxnQkFBZ0I7QUFHMUIsU0FBUyxhQUFhLE1BQXVDO0FBQ2xFLFFBQU0sV0FBVyx1QkFBTyxPQUFPLElBQUk7QUFDbkMsYUFBVyxZQUFZLGtCQUFrQixJQUFJLEdBQUc7QUFDOUMsUUFBSSxTQUFTLE9BQU8sT0FBUSxPQUFNLFNBQVMsU0FBUyxPQUFPLENBQUMsR0FBRywwQkFBMEI7QUFDekYsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLE9BQU8sT0FBTyxTQUFTLE9BQU8sR0FBRyxtQkFBbUIsRUFBRSxZQUFZLENBQUMsR0FBRyx1QkFBdUI7QUFBQSxJQUMvRjtBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQ1Q7QUFFTyxTQUFTLGFBQWEsS0FBZ0Q7QUFDM0UsUUFBTSxRQUFRLGtDQUFrQyxLQUFLLEdBQUc7QUFDeEQsTUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUcsT0FBTSxJQUFJLE1BQU0sa0NBQWtDLEdBQUcsRUFBRTtBQUNyRixTQUFPLEVBQUUsTUFBTSxNQUFNLENBQUMsR0FBRyxTQUFTLE1BQU0sQ0FBQyxFQUFFO0FBQzdDOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcG5wbS1sb2NrLm1qcyJ9
