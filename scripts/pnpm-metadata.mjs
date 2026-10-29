// Generated from pnpm-metadata.mts; edit the TypeScript source.
import { captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "./runtime-parsers.mjs";
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
        env: {
          ...process.env,
          WORKBENCH_PROJECT_ROOT: root,
          WORKBENCH_DISTRIBUTION_ROOT: resolve(import.meta.dirname, "..")
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBucG0tbWV0YWRhdGEubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNhcHR1cmVPd25lZENoaWxkLCBwcm9jZXNzQ2FuY2VsbGF0aW9uIH0gZnJvbSBcIi4vb3duZWQtY2hpbGQubWpzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBzdHJpbmdpZnkgfSBmcm9tIFwiLi9ydW50aW1lLXBhcnNlcnMubWpzXCI7XG5pbXBvcnQgeyByZWNvcmQsIHJlcXVpcmVkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgcG5wbVBhY2thZ2VzLCBwbnBtSWRlbnRpdHkgfSBmcm9tIFwiLi9wbnBtLWxvY2subWpzXCI7XG5cbi8qKiBBc2sgdGhlIHBpbm5lZCBtYW5hZ2VyIHRvIHJldGFpbiBmdWxsIHB1YmxpY2F0aW9uIGhpc3Rvcnkgd2l0aG91dCBlZGl0aW5nIHByb2plY3QgaW5wdXRzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJldGFpblBucG1NZXRhZGF0YShcbiAgcm9vdDogc3RyaW5nLFxuICBjbGk6IHN0cmluZyxcbiAgcGF0aHM6IHN0cmluZ1tdLFxuICBzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBsb2NrcyA9IHBhdGhzLm1hcCgocGF0aCkgPT4gam9pbihyb290LCBwYXRoLCBcInBucG0tbG9jay55YW1sXCIpKS5maWx0ZXIoKHBhdGgpID0+IGV4aXN0c1N5bmMocGF0aCkpO1xuICBpZiAoIWxvY2tzLmxlbmd0aCkgcmV0dXJuO1xuICBjb25zdCBkZXBlbmRlbmNpZXMgPSBPYmplY3QuY3JlYXRlKG51bGwpIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIGNvbnN0IHBhY2thZ2VzID0gT2JqZWN0LmNyZWF0ZShudWxsKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgZm9yIChjb25zdCBwYXRoIG9mIGxvY2tzKSB7XG4gICAgT2JqZWN0LmFzc2lnbihwYWNrYWdlcywgcG5wbVBhY2thZ2VzKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpKTtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYWNrYWdlcykpIHtcbiAgICBjb25zdCB7IG5hbWUsIHZlcnNpb24gfSA9IHBucG1JZGVudGl0eShrZXkpO1xuICAgIGlmICghL14oPzpAW2EtejAtOS5fLV0rXFwvKT9bYS16MC05Ll8tXSskLy50ZXN0KG5hbWUpIHx8ICEvXltBLVphLXowLTkuK18tXSskLy50ZXN0KHZlcnNpb24pKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBsb2NrZWQgbnBtIHBhY2thZ2U6ICR7a2V5fWApO1xuICAgIGRlcGVuZGVuY2llc1tuYW1lXSA9IHZlcnNpb247XG4gIH1cbiAgY29uc3QgcXVlcnkgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC1ucG0tcG9saWN5LW1ldGFkYXRhLVwiKSk7XG4gIGNvbnN0IG93bmVyID0gc2lnbmFsID8gdW5kZWZpbmVkIDogcHJvY2Vzc0NhbmNlbGxhdGlvbigpO1xuICBjb25zdCBmYWlsdXJlczogdW5rbm93bltdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgbWFuaWZlc3QgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIG1hbmlmZXN0XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHF1ZXJ5LCBcInBhY2thZ2UuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgcHJpdmF0ZTogdHJ1ZSwgcGFja2FnZU1hbmFnZXI6IG1hbmlmZXN0LnBhY2thZ2VNYW5hZ2VyLCBkZXBlbmRlbmNpZXMgfSksXG4gICAgKTtcbiAgICAvLyBBIGRpc3Bvc2FibGUgcXVlcnkgaW1wb3J0ZXIgZXhwb3NlcyB0cmFuc2l0aXZlIG5hbWVzIHRvIG91dGRhdGVkOyBwcm9qZWN0IG1hbmlmZXN0cyBhbmQgbG9ja3MgcmVtYWluIHVudG91Y2hlZC5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihxdWVyeSwgXCJwbnBtLWxvY2sueWFtbFwiKSxcbiAgICAgIHN0cmluZ2lmeSh7XG4gICAgICAgIGxvY2tmaWxlVmVyc2lvbjogXCI5LjBcIixcbiAgICAgICAgaW1wb3J0ZXJzOiB7XG4gICAgICAgICAgXCIuXCI6IHtcbiAgICAgICAgICAgIGRlcGVuZGVuY2llczogT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgICAgICBPYmplY3QuZW50cmllcyhkZXBlbmRlbmNpZXMpLm1hcCgoW25hbWUsIHZlcnNpb25dKSA9PiBbbmFtZSwgeyBzcGVjaWZpZXI6IHZlcnNpb24sIHZlcnNpb24gfV0pLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBwYWNrYWdlcyxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgY29uc29sZS5sb2coXG4gICAgICBgUmV0YWluaW5nIHBucG0gcG9saWN5IG1ldGFkYXRhIGZvciAke1N0cmluZyhPYmplY3Qua2V5cyhkZXBlbmRlbmNpZXMpLmxlbmd0aCl9IGxvY2tlZCBwYWNrYWdlIG5hbWVzLi4uYCxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhcHR1cmVPd25lZENoaWxkKFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtjbGksIFwicGFja2FnZS1tYW5hZ2VyLWV4ZWNcIiwgXCItLVwiLCBcIm91dGRhdGVkXCIsIFwiLS1sb25nXCIsIFwiLS1qc29uXCJdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHF1ZXJ5LFxuICAgICAgICBzaWduYWw6IHJlcXVpcmVkKHNpZ25hbCA/PyBvd25lcj8uc2lnbmFsLCBcIk1pc3NpbmcgcHJlcGFyYXRpb24gY2FuY2VsbGF0aW9uXCIpLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiByb290LFxuICAgICAgICAgIFdPUktCRU5DSF9ESVNUUklCVVRJT05fUk9PVDogcmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIDE2ICogMTAyNCAqIDEwMjQsXG4gICAgKTtcbiAgICAvLyBvdXRkYXRlZCByZXR1cm5zIDEgd2hlbiBuZXdlciByZWxlYXNlcyBleGlzdDsgbWFsZm9ybWVkIG91dHB1dCBvciBleGVjdXRpb24gZmFpbHVyZXMgc3RpbGwgcmVqZWN0IHByZXBhcmF0aW9uLlxuICAgIGlmIChyZXN1bHQuZXJyb3IgfHwgKHJlc3VsdC5zdGF0dXMgIT09IDAgJiYgcmVzdWx0LnN0YXR1cyAhPT0gMSkgfHwgIXJlc3VsdC5zdGRvdXQudHJpbSgpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgcmV0YWluIHBucG0gcG9saWN5IG1ldGFkYXRhOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0ZGVycil9YCk7XG4gICAgcmVjb3JkKEpTT04ucGFyc2UocmVzdWx0LnN0ZG91dCksIFwiSW52YWxpZCBwbnBtIG1ldGFkYXRhIHF1ZXJ5IHJlc3VsdFwiKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsdXJlcy5wdXNoKGVycm9yKTtcbiAgfVxuICBvd25lcj8uY2xvc2UoKTtcbiAgdHJ5IHtcbiAgICBybVN5bmMocXVlcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBmYWlsdXJlcy5wdXNoKGVycm9yKTtcbiAgfVxuICBpZiAoZmFpbHVyZXMubGVuZ3RoID09PSAxKSB0aHJvdyBmYWlsdXJlc1swXTtcbiAgaWYgKGZhaWx1cmVzLmxlbmd0aClcbiAgICB0aHJvdyBuZXcgQWdncmVnYXRlRXJyb3IoZmFpbHVyZXMsIFwicG5wbSBtZXRhZGF0YSByZXRlbnRpb24gYW5kIGNsZWFudXAgZmFpbGVkXCIsIHsgY2F1c2U6IGZhaWx1cmVzWzBdIH0pO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxtQkFBbUIsMkJBQTJCO0FBQ3ZELFNBQVMsWUFBWSxhQUFhLGNBQWMsZUFBZSxjQUFjO0FBQzdFLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMsY0FBYztBQUN2QixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLFFBQVEsZ0JBQWdCO0FBQ2pDLFNBQVMsY0FBYyxvQkFBb0I7QUFHM0MsZUFBc0IsbUJBQ3BCLE1BQ0EsS0FDQSxPQUNBLFFBQ2U7QUFDZixRQUFNLFFBQVEsTUFBTSxJQUFJLENBQUMsU0FBUyxLQUFLLE1BQU0sTUFBTSxnQkFBZ0IsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxTQUFTLFdBQVcsSUFBSSxDQUFDO0FBQ3ZHLE1BQUksQ0FBQyxNQUFNLE9BQVE7QUFDbkIsUUFBTSxlQUFlLHVCQUFPLE9BQU8sSUFBSTtBQUN2QyxRQUFNLFdBQVcsdUJBQU8sT0FBTyxJQUFJO0FBQ25DLGFBQVcsUUFBUSxPQUFPO0FBQ3hCLFdBQU8sT0FBTyxVQUFVLGFBQWEsYUFBYSxNQUFNLE1BQU0sQ0FBQyxDQUFDO0FBQUEsRUFDbEU7QUFDQSxhQUFXLE9BQU8sT0FBTyxLQUFLLFFBQVEsR0FBRztBQUN2QyxVQUFNLEVBQUUsTUFBTSxRQUFRLElBQUksYUFBYSxHQUFHO0FBQzFDLFFBQUksQ0FBQyxxQ0FBcUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxxQkFBcUIsS0FBSyxPQUFPO0FBQ3hGLFlBQU0sSUFBSSxNQUFNLG1DQUFtQyxHQUFHLEVBQUU7QUFDMUQsaUJBQWEsSUFBSSxJQUFJO0FBQUEsRUFDdkI7QUFDQSxRQUFNLFFBQVEsWUFBWSxLQUFLLE9BQU8sR0FBRyxnQ0FBZ0MsQ0FBQztBQUMxRSxRQUFNLFFBQVEsU0FBUyxTQUFZLG9CQUFvQjtBQUN2RCxRQUFNLFdBQXNCLENBQUM7QUFDN0IsTUFBSTtBQUNGLFVBQU0sV0FBVyxPQUFPLEtBQUssTUFBTSxhQUFhLEtBQUssTUFBTSxjQUFjLEdBQUcsTUFBTSxDQUFDLEdBQUcsa0JBQWtCO0FBQ3hHO0FBQUEsTUFDRSxLQUFLLE9BQU8sY0FBYztBQUFBLE1BQzFCLEtBQUssVUFBVSxFQUFFLFNBQVMsTUFBTSxnQkFBZ0IsU0FBUyxnQkFBZ0IsYUFBYSxDQUFDO0FBQUEsSUFDekY7QUFFQTtBQUFBLE1BQ0UsS0FBSyxPQUFPLGdCQUFnQjtBQUFBLE1BQzVCLFVBQVU7QUFBQSxRQUNSLGlCQUFpQjtBQUFBLFFBQ2pCLFdBQVc7QUFBQSxVQUNULEtBQUs7QUFBQSxZQUNILGNBQWMsT0FBTztBQUFBLGNBQ25CLE9BQU8sUUFBUSxZQUFZLEVBQUUsSUFBSSxDQUFDLENBQUMsTUFBTSxPQUFPLE1BQU0sQ0FBQyxNQUFNLEVBQUUsV0FBVyxTQUFTLFFBQVEsQ0FBQyxDQUFDO0FBQUEsWUFDL0Y7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLFFBQ0E7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQ0EsWUFBUTtBQUFBLE1BQ04sc0NBQXNDLE9BQU8sT0FBTyxLQUFLLFlBQVksRUFBRSxNQUFNLENBQUM7QUFBQSxJQUNoRjtBQUNBLFVBQU0sU0FBUyxNQUFNO0FBQUEsTUFDbkIsUUFBUTtBQUFBLE1BQ1IsQ0FBQyxLQUFLLHdCQUF3QixNQUFNLFlBQVksVUFBVSxRQUFRO0FBQUEsTUFDbEU7QUFBQSxRQUNFLEtBQUs7QUFBQSxRQUNMLFFBQVEsU0FBUyxVQUFVLE9BQU8sUUFBUSxrQ0FBa0M7QUFBQSxRQUM1RSxLQUFLO0FBQUEsVUFDSCxHQUFHLFFBQVE7QUFBQSxVQUNYLHdCQUF3QjtBQUFBLFVBQ3hCLDZCQUE2QixRQUFRLFlBQVksU0FBUyxJQUFJO0FBQUEsUUFDaEU7QUFBQSxNQUNGO0FBQUEsTUFDQSxLQUFLLE9BQU87QUFBQSxJQUNkO0FBRUEsUUFBSSxPQUFPLFNBQVUsT0FBTyxXQUFXLEtBQUssT0FBTyxXQUFXLEtBQU0sQ0FBQyxPQUFPLE9BQU8sS0FBSztBQUN0RixZQUFNLElBQUksTUFBTSx1Q0FBdUMsT0FBTyxPQUFPLFNBQVMsT0FBTyxNQUFNLENBQUMsRUFBRTtBQUNoRyxXQUFPLEtBQUssTUFBTSxPQUFPLE1BQU0sR0FBRyxvQ0FBb0M7QUFBQSxFQUN4RSxTQUFTLE9BQU87QUFDZCxhQUFTLEtBQUssS0FBSztBQUFBLEVBQ3JCO0FBQ0EsU0FBTyxNQUFNO0FBQ2IsTUFBSTtBQUNGLFdBQU8sT0FBTyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2hELFNBQVMsT0FBTztBQUNkLGFBQVMsS0FBSyxLQUFLO0FBQUEsRUFDckI7QUFDQSxNQUFJLFNBQVMsV0FBVyxFQUFHLE9BQU0sU0FBUyxDQUFDO0FBQzNDLE1BQUksU0FBUztBQUNYLFVBQU0sSUFBSSxlQUFlLFVBQVUsOENBQThDLEVBQUUsT0FBTyxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQzNHOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcG5wbS1tZXRhZGF0YS5tanMifQ==
