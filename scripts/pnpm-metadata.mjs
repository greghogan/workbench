// Generated from pnpm-metadata.mts; edit the TypeScript source.
import { captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { record, required } from "./values.mjs";
import { pnpmPackages, pnpmIdentity } from "./pnpm-lock.mjs";
async function retainPnpmMetadata(root, cli, paths, signal) {
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
  const owner = signal ? void 0 : processCancellation();
  const failures = [];
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
    const result = await captureOwnedChild(
      process.execPath,
      [cli, "package-manager-exec", "--", "outdated", "--long", "--json"],
      {
        cwd: query,
        signal: required(signal ?? owner?.signal, "Missing preparation cancellation"),
        env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: root }
      },
      16 * 1024 * 1024
    );
    if (result.error || result.status !== 0 && result.status !== 1 || !result.stdout.trim())
      throw new Error(`Cannot retain pnpm policy metadata: ${String(result.error ?? result.stderr)}`);
    record(JSON.parse(result.stdout), "Invalid pnpm metadata query result");
  } catch (error) {
    failures.push(error);
  }
  owner?.close();
  try {
    rmSync(query, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "pnpm metadata retention and cleanup failed", { cause: failures[0] });
}
export {
  retainPnpmMetadata
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBucG0tbWV0YWRhdGEubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNhcHR1cmVPd25lZENoaWxkLCBwcm9jZXNzQ2FuY2VsbGF0aW9uIH0gZnJvbSBcIi4vb3duZWQtY2hpbGQubWpzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBzdHJpbmdpZnkgfSBmcm9tIFwieWFtbFwiO1xuaW1wb3J0IHsgcmVjb3JkLCByZXF1aXJlZCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHBucG1QYWNrYWdlcywgcG5wbUlkZW50aXR5IH0gZnJvbSBcIi4vcG5wbS1sb2NrLm1qc1wiO1xuXG4vKiogQXNrIHRoZSBwaW5uZWQgbWFuYWdlciB0byByZXRhaW4gZnVsbCBwdWJsaWNhdGlvbiBoaXN0b3J5IHdpdGhvdXQgZWRpdGluZyBwcm9qZWN0IGlucHV0cy4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXRhaW5QbnBtTWV0YWRhdGEoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2xpOiBzdHJpbmcsXG4gIHBhdGhzOiBzdHJpbmdbXSxcbiAgc2lnbmFsPzogQWJvcnRTaWduYWwsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbG9ja3MgPSBwYXRocy5tYXAoKHBhdGgpID0+IGpvaW4ocm9vdCwgcGF0aCwgXCJwbnBtLWxvY2sueWFtbFwiKSkuZmlsdGVyKChwYXRoKSA9PiBleGlzdHNTeW5jKHBhdGgpKTtcbiAgaWYgKCFsb2Nrcy5sZW5ndGgpIHJldHVybjtcbiAgY29uc3QgZGVwZW5kZW5jaWVzID0gT2JqZWN0LmNyZWF0ZShudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICBjb25zdCBwYWNrYWdlcyA9IE9iamVjdC5jcmVhdGUobnVsbCkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGZvciAoY29uc3QgcGF0aCBvZiBsb2Nrcykge1xuICAgIE9iamVjdC5hc3NpZ24ocGFja2FnZXMsIHBucG1QYWNrYWdlcyhyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSk7XG4gIH1cbiAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocGFja2FnZXMpKSB7XG4gICAgY29uc3QgeyBuYW1lLCB2ZXJzaW9uIH0gPSBwbnBtSWRlbnRpdHkoa2V5KTtcbiAgICBpZiAoIS9eKD86QFthLXowLTkuXy1dK1xcLyk/W2EtejAtOS5fLV0rJC8udGVzdChuYW1lKSB8fCAhL15bQS1aYS16MC05LitfLV0rJC8udGVzdCh2ZXJzaW9uKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgbG9ja2VkIG5wbSBwYWNrYWdlOiAke2tleX1gKTtcbiAgICBkZXBlbmRlbmNpZXNbbmFtZV0gPSB2ZXJzaW9uO1xuICB9XG4gIGNvbnN0IHF1ZXJ5ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtbnBtLXBvbGljeS1tZXRhZGF0YS1cIikpO1xuICBjb25zdCBvd25lciA9IHNpZ25hbCA/IHVuZGVmaW5lZCA6IHByb2Nlc3NDYW5jZWxsYXRpb24oKTtcbiAgY29uc3QgZmFpbHVyZXM6IHVua25vd25bXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmOFwiKSksIFwiSW52YWxpZCBtYW5pZmVzdFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihxdWVyeSwgXCJwYWNrYWdlLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IHByaXZhdGU6IHRydWUsIHBhY2thZ2VNYW5hZ2VyOiBtYW5pZmVzdC5wYWNrYWdlTWFuYWdlciwgZGVwZW5kZW5jaWVzIH0pLFxuICAgICk7XG4gICAgLy8gQSBkaXNwb3NhYmxlIHF1ZXJ5IGltcG9ydGVyIGV4cG9zZXMgdHJhbnNpdGl2ZSBuYW1lcyB0byBvdXRkYXRlZDsgcHJvamVjdCBtYW5pZmVzdHMgYW5kIGxvY2tzIHJlbWFpbiB1bnRvdWNoZWQuXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4ocXVlcnksIFwicG5wbS1sb2NrLnlhbWxcIiksXG4gICAgICBzdHJpbmdpZnkoe1xuICAgICAgICBsb2NrZmlsZVZlcnNpb246IFwiOS4wXCIsXG4gICAgICAgIGltcG9ydGVyczoge1xuICAgICAgICAgIFwiLlwiOiB7XG4gICAgICAgICAgICBkZXBlbmRlbmNpZXM6IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoZGVwZW5kZW5jaWVzKS5tYXAoKFtuYW1lLCB2ZXJzaW9uXSkgPT4gW25hbWUsIHsgc3BlY2lmaWVyOiB2ZXJzaW9uLCB2ZXJzaW9uIH1dKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcGFja2FnZXMsXG4gICAgICB9KSxcbiAgICApO1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFJldGFpbmluZyBwbnBtIHBvbGljeSBtZXRhZGF0YSBmb3IgJHtTdHJpbmcoT2JqZWN0LmtleXMoZGVwZW5kZW5jaWVzKS5sZW5ndGgpfSBsb2NrZWQgcGFja2FnZSBuYW1lcy4uLmAsXG4gICAgKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYXB0dXJlT3duZWRDaGlsZChcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbY2xpLCBcInBhY2thZ2UtbWFuYWdlci1leGVjXCIsIFwiLS1cIiwgXCJvdXRkYXRlZFwiLCBcIi0tbG9uZ1wiLCBcIi0tanNvblwiXSxcbiAgICAgIHtcbiAgICAgICAgY3dkOiBxdWVyeSxcbiAgICAgICAgc2lnbmFsOiByZXF1aXJlZChzaWduYWwgPz8gb3duZXI/LnNpZ25hbCwgXCJNaXNzaW5nIHByZXBhcmF0aW9uIGNhbmNlbGxhdGlvblwiKSxcbiAgICAgICAgZW52OiB7IC4uLnByb2Nlc3MuZW52LCBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiByb290LCBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IHJvb3QgfSxcbiAgICAgIH0sXG4gICAgICAxNiAqIDEwMjQgKiAxMDI0LFxuICAgICk7XG4gICAgLy8gb3V0ZGF0ZWQgcmV0dXJucyAxIHdoZW4gbmV3ZXIgcmVsZWFzZXMgZXhpc3Q7IG1hbGZvcm1lZCBvdXRwdXQgb3IgZXhlY3V0aW9uIGZhaWx1cmVzIHN0aWxsIHJlamVjdCBwcmVwYXJhdGlvbi5cbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IChyZXN1bHQuc3RhdHVzICE9PSAwICYmIHJlc3VsdC5zdGF0dXMgIT09IDEpIHx8ICFyZXN1bHQuc3Rkb3V0LnRyaW0oKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHJldGFpbiBwbnBtIHBvbGljeSBtZXRhZGF0YTogJHtTdHJpbmcocmVzdWx0LmVycm9yID8/IHJlc3VsdC5zdGRlcnIpfWApO1xuICAgIHJlY29yZChKU09OLnBhcnNlKHJlc3VsdC5zdGRvdXQpLCBcIkludmFsaWQgcG5wbSBtZXRhZGF0YSBxdWVyeSByZXN1bHRcIik7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZXMucHVzaChlcnJvcik7XG4gIH1cbiAgb3duZXI/LmNsb3NlKCk7XG4gIHRyeSB7XG4gICAgcm1TeW5jKHF1ZXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZXMucHVzaChlcnJvcik7XG4gIH1cbiAgaWYgKGZhaWx1cmVzLmxlbmd0aCA9PT0gMSkgdGhyb3cgZmFpbHVyZXNbMF07XG4gIGlmIChmYWlsdXJlcy5sZW5ndGgpXG4gICAgdGhyb3cgbmV3IEFnZ3JlZ2F0ZUVycm9yKGZhaWx1cmVzLCBcInBucG0gbWV0YWRhdGEgcmV0ZW50aW9uIGFuZCBjbGVhbnVwIGZhaWxlZFwiLCB7IGNhdXNlOiBmYWlsdXJlc1swXSB9KTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsbUJBQW1CLDJCQUEyQjtBQUN2RCxTQUFTLFlBQVksYUFBYSxjQUFjLGVBQWUsY0FBYztBQUM3RSxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsUUFBUSxnQkFBZ0I7QUFDakMsU0FBUyxjQUFjLG9CQUFvQjtBQUczQyxlQUFzQixtQkFDcEIsTUFDQSxLQUNBLE9BQ0EsUUFDZTtBQUNmLFFBQU0sUUFBUSxNQUFNLElBQUksQ0FBQyxTQUFTLEtBQUssTUFBTSxNQUFNLGdCQUFnQixDQUFDLEVBQUUsT0FBTyxDQUFDLFNBQVMsV0FBVyxJQUFJLENBQUM7QUFDdkcsTUFBSSxDQUFDLE1BQU0sT0FBUTtBQUNuQixRQUFNLGVBQWUsdUJBQU8sT0FBTyxJQUFJO0FBQ3ZDLFFBQU0sV0FBVyx1QkFBTyxPQUFPLElBQUk7QUFDbkMsYUFBVyxRQUFRLE9BQU87QUFDeEIsV0FBTyxPQUFPLFVBQVUsYUFBYSxhQUFhLE1BQU0sTUFBTSxDQUFDLENBQUM7QUFBQSxFQUNsRTtBQUNBLGFBQVcsT0FBTyxPQUFPLEtBQUssUUFBUSxHQUFHO0FBQ3ZDLFVBQU0sRUFBRSxNQUFNLFFBQVEsSUFBSSxhQUFhLEdBQUc7QUFDMUMsUUFBSSxDQUFDLHFDQUFxQyxLQUFLLElBQUksS0FBSyxDQUFDLHFCQUFxQixLQUFLLE9BQU87QUFDeEYsWUFBTSxJQUFJLE1BQU0sbUNBQW1DLEdBQUcsRUFBRTtBQUMxRCxpQkFBYSxJQUFJLElBQUk7QUFBQSxFQUN2QjtBQUNBLFFBQU0sUUFBUSxZQUFZLEtBQUssT0FBTyxHQUFHLGdDQUFnQyxDQUFDO0FBQzFFLFFBQU0sUUFBUSxTQUFTLFNBQVksb0JBQW9CO0FBQ3ZELFFBQU0sV0FBc0IsQ0FBQztBQUM3QixNQUFJO0FBQ0YsVUFBTSxXQUFXLE9BQU8sS0FBSyxNQUFNLGFBQWEsS0FBSyxNQUFNLGNBQWMsR0FBRyxNQUFNLENBQUMsR0FBRyxrQkFBa0I7QUFDeEc7QUFBQSxNQUNFLEtBQUssT0FBTyxjQUFjO0FBQUEsTUFDMUIsS0FBSyxVQUFVLEVBQUUsU0FBUyxNQUFNLGdCQUFnQixTQUFTLGdCQUFnQixhQUFhLENBQUM7QUFBQSxJQUN6RjtBQUVBO0FBQUEsTUFDRSxLQUFLLE9BQU8sZ0JBQWdCO0FBQUEsTUFDNUIsVUFBVTtBQUFBLFFBQ1IsaUJBQWlCO0FBQUEsUUFDakIsV0FBVztBQUFBLFVBQ1QsS0FBSztBQUFBLFlBQ0gsY0FBYyxPQUFPO0FBQUEsY0FDbkIsT0FBTyxRQUFRLFlBQVksRUFBRSxJQUFJLENBQUMsQ0FBQyxNQUFNLE9BQU8sTUFBTSxDQUFDLE1BQU0sRUFBRSxXQUFXLFNBQVMsUUFBUSxDQUFDLENBQUM7QUFBQSxZQUMvRjtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsUUFDQTtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0g7QUFDQSxZQUFRO0FBQUEsTUFDTixzQ0FBc0MsT0FBTyxPQUFPLEtBQUssWUFBWSxFQUFFLE1BQU0sQ0FBQztBQUFBLElBQ2hGO0FBQ0EsVUFBTSxTQUFTLE1BQU07QUFBQSxNQUNuQixRQUFRO0FBQUEsTUFDUixDQUFDLEtBQUssd0JBQXdCLE1BQU0sWUFBWSxVQUFVLFFBQVE7QUFBQSxNQUNsRTtBQUFBLFFBQ0UsS0FBSztBQUFBLFFBQ0wsUUFBUSxTQUFTLFVBQVUsT0FBTyxRQUFRLGtDQUFrQztBQUFBLFFBQzVFLEtBQUssRUFBRSxHQUFHLFFBQVEsS0FBSyx3QkFBd0IsTUFBTSw2QkFBNkIsS0FBSztBQUFBLE1BQ3pGO0FBQUEsTUFDQSxLQUFLLE9BQU87QUFBQSxJQUNkO0FBRUEsUUFBSSxPQUFPLFNBQVUsT0FBTyxXQUFXLEtBQUssT0FBTyxXQUFXLEtBQU0sQ0FBQyxPQUFPLE9BQU8sS0FBSztBQUN0RixZQUFNLElBQUksTUFBTSx1Q0FBdUMsT0FBTyxPQUFPLFNBQVMsT0FBTyxNQUFNLENBQUMsRUFBRTtBQUNoRyxXQUFPLEtBQUssTUFBTSxPQUFPLE1BQU0sR0FBRyxvQ0FBb0M7QUFBQSxFQUN4RSxTQUFTLE9BQU87QUFDZCxhQUFTLEtBQUssS0FBSztBQUFBLEVBQ3JCO0FBQ0EsU0FBTyxNQUFNO0FBQ2IsTUFBSTtBQUNGLFdBQU8sT0FBTyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2hELFNBQVMsT0FBTztBQUNkLGFBQVMsS0FBSyxLQUFLO0FBQUEsRUFDckI7QUFDQSxNQUFJLFNBQVMsV0FBVyxFQUFHLE9BQU0sU0FBUyxDQUFDO0FBQzNDLE1BQUksU0FBUztBQUNYLFVBQU0sSUFBSSxlQUFlLFVBQVUsOENBQThDLEVBQUUsT0FBTyxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQzNHOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcG5wbS1tZXRhZGF0YS5tanMifQ==
