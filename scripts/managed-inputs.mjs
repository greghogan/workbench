// Generated from managed-inputs.mts; edit the TypeScript source.
import { required, isRecord, record, string } from "./values.mjs";
import { replaceManagedFiles } from "./managed-files.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseToml, parseAllDocuments } from "./runtime-parsers.mjs";
import { managedCheckInputs } from "./managed-check-inputs.mjs";
import { guixCheckInputs, nixCheckInputs } from "./managed-input-recipes.mjs";
function rustInputs(root) {
  const lock = parseToml(readFileSync(join(root, "Cargo.lock"), "utf8"));
  if (!Array.isArray(lock.package)) throw new Error("Cargo.lock has no package list");
  const crates = lock.package.map((entry) => record(entry, "Invalid locked Rust package")).filter((entry) => entry.source).map((entry) => ({
    source: string(entry.source, "Missing Rust source"),
    name: string(entry.name, "Missing crate name"),
    version: string(entry.version, "Missing crate version"),
    checksum: string(entry.checksum, "Missing crate checksum")
  }));
  for (const crate of crates)
    if (crate.source !== "registry+https://github.com/rust-lang/crates.io-index" || !/^[a-f0-9]{64}$/.test(crate.checksum))
      throw new Error(`Unsupported locked Rust source: ${crate.name}`);
  return ";; Generated from Cargo.lock by scripts/managed-inputs.mjs; do not edit.\n(use-modules (guix packages) (guix download) (guix base16))\n\n(list\n" + crates.map(
    (crate) => ` (list "rust-${crate.name}-${crate.version}"
       (origin
         (method url-fetch)
         (uri "https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate")
         (file-name "${crate.name}-${crate.version}.crate")
         (hash (content-hash (base16-string->bytevector "${crate.checksum}") sha256))))`
  ).join("\n") + ")\n";
}
function reactInputs(root) {
  const documents = parseAllDocuments(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  for (const document of documents)
    if (document.errors.length) throw required(document.errors[0], "Missing YAML parse error");
  const packages = {};
  for (const document of documents)
    Object.assign(
      packages,
      record(record(document.toJSON(), "Invalid npm lock document").packages ?? {}, "Invalid npm package map")
    );
  const names = /* @__PURE__ */ new Set(["react", "react-dom", "scheduler"]);
  const inputs = Object.entries(packages).filter(([name]) => names.has(name.slice(0, name.lastIndexOf("@")))).map(([key, entry]) => {
    const integrity = string(
      record(record(entry, "Invalid npm package").resolution, "Missing npm resolution").integrity,
      "Missing npm integrity"
    );
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) throw new Error(`Missing locked npm integrity: ${key}`);
    return {
      name,
      version,
      url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity
    };
  });
  if (inputs.length !== names.size || new Set(inputs.map((entry) => entry.name)).size !== names.size)
    throw new Error("The React release needs exactly one locked version of each runtime dependency");
  return JSON.stringify(inputs, null, 2) + "\n";
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const check = process.argv.includes("--check");
  const outputs = [];
  const root = resolve(import.meta.dirname, "..");
  for (const [directory, file, generate] of [
    ["examples/languages/rust", "guix-crates.scm", rustInputs],
    ["examples/frameworks/react", "managed-dependencies.json", reactInputs]
  ]) {
    const location = join(root, directory, file);
    const expected = generate(join(root, directory));
    if (check) {
      if (readFileSync(location, "utf8") !== expected) throw new Error(`${location}: regenerate managed inputs`);
    } else outputs.push([location, expected]);
  }
  const projects = parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  if (!Array.isArray(projects.language_root)) throw new Error("Missing language roots");
  const roots = projects.language_root.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") throw new Error("Invalid language root");
    return entry.path;
  });
  for (const directory of new Set(roots)) {
    for (const [file, expected] of [
      ["managed-check-inputs.json", `${JSON.stringify(managedCheckInputs(join(root, directory)), null, 2)}
`],
      ["check-inputs.scm", guixCheckInputs],
      ["check-inputs.nix", nixCheckInputs]
    ]) {
      const location = join(root, directory, file);
      if (check) {
        if (readFileSync(location, "utf8") !== expected)
          throw new Error(`${location}: regenerate managed check inputs`);
      } else {
        outputs.push([location, expected]);
      }
    }
  }
  if (!check) replaceManagedFiles(outputs);
}
export {
  reactInputs,
  rustInputs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtaW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZXF1aXJlZCwgaXNSZWNvcmQsIHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5pbXBvcnQgeyByZXBsYWNlTWFuYWdlZEZpbGVzIH0gZnJvbSBcIi4vbWFuYWdlZC1maWxlcy5tanNcIjtcbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VUb21sLCBwYXJzZUFsbERvY3VtZW50cyB9IGZyb20gXCIuL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IG1hbmFnZWRDaGVja0lucHV0cyB9IGZyb20gXCIuL21hbmFnZWQtY2hlY2staW5wdXRzLm1qc1wiO1xuaW1wb3J0IHsgZ3VpeENoZWNrSW5wdXRzLCBuaXhDaGVja0lucHV0cyB9IGZyb20gXCIuL21hbmFnZWQtaW5wdXQtcmVjaXBlcy5tanNcIjtcblxuLy8gRGVyaXZlIGJ1aWxkZXIgYWNxdWlzaXRpb24gaW5wdXRzIGZyb20gbGFuZ3VhZ2UgbG9ja3M7IG5ldmVyIHJlc29sdmUgcGFja2FnZSB2ZXJzaW9ucyBoZXJlLlxuZXhwb3J0IGZ1bmN0aW9uIHJ1c3RJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IGxvY2sgPSBwYXJzZVRvbWwocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJDYXJnby5sb2NrXCIpLCBcInV0ZjhcIikpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkobG9jay5wYWNrYWdlKSkgdGhyb3cgbmV3IEVycm9yKFwiQ2FyZ28ubG9jayBoYXMgbm8gcGFja2FnZSBsaXN0XCIpO1xuICBjb25zdCBjcmF0ZXMgPSBsb2NrLnBhY2thZ2VcbiAgICAubWFwKChlbnRyeSkgPT4gcmVjb3JkKGVudHJ5LCBcIkludmFsaWQgbG9ja2VkIFJ1c3QgcGFja2FnZVwiKSlcbiAgICAuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkuc291cmNlKVxuICAgIC5tYXAoKGVudHJ5KSA9PiAoe1xuICAgICAgc291cmNlOiBzdHJpbmcoZW50cnkuc291cmNlLCBcIk1pc3NpbmcgUnVzdCBzb3VyY2VcIiksXG4gICAgICBuYW1lOiBzdHJpbmcoZW50cnkubmFtZSwgXCJNaXNzaW5nIGNyYXRlIG5hbWVcIiksXG4gICAgICB2ZXJzaW9uOiBzdHJpbmcoZW50cnkudmVyc2lvbiwgXCJNaXNzaW5nIGNyYXRlIHZlcnNpb25cIiksXG4gICAgICBjaGVja3N1bTogc3RyaW5nKGVudHJ5LmNoZWNrc3VtLCBcIk1pc3NpbmcgY3JhdGUgY2hlY2tzdW1cIiksXG4gICAgfSkpO1xuICBmb3IgKGNvbnN0IGNyYXRlIG9mIGNyYXRlcylcbiAgICBpZiAoXG4gICAgICBjcmF0ZS5zb3VyY2UgIT09IFwicmVnaXN0cnkraHR0cHM6Ly9naXRodWIuY29tL3J1c3QtbGFuZy9jcmF0ZXMuaW8taW5kZXhcIiB8fFxuICAgICAgIS9eW2EtZjAtOV17NjR9JC8udGVzdChjcmF0ZS5jaGVja3N1bSlcbiAgICApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGxvY2tlZCBSdXN0IHNvdXJjZTogJHtjcmF0ZS5uYW1lfWApO1xuICByZXR1cm4gKFxuICAgIFwiOzsgR2VuZXJhdGVkIGZyb20gQ2FyZ28ubG9jayBieSBzY3JpcHRzL21hbmFnZWQtaW5wdXRzLm1qczsgZG8gbm90IGVkaXQuXFxuXCIgK1xuICAgIFwiKHVzZS1tb2R1bGVzIChndWl4IHBhY2thZ2VzKSAoZ3VpeCBkb3dubG9hZCkgKGd1aXggYmFzZTE2KSlcXG5cXG4obGlzdFxcblwiICtcbiAgICBjcmF0ZXNcbiAgICAgIC5tYXAoXG4gICAgICAgIChjcmF0ZSkgPT4gYCAobGlzdCBcInJ1c3QtJHtjcmF0ZS5uYW1lfS0ke2NyYXRlLnZlcnNpb259XCJcbiAgICAgICAob3JpZ2luXG4gICAgICAgICAobWV0aG9kIHVybC1mZXRjaClcbiAgICAgICAgICh1cmkgXCJodHRwczovL3N0YXRpYy5jcmF0ZXMuaW8vY3JhdGVzLyR7Y3JhdGUubmFtZX0vJHtjcmF0ZS5uYW1lfS0ke2NyYXRlLnZlcnNpb259LmNyYXRlXCIpXG4gICAgICAgICAoZmlsZS1uYW1lIFwiJHtjcmF0ZS5uYW1lfS0ke2NyYXRlLnZlcnNpb259LmNyYXRlXCIpXG4gICAgICAgICAoaGFzaCAoY29udGVudC1oYXNoIChiYXNlMTYtc3RyaW5nLT5ieXRldmVjdG9yIFwiJHtjcmF0ZS5jaGVja3N1bX1cIikgc2hhMjU2KSkpKWAsXG4gICAgICApXG4gICAgICAuam9pbihcIlxcblwiKSArXG4gICAgXCIpXFxuXCJcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWN0SW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBkb2N1bWVudHMgPSBwYXJzZUFsbERvY3VtZW50cyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBucG0tbG9jay55YW1sXCIpLCBcInV0ZjhcIikpO1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIGRvY3VtZW50cylcbiAgICBpZiAoZG9jdW1lbnQuZXJyb3JzLmxlbmd0aCkgdGhyb3cgcmVxdWlyZWQoZG9jdW1lbnQuZXJyb3JzWzBdLCBcIk1pc3NpbmcgWUFNTCBwYXJzZSBlcnJvclwiKTtcbiAgY29uc3QgcGFja2FnZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGZvciAoY29uc3QgZG9jdW1lbnQgb2YgZG9jdW1lbnRzKVxuICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICBwYWNrYWdlcyxcbiAgICAgIHJlY29yZChyZWNvcmQoZG9jdW1lbnQudG9KU09OKCksIFwiSW52YWxpZCBucG0gbG9jayBkb2N1bWVudFwiKS5wYWNrYWdlcyA/PyB7fSwgXCJJbnZhbGlkIG5wbSBwYWNrYWdlIG1hcFwiKSxcbiAgICApO1xuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQoW1wicmVhY3RcIiwgXCJyZWFjdC1kb21cIiwgXCJzY2hlZHVsZXJcIl0pO1xuICBjb25zdCBpbnB1dHMgPSBPYmplY3QuZW50cmllcyhwYWNrYWdlcylcbiAgICAuZmlsdGVyKChbbmFtZV0pID0+IG5hbWVzLmhhcyhuYW1lLnNsaWNlKDAsIG5hbWUubGFzdEluZGV4T2YoXCJAXCIpKSkpXG4gICAgLm1hcCgoW2tleSwgZW50cnldKSA9PiB7XG4gICAgICBjb25zdCBpbnRlZ3JpdHkgPSBzdHJpbmcoXG4gICAgICAgIHJlY29yZChyZWNvcmQoZW50cnksIFwiSW52YWxpZCBucG0gcGFja2FnZVwiKS5yZXNvbHV0aW9uLCBcIk1pc3NpbmcgbnBtIHJlc29sdXRpb25cIikuaW50ZWdyaXR5LFxuICAgICAgICBcIk1pc3NpbmcgbnBtIGludGVncml0eVwiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGF0ID0ga2V5Lmxhc3RJbmRleE9mKFwiQFwiKTtcbiAgICAgIGNvbnN0IG5hbWUgPSBrZXkuc2xpY2UoMCwgYXQpO1xuICAgICAgY29uc3QgdmVyc2lvbiA9IGtleS5zbGljZShhdCArIDEpO1xuICAgICAgaWYgKCEvXnNoYTUxMi1bQS1aYS16MC05Ky9dKz0qJC8udGVzdChpbnRlZ3JpdHkpKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgbG9ja2VkIG5wbSBpbnRlZ3JpdHk6ICR7a2V5fWApO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbmFtZSxcbiAgICAgICAgdmVyc2lvbixcbiAgICAgICAgdXJsOiBgaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvJHtuYW1lfS8tLyR7bmFtZX0tJHt2ZXJzaW9ufS50Z3pgLFxuICAgICAgICBpbnRlZ3JpdHk6IGludGVncml0eSxcbiAgICAgIH07XG4gICAgfSk7XG4gIGlmIChpbnB1dHMubGVuZ3RoICE9PSBuYW1lcy5zaXplIHx8IG5ldyBTZXQoaW5wdXRzLm1hcCgoZW50cnkpID0+IGVudHJ5Lm5hbWUpKS5zaXplICE9PSBuYW1lcy5zaXplKVxuICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBSZWFjdCByZWxlYXNlIG5lZWRzIGV4YWN0bHkgb25lIGxvY2tlZCB2ZXJzaW9uIG9mIGVhY2ggcnVudGltZSBkZXBlbmRlbmN5XCIpO1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaW5wdXRzLCBudWxsLCAyKSArIFwiXFxuXCI7XG59XG5cbmlmIChwcm9jZXNzLmFyZ3ZbMV0gJiYgcmVzb2x2ZShwcm9jZXNzLmFyZ3ZbMV0pID09PSBpbXBvcnQubWV0YS5maWxlbmFtZSkge1xuICBjb25zdCBjaGVjayA9IHByb2Nlc3MuYXJndi5pbmNsdWRlcyhcIi0tY2hlY2tcIik7XG4gIGNvbnN0IG91dHB1dHM6IFtzdHJpbmcsIHN0cmluZ11bXSA9IFtdO1xuICBjb25zdCByb290ID0gcmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpO1xuICBmb3IgKGNvbnN0IFtkaXJlY3RvcnksIGZpbGUsIGdlbmVyYXRlXSBvZiBbXG4gICAgW1wiZXhhbXBsZXMvbGFuZ3VhZ2VzL3J1c3RcIiwgXCJndWl4LWNyYXRlcy5zY21cIiwgcnVzdElucHV0c10sXG4gICAgW1wiZXhhbXBsZXMvZnJhbWV3b3Jrcy9yZWFjdFwiLCBcIm1hbmFnZWQtZGVwZW5kZW5jaWVzLmpzb25cIiwgcmVhY3RJbnB1dHNdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgY29uc3QgbG9jYXRpb24gPSBqb2luKHJvb3QsIGRpcmVjdG9yeSwgZmlsZSk7XG4gICAgY29uc3QgZXhwZWN0ZWQgPSBnZW5lcmF0ZShqb2luKHJvb3QsIGRpcmVjdG9yeSkpO1xuICAgIGlmIChjaGVjaykge1xuICAgICAgaWYgKHJlYWRGaWxlU3luYyhsb2NhdGlvbiwgXCJ1dGY4XCIpICE9PSBleHBlY3RlZCkgdGhyb3cgbmV3IEVycm9yKGAke2xvY2F0aW9ufTogcmVnZW5lcmF0ZSBtYW5hZ2VkIGlucHV0c2ApO1xuICAgIH0gZWxzZSBvdXRwdXRzLnB1c2goW2xvY2F0aW9uLCBleHBlY3RlZF0pO1xuICB9XG4gIGNvbnN0IHByb2plY3RzID0gcGFyc2VUb21sKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwid29ya2JlbmNoL3Byb2plY3RzLnRvbWxcIiksIFwidXRmOFwiKSk7XG4gIGlmICghQXJyYXkuaXNBcnJheShwcm9qZWN0cy5sYW5ndWFnZV9yb290KSkgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBsYW5ndWFnZSByb290c1wiKTtcbiAgY29uc3Qgcm9vdHMgPSBwcm9qZWN0cy5sYW5ndWFnZV9yb290Lm1hcCgoZW50cnkpID0+IHtcbiAgICBpZiAoIWlzUmVjb3JkKGVudHJ5KSB8fCB0eXBlb2YgZW50cnkucGF0aCAhPT0gXCJzdHJpbmdcIikgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBsYW5ndWFnZSByb290XCIpO1xuICAgIHJldHVybiBlbnRyeS5wYXRoO1xuICB9KTtcbiAgZm9yIChjb25zdCBkaXJlY3Rvcnkgb2YgbmV3IFNldChyb290cykpIHtcbiAgICBmb3IgKGNvbnN0IFtmaWxlLCBleHBlY3RlZF0gb2YgW1xuICAgICAgW1wibWFuYWdlZC1jaGVjay1pbnB1dHMuanNvblwiLCBgJHtKU09OLnN0cmluZ2lmeShtYW5hZ2VkQ2hlY2tJbnB1dHMoam9pbihyb290LCBkaXJlY3RvcnkpKSwgbnVsbCwgMil9XFxuYF0sXG4gICAgICBbXCJjaGVjay1pbnB1dHMuc2NtXCIsIGd1aXhDaGVja0lucHV0c10sXG4gICAgICBbXCJjaGVjay1pbnB1dHMubml4XCIsIG5peENoZWNrSW5wdXRzXSxcbiAgICBdIGFzIGNvbnN0KSB7XG4gICAgICBjb25zdCBsb2NhdGlvbiA9IGpvaW4ocm9vdCwgZGlyZWN0b3J5LCBmaWxlKTtcbiAgICAgIGlmIChjaGVjaykge1xuICAgICAgICBpZiAocmVhZEZpbGVTeW5jKGxvY2F0aW9uLCBcInV0ZjhcIikgIT09IGV4cGVjdGVkKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtsb2NhdGlvbn06IHJlZ2VuZXJhdGUgbWFuYWdlZCBjaGVjayBpbnB1dHNgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG91dHB1dHMucHVzaChbbG9jYXRpb24sIGV4cGVjdGVkXSk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGlmICghY2hlY2spIHJlcGxhY2VNYW5hZ2VkRmlsZXMob3V0cHV0cyk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsVUFBVSxRQUFRLGNBQWM7QUFFbkQsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxXQUFXLHlCQUF5QjtBQUM3QyxTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLGlCQUFpQixzQkFBc0I7QUFHekMsU0FBUyxXQUFXLE1BQWM7QUFDdkMsUUFBTSxPQUFPLFVBQVUsYUFBYSxLQUFLLE1BQU0sWUFBWSxHQUFHLE1BQU0sQ0FBQztBQUNyRSxNQUFJLENBQUMsTUFBTSxRQUFRLEtBQUssT0FBTyxFQUFHLE9BQU0sSUFBSSxNQUFNLGdDQUFnQztBQUNsRixRQUFNLFNBQVMsS0FBSyxRQUNqQixJQUFJLENBQUMsVUFBVSxPQUFPLE9BQU8sNkJBQTZCLENBQUMsRUFDM0QsT0FBTyxDQUFDLFVBQVUsTUFBTSxNQUFNLEVBQzlCLElBQUksQ0FBQyxXQUFXO0FBQUEsSUFDZixRQUFRLE9BQU8sTUFBTSxRQUFRLHFCQUFxQjtBQUFBLElBQ2xELE1BQU0sT0FBTyxNQUFNLE1BQU0sb0JBQW9CO0FBQUEsSUFDN0MsU0FBUyxPQUFPLE1BQU0sU0FBUyx1QkFBdUI7QUFBQSxJQUN0RCxVQUFVLE9BQU8sTUFBTSxVQUFVLHdCQUF3QjtBQUFBLEVBQzNELEVBQUU7QUFDSixhQUFXLFNBQVM7QUFDbEIsUUFDRSxNQUFNLFdBQVcsMkRBQ2pCLENBQUMsaUJBQWlCLEtBQUssTUFBTSxRQUFRO0FBRXJDLFlBQU0sSUFBSSxNQUFNLG1DQUFtQyxNQUFNLElBQUksRUFBRTtBQUNuRSxTQUNFLHFKQUVBLE9BQ0c7QUFBQSxJQUNDLENBQUMsVUFBVSxnQkFBZ0IsTUFBTSxJQUFJLElBQUksTUFBTSxPQUFPO0FBQUE7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
