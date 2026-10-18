// Generated from bundle-options.mts; edit the TypeScript source.
import { join } from "node:path";
function bundleOptions(root, name, coverage = false) {
  return {
    absWorkingDir: root,
    entryPoints: [join(root, `src/${name}.ts`)],
    bundle: true,
    // Resolve each package's own dependencies through pnpm's isolated store.
    preserveSymlinks: false,
    platform: "node",
    target: ["bootstrap", "launcher"].includes(name) ? "node18.20.8" : "node22",
    format: "cjs",
    outfile: join(root, `bundle/${name}.cjs`),
    minify: !coverage,
    keepNames: true,
    sourcemap: coverage ? "inline" : false,
    logLevel: "silent",
    metafile: true
  };
}
export {
  bundleOptions
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImJ1bmRsZS1vcHRpb25zLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBCdWlsZE9wdGlvbnMgfSBmcm9tIFwiZXNidWlsZFwiO1xuXG5leHBvcnQgZnVuY3Rpb24gYnVuZGxlT3B0aW9ucyhyb290OiBzdHJpbmcsIG5hbWU6IHN0cmluZywgY292ZXJhZ2UgPSBmYWxzZSk6IEJ1aWxkT3B0aW9ucyAmIHsgbWV0YWZpbGU6IHRydWUgfSB7XG4gIHJldHVybiB7XG4gICAgYWJzV29ya2luZ0Rpcjogcm9vdCxcbiAgICBlbnRyeVBvaW50czogW2pvaW4ocm9vdCwgYHNyYy8ke25hbWV9LnRzYCldLFxuICAgIGJ1bmRsZTogdHJ1ZSxcbiAgICAvLyBSZXNvbHZlIGVhY2ggcGFja2FnZSdzIG93biBkZXBlbmRlbmNpZXMgdGhyb3VnaCBwbnBtJ3MgaXNvbGF0ZWQgc3RvcmUuXG4gICAgcHJlc2VydmVTeW1saW5rczogZmFsc2UsXG4gICAgcGxhdGZvcm06IFwibm9kZVwiLFxuICAgIHRhcmdldDogW1wiYm9vdHN0cmFwXCIsIFwibGF1bmNoZXJcIl0uaW5jbHVkZXMobmFtZSkgPyBcIm5vZGUxOC4yMC44XCIgOiBcIm5vZGUyMlwiLFxuICAgIGZvcm1hdDogXCJjanNcIixcbiAgICBvdXRmaWxlOiBqb2luKHJvb3QsIGBidW5kbGUvJHtuYW1lfS5janNgKSxcbiAgICBtaW5pZnk6ICFjb3ZlcmFnZSxcbiAgICBrZWVwTmFtZXM6IHRydWUsXG4gICAgc291cmNlbWFwOiBjb3ZlcmFnZSA/IFwiaW5saW5lXCIgOiBmYWxzZSxcbiAgICBsb2dMZXZlbDogXCJzaWxlbnRcIixcbiAgICBtZXRhZmlsZTogdHJ1ZSxcbiAgfTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsWUFBWTtBQUdkLFNBQVMsY0FBYyxNQUFjLE1BQWMsV0FBVyxPQUEwQztBQUM3RyxTQUFPO0FBQUEsSUFDTCxlQUFlO0FBQUEsSUFDZixhQUFhLENBQUMsS0FBSyxNQUFNLE9BQU8sSUFBSSxLQUFLLENBQUM7QUFBQSxJQUMxQyxRQUFRO0FBQUE7QUFBQSxJQUVSLGtCQUFrQjtBQUFBLElBQ2xCLFVBQVU7QUFBQSxJQUNWLFFBQVEsQ0FBQyxhQUFhLFVBQVUsRUFBRSxTQUFTLElBQUksSUFBSSxnQkFBZ0I7QUFBQSxJQUNuRSxRQUFRO0FBQUEsSUFDUixTQUFTLEtBQUssTUFBTSxVQUFVLElBQUksTUFBTTtBQUFBLElBQ3hDLFFBQVEsQ0FBQztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsV0FBVyxXQUFXLFdBQVc7QUFBQSxJQUNqQyxVQUFVO0FBQUEsSUFDVixVQUFVO0FBQUEsRUFDWjtBQUNGOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvYnVuZGxlLW9wdGlvbnMubWpzIn0=
