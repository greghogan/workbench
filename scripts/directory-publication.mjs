// Generated from directory-publication.mts; edit the TypeScript source.
import { existsSync, renameSync } from "node:fs";
function publishDirectory(incoming, destination, previous) {
  if (existsSync(previous)) throw new Error(`Preserving existing recovery directory: ${previous}`);
  const replacing = existsSync(destination);
  if (replacing) renameSync(destination, previous);
  try {
    renameSync(incoming, destination);
  } catch (failure) {
    if (replacing)
      try {
        renameSync(previous, destination);
      } catch (recovery) {
        throw new AggregateError(
          [failure, recovery],
          `Directory replacement failed; previous output retained at ${previous}`,
          { cause: recovery }
        );
      }
    throw failure;
  }
}
export {
  publishDirectory
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImRpcmVjdG9yeS1wdWJsaWNhdGlvbi5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZXhpc3RzU3luYywgcmVuYW1lU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbi8qKiBUaGUgY2FsbGVyIHZhbGlkYXRlcyBvdXRwdXQgb3duZXJzaGlwIGFuZCByZXRhaW5zIHJlY292ZXJ5IHBhdGhzIHVudGlsIHJlcGxhY2VtZW50IHN1Y2NlZWRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB1Ymxpc2hEaXJlY3RvcnkoaW5jb21pbmc6IHN0cmluZywgZGVzdGluYXRpb246IHN0cmluZywgcHJldmlvdXM6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoZXhpc3RzU3luYyhwcmV2aW91cykpIHRocm93IG5ldyBFcnJvcihgUHJlc2VydmluZyBleGlzdGluZyByZWNvdmVyeSBkaXJlY3Rvcnk6ICR7cHJldmlvdXN9YCk7XG4gIGNvbnN0IHJlcGxhY2luZyA9IGV4aXN0c1N5bmMoZGVzdGluYXRpb24pO1xuICBpZiAocmVwbGFjaW5nKSByZW5hbWVTeW5jKGRlc3RpbmF0aW9uLCBwcmV2aW91cyk7XG4gIHRyeSB7XG4gICAgcmVuYW1lU3luYyhpbmNvbWluZywgZGVzdGluYXRpb24pO1xuICB9IGNhdGNoIChmYWlsdXJlKSB7XG4gICAgaWYgKHJlcGxhY2luZylcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlbmFtZVN5bmMocHJldmlvdXMsIGRlc3RpbmF0aW9uKTtcbiAgICAgIH0gY2F0Y2ggKHJlY292ZXJ5KSB7XG4gICAgICAgIHRocm93IG5ldyBBZ2dyZWdhdGVFcnJvcihcbiAgICAgICAgICBbZmFpbHVyZSwgcmVjb3ZlcnldLFxuICAgICAgICAgIGBEaXJlY3RvcnkgcmVwbGFjZW1lbnQgZmFpbGVkOyBwcmV2aW91cyBvdXRwdXQgcmV0YWluZWQgYXQgJHtwcmV2aW91c31gLFxuICAgICAgICAgIHsgY2F1c2U6IHJlY292ZXJ5IH0sXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgdGhyb3cgZmFpbHVyZTtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxZQUFZLGtCQUFrQjtBQUdoQyxTQUFTLGlCQUFpQixVQUFrQixhQUFxQixVQUF3QjtBQUM5RixNQUFJLFdBQVcsUUFBUSxFQUFHLE9BQU0sSUFBSSxNQUFNLDJDQUEyQyxRQUFRLEVBQUU7QUFDL0YsUUFBTSxZQUFZLFdBQVcsV0FBVztBQUN4QyxNQUFJLFVBQVcsWUFBVyxhQUFhLFFBQVE7QUFDL0MsTUFBSTtBQUNGLGVBQVcsVUFBVSxXQUFXO0FBQUEsRUFDbEMsU0FBUyxTQUFTO0FBQ2hCLFFBQUk7QUFDRixVQUFJO0FBQ0YsbUJBQVcsVUFBVSxXQUFXO0FBQUEsTUFDbEMsU0FBUyxVQUFVO0FBQ2pCLGNBQU0sSUFBSTtBQUFBLFVBQ1IsQ0FBQyxTQUFTLFFBQVE7QUFBQSxVQUNsQiw2REFBNkQsUUFBUTtBQUFBLFVBQ3JFLEVBQUUsT0FBTyxTQUFTO0FBQUEsUUFDcEI7QUFBQSxNQUNGO0FBQ0YsVUFBTTtBQUFBLEVBQ1I7QUFDRjsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL2RpcmVjdG9yeS1wdWJsaWNhdGlvbi5tanMifQ==
