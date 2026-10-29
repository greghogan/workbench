// Generated from pnpm-lock.mts; edit the TypeScript source.
import { parseAllDocuments } from "./runtime-parsers.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBucG0tbG9jay5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcGFyc2VBbGxEb2N1bWVudHMgfSBmcm9tIFwiLi9ydW50aW1lLXBhcnNlcnMubWpzXCI7XG5pbXBvcnQgeyByZWNvcmQsIHJlcXVpcmVkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG4vKiogcG5wbSBsb2NrcyBjYW4gY29udGFpbiBpbmRlcGVuZGVudCBib290c3RyYXAgYW5kIHByb2plY3QgWUFNTCBkb2N1bWVudHMuICovXG5leHBvcnQgZnVuY3Rpb24gcG5wbVBhY2thZ2VzKHRleHQ6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgcGFja2FnZXMgPSBPYmplY3QuY3JlYXRlKG51bGwpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIHBhcnNlQWxsRG9jdW1lbnRzKHRleHQpKSB7XG4gICAgaWYgKGRvY3VtZW50LmVycm9ycy5sZW5ndGgpIHRocm93IHJlcXVpcmVkKGRvY3VtZW50LmVycm9yc1swXSwgXCJNaXNzaW5nIFlBTUwgcGFyc2UgZXJyb3JcIik7XG4gICAgT2JqZWN0LmFzc2lnbihcbiAgICAgIHBhY2thZ2VzLFxuICAgICAgcmVjb3JkKHJlY29yZChkb2N1bWVudC50b0pTT04oKSwgXCJJbnZhbGlkIHBucG0gbG9ja1wiKS5wYWNrYWdlcyA/PyB7fSwgXCJJbnZhbGlkIHBucG0gcGFja2FnZXNcIiksXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcGFja2FnZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwbnBtSWRlbnRpdHkoa2V5OiBzdHJpbmcpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICBjb25zdCBtYXRjaCA9IC9eKFteKCldKylAKFteKEApXSspKD86XFwoLipcXCkpPyQvLmV4ZWMoa2V5KTtcbiAgaWYgKCFtYXRjaD8uWzFdIHx8ICFtYXRjaFsyXSkgdGhyb3cgbmV3IEVycm9yKGB1bnN1cHBvcnRlZCBucG0gbG9jayBpZGVudGl0eTogJHtrZXl9YCk7XG4gIHJldHVybiB7IG5hbWU6IG1hdGNoWzFdLCB2ZXJzaW9uOiBtYXRjaFsyXSB9O1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxRQUFRLGdCQUFnQjtBQUcxQixTQUFTLGFBQWEsTUFBdUM7QUFDbEUsUUFBTSxXQUFXLHVCQUFPLE9BQU8sSUFBSTtBQUNuQyxhQUFXLFlBQVksa0JBQWtCLElBQUksR0FBRztBQUM5QyxRQUFJLFNBQVMsT0FBTyxPQUFRLE9BQU0sU0FBUyxTQUFTLE9BQU8sQ0FBQyxHQUFHLDBCQUEwQjtBQUN6RixXQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsT0FBTyxPQUFPLFNBQVMsT0FBTyxHQUFHLG1CQUFtQixFQUFFLFlBQVksQ0FBQyxHQUFHLHVCQUF1QjtBQUFBLElBQy9GO0FBQUEsRUFDRjtBQUNBLFNBQU87QUFDVDtBQUVPLFNBQVMsYUFBYSxLQUFnRDtBQUMzRSxRQUFNLFFBQVEsa0NBQWtDLEtBQUssR0FBRztBQUN4RCxNQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRyxPQUFNLElBQUksTUFBTSxrQ0FBa0MsR0FBRyxFQUFFO0FBQ3JGLFNBQU8sRUFBRSxNQUFNLE1BQU0sQ0FBQyxHQUFHLFNBQVMsTUFBTSxDQUFDLEVBQUU7QUFDN0M7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9wbnBtLWxvY2subWpzIn0=
