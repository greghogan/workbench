// Generated from pnpm-metadata.mts; edit the TypeScript source.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { record } from "./values.mjs";
import { pnpmPackages, pnpmIdentity } from "./pnpm-lock.mjs";
function retainPnpmMetadata(root, cli, paths) {
  const locks = paths.map((path) => join(root, path, "pnpm-lock.yaml")).filter((path) => existsSync(path));
  if (!locks.length) return;
  const dependencies = /* @__PURE__ */ Object.create(null);
  const packages = /* @__PURE__ */ Object.create(null);
  for (const path of locks) {
    Object.assign(packages, pnpmPackages(readFileSync(path, "utf8")));
  }
  for (const key of Object.keys(packages)) {
    const { name, version } = pnpmIdentity(key);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || !/^[A-Za-z0-9.+_-]+$/.test(version))
      throw new Error(`Unsupported locked npm package: ${key}`);
    dependencies[name] = version;
  }
  const query = mkdtempSync(join(tmpdir(), "workbench-npm-policy-metadata-"));
  try {
    const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid manifest");
    writeFileSync(
      join(query, "package.json"),
      JSON.stringify({ private: true, packageManager: manifest.packageManager, dependencies })
    );
    writeFileSync(
      join(query, "pnpm-lock.yaml"),
      stringify({
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: Object.fromEntries(
              Object.entries(dependencies).map(([name, version]) => [name, { specifier: version, version }])
            )
          }
        },
        packages
      })
    );
    console.log(
      `Retaining pnpm policy metadata for ${String(Object.keys(dependencies).length)} locked package names...`
    );
    const result = spawnSync(process.execPath, [cli, "package-manager-exec", "--", "outdated", "--long", "--json"], {
      cwd: query,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: root }
    });
    if (result.error || result.status !== 0 && result.status !== 1 || !result.stdout.trim())
      throw new Error(`Cannot retain pnpm policy metadata: ${String(result.error ?? result.stderr)}`);
    record(JSON.parse(result.stdout), "Invalid pnpm metadata query result");
  } finally {
    rmSync(query, { recursive: true, force: true });
  }
}
export {
  retainPnpmMetadata
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBucG0tbWV0YWRhdGEubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHN0cmluZ2lmeSB9IGZyb20gXCJ5YW1sXCI7XG5pbXBvcnQgeyByZWNvcmQgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBwbnBtUGFja2FnZXMsIHBucG1JZGVudGl0eSB9IGZyb20gXCIuL3BucG0tbG9jay5tanNcIjtcblxuLyoqIEFzayB0aGUgcGlubmVkIG1hbmFnZXIgdG8gcmV0YWluIGZ1bGwgcHVibGljYXRpb24gaGlzdG9yeSB3aXRob3V0IGVkaXRpbmcgcHJvamVjdCBpbnB1dHMuICovXG5leHBvcnQgZnVuY3Rpb24gcmV0YWluUG5wbU1ldGFkYXRhKHJvb3Q6IHN0cmluZywgY2xpOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSk6IHZvaWQge1xuICBjb25zdCBsb2NrcyA9IHBhdGhzLm1hcCgocGF0aCkgPT4gam9pbihyb290LCBwYXRoLCBcInBucG0tbG9jay55YW1sXCIpKS5maWx0ZXIoKHBhdGgpID0+IGV4aXN0c1N5bmMocGF0aCkpO1xuICBpZiAoIWxvY2tzLmxlbmd0aCkgcmV0dXJuO1xuICBjb25zdCBkZXBlbmRlbmNpZXMgPSBPYmplY3QuY3JlYXRlKG51bGwpIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIGNvbnN0IHBhY2thZ2VzID0gT2JqZWN0LmNyZWF0ZShudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgZm9yIChjb25zdCBwYXRoIG9mIGxvY2tzKSB7XG4gICAgT2JqZWN0LmFzc2lnbihwYWNrYWdlcywgcG5wbVBhY2thZ2VzKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpKTtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYWNrYWdlcykpIHtcbiAgICBjb25zdCB7IG5hbWUsIHZlcnNpb24gfSA9IHBucG1JZGVudGl0eShrZXkpO1xuICAgIGlmICghL14oPzpAW2EtejAtOS5fLV0rXFwvKT9bYS16MC05Ll8tXSskLy50ZXN0KG5hbWUpIHx8ICEvXltBLVphLXowLTkuK18tXSskLy50ZXN0KHZlcnNpb24pKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBsb2NrZWQgbnBtIHBhY2thZ2U6ICR7a2V5fWApO1xuICAgIGRlcGVuZGVuY2llc1tuYW1lXSA9IHZlcnNpb247XG4gIH1cbiAgY29uc3QgcXVlcnkgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC1ucG0tcG9saWN5LW1ldGFkYXRhLVwiKSk7XG4gIHRyeSB7XG4gICAgY29uc3QgbWFuaWZlc3QgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIG1hbmlmZXN0XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHF1ZXJ5LCBcInBhY2thZ2UuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgcHJpdmF0ZTogdHJ1ZSwgcGFja2FnZU1hbmFnZXI6IG1hbmlmZXN0LnBhY2thZ2VNYW5hZ2VyLCBkZXBlbmRlbmNpZXMgfSksXG4gICAgKTtcbiAgICAvLyBBIGRpc3Bvc2FibGUgcXVlcnkgaW1wb3J0ZXIgZXhwb3NlcyB0cmFuc2l0aXZlIG5hbWVzIHRvIG91dGRhdGVkOyBwcm9qZWN0IG1hbmlmZXN0cyBhbmQgbG9ja3MgcmVtYWluIHVudG91Y2hlZC5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihxdWVyeSwgXCJwbnBtLWxvY2sueWFtbFwiKSxcbiAgICAgIHN0cmluZ2lmeSh7XG4gICAgICAgIGxvY2tmaWxlVmVyc2lvbjogXCI5LjBcIixcbiAgICAgICAgaW1wb3J0ZXJzOiB7XG4gICAgICAgICAgXCIuXCI6IHtcbiAgICAgICAgICAgIGRlcGVuZGVuY2llczogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgICAgICBPYmplY3QuZW50cmllcyhkZXBlbmRlbmNpZXMpLm1hcCgoW25hbWUsIHZlcnNpb25dKSA9PiBbbmFtZSwgeyBzcGVjaWZpZXI6IHZlcnNpb24sIHZlcnNpb24gfV0pLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBwYWNrYWdlcyxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgY29uc29sZS5sb2coXG4gICAgICBgUmV0YWluaW5nIHBucG0gcG9saWN5IG1ldGFkYXRhIGZvciAke1N0cmluZyhPYmplY3Qua2V5cyhkZXBlbmRlbmNpZXMpLmxlbmd0aCl9IGxvY2tlZCBwYWNrYWdlIG5hbWVzLi4uYCxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhwcm9jZXNzLmV4ZWNQYXRoLCBbY2xpLCBcInBhY2thZ2UtbWFuYWdlci1leGVjXCIsIFwiLS1cIiwgXCJvdXRkYXRlZFwiLCBcIi0tbG9uZ1wiLCBcIi0tanNvblwiXSwge1xuICAgICAgY3dkOiBxdWVyeSxcbiAgICAgIGVuY29kaW5nOiBcInV0ZjhcIixcbiAgICAgIG1heEJ1ZmZlcjogMTYgKiAxMDI0ICogMTAyNCxcbiAgICAgIGVudjogeyAuLi5wcm9jZXNzLmVudiwgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogcm9vdCwgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiByb290IH0sXG4gICAgfSk7XG4gICAgLy8gb3V0ZGF0ZWQgcmV0dXJucyAxIHdoZW4gbmV3ZXIgcmVsZWFzZXMgZXhpc3Q7IG1hbGZvcm1lZCBvdXRwdXQgb3IgZXhlY3V0aW9uIGZhaWx1cmVzIHN0aWxsIHJlamVjdCBwcmVwYXJhdGlvbi5cbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IChyZXN1bHQuc3RhdHVzICE9PSAwICYmIHJlc3VsdC5zdGF0dXMgIT09IDEpIHx8ICFyZXN1bHQuc3Rkb3V0LnRyaW0oKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHJldGFpbiBwbnBtIHBvbGljeSBtZXRhZGF0YTogJHtTdHJpbmcocmVzdWx0LmVycm9yID8/IHJlc3VsdC5zdGRlcnIpfWApO1xuICAgIHJlY29yZChKU09OLnBhcnNlKHJlc3VsdC5zdGRvdXQpLCBcIkludmFsaWQgcG5wbSBtZXRhZGF0YSBxdWVyeSByZXN1bHRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHF1ZXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsWUFBWSxhQUFhLGNBQWMsZUFBZSxjQUFjO0FBQzdFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsY0FBYyxvQkFBb0I7QUFHcEMsU0FBUyxtQkFBbUIsTUFBYyxLQUFhLE9BQXVCO0FBQ25GLFFBQU0sUUFBUSxNQUFNLElBQUksQ0FBQyxTQUFTLEtBQUssTUFBTSxNQUFNLGdCQUFnQixDQUFDLEVBQUUsT0FBTyxDQUFDLFNBQVMsV0FBVyxJQUFJLENBQUM7QUFDdkcsTUFBSSxDQUFDLE1BQU0sT0FBUTtBQUNuQixRQUFNLGVBQWUsdUJBQU8sT0FBTyxJQUFJO0FBQ3ZDLFFBQU0sV0FBVyx1QkFBTyxPQUFPLElBQUk7QUFDbkMsYUFBVyxRQUFRLE9BQU87QUFDeEIsV0FBTyxPQUFPLFVBQVUsYUFBYSxhQUFhLE1BQU0sTUFBTSxDQUFDLENBQUM7QUFBQSxFQUNsRTtBQUNBLGFBQVcsT0FBTyxPQUFPLEtBQUssUUFBUSxHQUFHO0FBQ3ZDLFVBQU0sRUFBRSxNQUFNLFFBQVEsSUFBSSxhQUFhLEdBQUc7QUFDMUMsUUFBSSxDQUFDLHFDQUFxQyxLQUFLLElBQUksS0FBSyxDQUFDLHFCQUFxQixLQUFLLE9BQU87QUFDeEYsWUFBTSxJQUFJLE1BQU0sbUNBQW1DLEdBQUcsRUFBRTtBQUMxRCxpQkFBYSxJQUFJLElBQUk7QUFBQSxFQUN2QjtBQUNBLFFBQU0sUUFBUSxZQUFZLEtBQUssT0FBTyxHQUFHLGdDQUFnQyxDQUFDO0FBQzFFLE1BQUk7QUFDRixVQUFNLFdBQVcsT0FBTyxLQUFLLE1BQU0sYUFBYSxLQUFLLE1BQU0sY0FBYyxHQUFHLE1BQU0sQ0FBQyxHQUFHLGtCQUFrQjtBQUN4RztBQUFBLE1BQ0UsS0FBSyxPQUFPLGNBQWM7QUFBQSxNQUMxQixLQUFLLFVBQVUsRUFBRSxTQUFTLE1BQU0sZ0JBQWdCLFNBQVMsZ0JBQWdCLGFBQWEsQ0FBQztBQUFBLElBQ3pGO0FBRUE7QUFBQSxNQUNFLEtBQUssT0FBTyxnQkFBZ0I7QUFBQSxNQUM1QixVQUFVO0FBQUEsUUFDUixpQkFBaUI7QUFBQSxRQUNqQixXQUFXO0FBQUEsVUFDVCxLQUFLO0FBQUEsWUFDSCxjQUFjLE9BQU87QUFBQSxjQUNuQixPQUFPLFFBQVEsWUFBWSxFQUFFLElBQUksQ0FBQyxDQUFDLE1BQU0sT0FBTyxNQUFNLENBQUMsTUFBTSxFQUFFLFdBQVcsU0FBUyxRQUFRLENBQUMsQ0FBQztBQUFBLFlBQy9GO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxRQUNBO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUNBLFlBQVE7QUFBQSxNQUNOLHNDQUFzQyxPQUFPLE9BQU8sS0FBSyxZQUFZLEVBQUUsTUFBTSxDQUFDO0FBQUEsSUFDaEY7QUFDQSxVQUFNLFNBQVMsVUFBVSxRQUFRLFVBQVUsQ0FBQyxLQUFLLHdCQUF3QixNQUFNLFlBQVksVUFBVSxRQUFRLEdBQUc7QUFBQSxNQUM5RyxLQUFLO0FBQUEsTUFDTCxVQUFVO0FBQUEsTUFDVixXQUFXLEtBQUssT0FBTztBQUFBLE1BQ3ZCLEtBQUssRUFBRSxHQUFHLFFBQVEsS0FBSyx3QkFBd0IsTUFBTSw2QkFBNkIsS0FBSztBQUFBLElBQ3pGLENBQUM7QUFFRCxRQUFJLE9BQU8sU0FBVSxPQUFPLFdBQVcsS0FBSyxPQUFPLFdBQVcsS0FBTSxDQUFDLE9BQU8sT0FBTyxLQUFLO0FBQ3RGLFlBQU0sSUFBSSxNQUFNLHVDQUF1QyxPQUFPLE9BQU8sU0FBUyxPQUFPLE1BQU0sQ0FBQyxFQUFFO0FBQ2hHLFdBQU8sS0FBSyxNQUFNLE9BQU8sTUFBTSxHQUFHLG9DQUFvQztBQUFBLEVBQ3hFLFVBQUU7QUFDQSxXQUFPLE9BQU8sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNoRDtBQUNGOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcG5wbS1tZXRhZGF0YS5tanMifQ==
