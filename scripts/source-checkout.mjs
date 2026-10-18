// Generated from source-checkout.mts; edit the TypeScript source.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
function copySourceCheckout(root, destination) {
  mkdirSync(destination, { recursive: true });
  const generated = /* @__PURE__ */ new Set([
    ".git",
    "node_modules",
    "vendor",
    ".bundle",
    ".pnpm-store",
    "target",
    "build",
    "dist",
    "coverage",
    ".direnv",
    ".envrc.local",
    ".venv",
    ".venv.workbench-backup",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".coverage",
    "htmlcov",
    "local.toml",
    ".collections",
    ".local-collections",
    ".skill-links.json",
    ".skill-links.json.lock",
    ".skill-catalog.json"
  ]);
  for (const name of [
    "src",
    "tests",
    "scripts",
    "examples",
    "languages",
    "collections",
    "workbench",
    "docs",
    "skills",
    "bin",
    "bundle",
    ".githooks",
    ".github",
    ".devcontainer",
    "Makefile",
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".pnpmfile.cjs",
    "tsconfig.json",
    "eslint.config.mts",
    "eslint.config.mjs",
    "vitest.config.mts",
    "vitest.config.mjs",
    ".prettierrc.json",
    "AGENTS.md",
    "README.md",
    "flake.nix",
    "flake.lock",
    ".dockerignore",
    "channels.scm",
    "manifest.scm",
    "check-inputs.nix",
    "check-inputs.scm",
    "managed-check-inputs.json",
    "managed-bootstrap.json",
    "managed-registry.json.br",
    ".envrc",
    ".node-version",
    ".tool-versions",
    ".gitignore",
    ".gitattributes"
  ]) {
    if (!existsSync(join(root, name))) continue;
    cpSync(join(root, name), join(destination, name), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => {
        const name2 = basename(path);
        return !generated.has(name2) && !name2.startsWith(".coverage.") && !/\.(?:egg-info|profraw|profdata|pyc|tsbuildinfo)$/.test(name2);
      }
    });
  }
}
export {
  copySourceCheckout
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNvdXJjZS1jaGVja291dC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3BTeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKiBDb3B5IGF1dGhvcmVkIGlucHV0cyBhbmQgZGlzdHJpYnV0YWJsZSBidW5kbGVzLCBleGNsdWRpbmcgbG9jYWwvZ2VuZXJhdGVkIHN0YXRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvcHlTb3VyY2VDaGVja291dChyb290OiBzdHJpbmcsIGRlc3RpbmF0aW9uOiBzdHJpbmcpIHtcbiAgbWtkaXJTeW5jKGRlc3RpbmF0aW9uLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgZ2VuZXJhdGVkID0gbmV3IFNldChbXG4gICAgXCIuZ2l0XCIsXG4gICAgXCJub2RlX21vZHVsZXNcIixcbiAgICBcInZlbmRvclwiLFxuICAgIFwiLmJ1bmRsZVwiLFxuICAgIFwiLnBucG0tc3RvcmVcIixcbiAgICBcInRhcmdldFwiLFxuICAgIFwiYnVpbGRcIixcbiAgICBcImRpc3RcIixcbiAgICBcImNvdmVyYWdlXCIsXG4gICAgXCIuZGlyZW52XCIsXG4gICAgXCIuZW52cmMubG9jYWxcIixcbiAgICBcIi52ZW52XCIsXG4gICAgXCIudmVudi53b3JrYmVuY2gtYmFja3VwXCIsXG4gICAgXCJfX3B5Y2FjaGVfX1wiLFxuICAgIFwiLm15cHlfY2FjaGVcIixcbiAgICBcIi5ydWZmX2NhY2hlXCIsXG4gICAgXCIucHl0ZXN0X2NhY2hlXCIsXG4gICAgXCIuY292ZXJhZ2VcIixcbiAgICBcImh0bWxjb3ZcIixcbiAgICBcImxvY2FsLnRvbWxcIixcbiAgICBcIi5jb2xsZWN0aW9uc1wiLFxuICAgIFwiLmxvY2FsLWNvbGxlY3Rpb25zXCIsXG4gICAgXCIuc2tpbGwtbGlua3MuanNvblwiLFxuICAgIFwiLnNraWxsLWxpbmtzLmpzb24ubG9ja1wiLFxuICAgIFwiLnNraWxsLWNhdGFsb2cuanNvblwiLFxuICBdKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIFtcbiAgICBcInNyY1wiLFxuICAgIFwidGVzdHNcIixcbiAgICBcInNjcmlwdHNcIixcbiAgICBcImV4YW1wbGVzXCIsXG4gICAgXCJsYW5ndWFnZXNcIixcbiAgICBcImNvbGxlY3Rpb25zXCIsXG4gICAgXCJ3b3JrYmVuY2hcIixcbiAgICBcImRvY3NcIixcbiAgICBcInNraWxsc1wiLFxuICAgIFwiYmluXCIsXG4gICAgXCJidW5kbGVcIixcbiAgICBcIi5naXRob29rc1wiLFxuICAgIFwiLmdpdGh1YlwiLFxuICAgIFwiLmRldmNvbnRhaW5lclwiLFxuICAgIFwiTWFrZWZpbGVcIixcbiAgICBcIkxJQ0VOU0VcIixcbiAgICBcInBhY2thZ2UuanNvblwiLFxuICAgIFwicG5wbS1sb2NrLnlhbWxcIixcbiAgICBcInBucG0td29ya3NwYWNlLnlhbWxcIixcbiAgICBcIi5wbnBtZmlsZS5janNcIixcbiAgICBcInRzY29uZmlnLmpzb25cIixcbiAgICBcImVzbGludC5jb25maWcubXRzXCIsXG4gICAgXCJlc2xpbnQuY29uZmlnLm1qc1wiLFxuICAgIFwidml0ZXN0LmNvbmZpZy5tdHNcIixcbiAgICBcInZpdGVzdC5jb25maWcubWpzXCIsXG4gICAgXCIucHJldHRpZXJyYy5qc29uXCIsXG4gICAgXCJBR0VOVFMubWRcIixcbiAgICBcIlJFQURNRS5tZFwiLFxuICAgIFwiZmxha2Uubml4XCIsXG4gICAgXCJmbGFrZS5sb2NrXCIsXG4gICAgXCIuZG9ja2VyaWdub3JlXCIsXG4gICAgXCJjaGFubmVscy5zY21cIixcbiAgICBcIm1hbmlmZXN0LnNjbVwiLFxuICAgIFwiY2hlY2staW5wdXRzLm5peFwiLFxuICAgIFwiY2hlY2staW5wdXRzLnNjbVwiLFxuICAgIFwibWFuYWdlZC1jaGVjay1pbnB1dHMuanNvblwiLFxuICAgIFwibWFuYWdlZC1ib290c3RyYXAuanNvblwiLFxuICAgIFwibWFuYWdlZC1yZWdpc3RyeS5qc29uLmJyXCIsXG4gICAgXCIuZW52cmNcIixcbiAgICBcIi5ub2RlLXZlcnNpb25cIixcbiAgICBcIi50b29sLXZlcnNpb25zXCIsXG4gICAgXCIuZ2l0aWdub3JlXCIsXG4gICAgXCIuZ2l0YXR0cmlidXRlc1wiLFxuICBdKSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4ocm9vdCwgbmFtZSkpKSBjb250aW51ZTtcbiAgICBjcFN5bmMoam9pbihyb290LCBuYW1lKSwgam9pbihkZXN0aW5hdGlvbiwgbmFtZSksIHtcbiAgICAgIHJlY3Vyc2l2ZTogdHJ1ZSxcbiAgICAgIHZlcmJhdGltU3ltbGlua3M6IHRydWUsXG4gICAgICBmaWx0ZXI6IChwYXRoKSA9PiB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBiYXNlbmFtZShwYXRoKTtcbiAgICAgICAgcmV0dXJuIChcbiAgICAgICAgICAhZ2VuZXJhdGVkLmhhcyhuYW1lKSAmJlxuICAgICAgICAgICFuYW1lLnN0YXJ0c1dpdGgoXCIuY292ZXJhZ2UuXCIpICYmXG4gICAgICAgICAgIS9cXC4oPzplZ2ctaW5mb3xwcm9mcmF3fHByb2ZkYXRhfHB5Y3x0c2J1aWxkaW5mbykkLy50ZXN0KG5hbWUpXG4gICAgICAgICk7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsWUFBWSxpQkFBaUI7QUFDOUMsU0FBUyxVQUFVLFlBQVk7QUFHeEIsU0FBUyxtQkFBbUIsTUFBYyxhQUFxQjtBQUNwRSxZQUFVLGFBQWEsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMxQyxRQUFNLFlBQVksb0JBQUksSUFBSTtBQUFBLElBQ3hCO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixDQUFDO0FBQ0QsYUFBVyxRQUFRO0FBQUEsSUFDakI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEdBQUc7QUFDRCxRQUFJLENBQUMsV0FBVyxLQUFLLE1BQU0sSUFBSSxDQUFDLEVBQUc7QUFDbkMsV0FBTyxLQUFLLE1BQU0sSUFBSSxHQUFHLEtBQUssYUFBYSxJQUFJLEdBQUc7QUFBQSxNQUNoRCxXQUFXO0FBQUEsTUFDWCxrQkFBa0I7QUFBQSxNQUNsQixRQUFRLENBQUMsU0FBUztBQUNoQixjQUFNQSxRQUFPLFNBQVMsSUFBSTtBQUMxQixlQUNFLENBQUMsVUFBVSxJQUFJQSxLQUFJLEtBQ25CLENBQUNBLE1BQUssV0FBVyxZQUFZLEtBQzdCLENBQUMsbURBQW1ELEtBQUtBLEtBQUk7QUFBQSxNQUVqRTtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDRjsiLCJuYW1lcyI6WyJuYW1lIl0sImZpbGUiOiJzY3JpcHRzL3NvdXJjZS1jaGVja291dC5tanMifQ==
