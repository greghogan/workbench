// Generated from managed-inputs.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import { required, isRecord, record, string } from "./values.mjs";
import { replaceManagedFiles } from "./managed-files.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
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
function deriveManagedInputs(root, selected) {
  const outputs = [];
  const projects = parseToml(readFileSync(join(root, "workbench/projects.toml"), "utf8"));
  if (!Array.isArray(projects.language_root)) throw new Error("Missing language roots");
  const roots = projects.language_root.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") throw new Error("Invalid language root");
    return entry.path;
  });
  if (selected !== void 0 && !roots.includes(selected)) throw new Error(`Unknown language root: ${selected}`);
  for (const [directory, file, generate] of [
    ["examples/languages/rust", "guix-crates.scm", rustInputs],
    ["examples/frameworks/react", "managed-dependencies.json", reactInputs]
  ]) {
    if (selected !== void 0 && selected !== directory) continue;
    const location = join(root, directory, file);
    const expected = generate(join(root, directory));
    outputs.push([location, expected]);
  }
  for (const directory of new Set(roots)) {
    if (selected !== void 0 && selected !== directory) continue;
    for (const [file, expected] of [
      ["managed-check-inputs.json", `${JSON.stringify(managedCheckInputs(join(root, directory)), null, 2)}
`],
      ["check-inputs.scm", guixCheckInputs],
      ["check-inputs.nix", nixCheckInputs]
    ]) {
      const location = join(root, directory, file);
      outputs.push([location, expected]);
    }
  }
  return outputs;
}
if (isMainScript(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: "boolean" }, path: { type: "string" } }, strict: true });
  const outputs = deriveManagedInputs(resolve(import.meta.dirname, ".."), values.path);
  if (values.check) {
    for (const [path, expected] of outputs)
      if (readFileSync(path, "utf8") !== expected) throw new Error(`${path}: regenerate managed inputs`);
  } else replaceManagedFiles(outputs);
}
export {
  deriveManagedInputs,
  reactInputs,
  rustInputs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1hbmFnZWQtaW5wdXRzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBpc01haW5TY3JpcHQgfSBmcm9tIFwiLi9zY3JpcHQtZW50cnkubWpzXCI7XG5pbXBvcnQgeyByZXF1aXJlZCwgaXNSZWNvcmQsIHJlY29yZCwgc3RyaW5nIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5pbXBvcnQgeyByZXBsYWNlTWFuYWdlZEZpbGVzIH0gZnJvbSBcIi4vbWFuYWdlZC1maWxlcy5tanNcIjtcbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcGFyc2VUb21sLCBwYXJzZUFsbERvY3VtZW50cyB9IGZyb20gXCIuL3J1bnRpbWUtcGFyc2Vycy5tanNcIjtcbmltcG9ydCB7IG1hbmFnZWRDaGVja0lucHV0cyB9IGZyb20gXCIuL21hbmFnZWQtY2hlY2staW5wdXRzLm1qc1wiO1xuaW1wb3J0IHsgZ3VpeENoZWNrSW5wdXRzLCBuaXhDaGVja0lucHV0cyB9IGZyb20gXCIuL21hbmFnZWQtaW5wdXQtcmVjaXBlcy5tanNcIjtcblxuLy8gRGVyaXZlIGJ1aWxkZXIgYWNxdWlzaXRpb24gaW5wdXRzIGZyb20gbGFuZ3VhZ2UgbG9ja3M7IG5ldmVyIHJlc29sdmUgcGFja2FnZSB2ZXJzaW9ucyBoZXJlLlxuZXhwb3J0IGZ1bmN0aW9uIHJ1c3RJbnB1dHMocm9vdDogc3RyaW5nKSB7XG4gIGNvbnN0IGxvY2sgPSBwYXJzZVRvbWwocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJDYXJnby5sb2NrXCIpLCBcInV0ZjhcIikpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkobG9jay5wYWNrYWdlKSkgdGhyb3cgbmV3IEVycm9yKFwiQ2FyZ28ubG9jayBoYXMgbm8gcGFja2FnZSBsaXN0XCIpO1xuICBjb25zdCBjcmF0ZXMgPSBsb2NrLnBhY2thZ2VcbiAgICAubWFwKChlbnRyeSkgPT4gcmVjb3JkKGVudHJ5LCBcIkludmFsaWQgbG9ja2VkIFJ1c3QgcGFja2FnZVwiKSlcbiAgICAuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkuc291cmNlKVxuICAgIC5tYXAoKGVudHJ5KSA9PiAoe1xuICAgICAgc291cmNlOiBzdHJpbmcoZW50cnkuc291cmNlLCBcIk1pc3NpbmcgUnVzdCBzb3VyY2VcIiksXG4gICAgICBuYW1lOiBzdHJpbmcoZW50cnkubmFtZSwgXCJNaXNzaW5nIGNyYXRlIG5hbWVcIiksXG4gICAgICB2ZXJzaW9uOiBzdHJpbmcoZW50cnkudmVyc2lvbiwgXCJNaXNzaW5nIGNyYXRlIHZlcnNpb25cIiksXG4gICAgICBjaGVja3N1bTogc3RyaW5nKGVudHJ5LmNoZWNrc3VtLCBcIk1pc3NpbmcgY3JhdGUgY2hlY2tzdW1cIiksXG4gICAgfSkpO1xuICBmb3IgKGNvbnN0IGNyYXRlIG9mIGNyYXRlcylcbiAgICBpZiAoXG4gICAgICBjcmF0ZS5zb3VyY2UgIT09IFwicmVnaXN0cnkraHR0cHM6Ly9naXRodWIuY29tL3J1c3QtbGFuZy9jcmF0ZXMuaW8taW5kZXhcIiB8fFxuICAgICAgIS9eW2EtZjAtOV17NjR9JC8udGVzdChjcmF0ZS5jaGVja3N1bSlcbiAgICApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGxvY2tlZCBSdXN0IHNvdXJjZTogJHtjcmF0ZS5uYW1lfWApO1xuICByZXR1cm4gKFxuICAgIFwiOzsgR2VuZXJhdGVkIGZyb20gQ2FyZ28ubG9jayBieSBzY3JpcHRzL21hbmFnZWQtaW5wdXRzLm1qczsgZG8gbm90IGVkaXQuXFxuXCIgK1xuICAgIFwiKHVzZS1tb2R1bGVzIChndWl4IHBhY2thZ2VzKSAoZ3VpeCBkb3dubG9hZCkgKGd1aXggYmFzZTE2KSlcXG5cXG4obGlzdFxcblwiICtcbiAgICBjcmF0ZXNcbiAgICAgIC5tYXAoXG4gICAgICAgIChjcmF0ZSkgPT4gYCAobGlzdCBcInJ1c3QtJHtjcmF0ZS5uYW1lfS0ke2NyYXRlLnZlcnNpb259XCJcbiAgICAgICAob3JpZ2luXG4gICAgICAgICAobWV0aG9kIHVybC1mZXRjaClcbiAgICAgICAgICh1cmkgXCJodHRwczovL3N0YXRpYy5jcmF0ZXMuaW8vY3JhdGVzLyR7Y3JhdGUubmFtZX0vJHtjcmF0ZS5uYW1lfS0ke2NyYXRlLnZlcnNpb259LmNyYXRlXCIpXG4gICAgICAgICAoZmlsZS1uYW1lIFwiJHtjcmF0ZS5uYW1lfS0ke2NyYXRlLnZlcnNpb259LmNyYXRlXCIpXG4gICAgICAgICAoaGFzaCAoY29udGVudC1oYXNoIChiYXNlMTYtc3RyaW5nLT5ieXRldmVjdG9yIFwiJHtjcmF0ZS5jaGVja3N1bX1cIikgc2hhMjU2KSkpKWAsXG4gICAgICApXG4gICAgICAuam9pbihcIlxcblwiKSArXG4gICAgXCIpXFxuXCJcbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWN0SW5wdXRzKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBkb2N1bWVudHMgPSBwYXJzZUFsbERvY3VtZW50cyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBucG0tbG9jay55YW1sXCIpLCBcInV0ZjhcIikpO1xuICBmb3IgKGNvbnN0IGRvY3VtZW50IG9mIGRvY3VtZW50cylcbiAgICBpZiAoZG9jdW1lbnQuZXJyb3JzLmxlbmd0aCkgdGhyb3cgcmVxdWlyZWQoZG9jdW1lbnQuZXJyb3JzWzBdLCBcIk1pc3NpbmcgWUFNTCBwYXJzZSBlcnJvclwiKTtcbiAgY29uc3QgcGFja2FnZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGZvciAoY29uc3QgZG9jdW1lbnQgb2YgZG9jdW1lbnRzKVxuICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICBwYWNrYWdlcyxcbiAgICAgIHJlY29yZChyZWNvcmQoZG9jdW1lbnQudG9KU09OKCksIFwiSW52YWxpZCBucG0gbG9jayBkb2N1bWVudFwiKS5wYWNrYWdlcyA/PyB7fSwgXCJJbnZhbGlkIG5wbSBwYWNrYWdlIG1hcFwiKSxcbiAgICApO1xuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQoW1wicmVhY3RcIiwgXCJyZWFjdC1kb21cIiwgXCJzY2hlZHVsZXJcIl0pO1xuICBjb25zdCBpbnB1dHMgPSBPYmplY3QuZW50cmllcyhwYWNrYWdlcylcbiAgICAuZmlsdGVyKChbbmFtZV0pID0+IG5hbWVzLmhhcyhuYW1lLnNsaWNlKDAsIG5hbWUubGFzdEluZGV4T2YoXCJAXCIpKSkpXG4gICAgLm1hcCgoW2tleSwgZW50cnldKSA9PiB7XG4gICAgICBjb25zdCBpbnRlZ3JpdHkgPSBzdHJpbmcoXG4gICAgICAgIHJlY29yZChyZWNvcmQoZW50cnksIFwiSW52YWxpZCBucG0gcGFja2FnZVwiKS5yZXNvbHV0aW9uLCBcIk1pc3NpbmcgbnBtIHJlc29sdXRpb25cIikuaW50ZWdyaXR5LFxuICAgICAgICBcIk1pc3NpbmcgbnBtIGludGVncml0eVwiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGF0ID0ga2V5Lmxhc3RJbmRleE9mKFwiQFwiKTtcbiAgICAgIGNvbnN0IG5hbWUgPSBrZXkuc2xpY2UoMCwgYXQpO1xuICAgICAgY29uc3QgdmVyc2lvbiA9IGtleS5zbGljZShhdCArIDEpO1xuICAgICAgaWYgKCEvXnNoYTUxMi1bQS1aYS16MC05Ky9dKz0qJC8udGVzdChpbnRlZ3JpdHkpKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgbG9ja2VkIG5wbSBpbnRlZ3JpdHk6ICR7a2V5fWApO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbmFtZSxcbiAgICAgICAgdmVyc2lvbixcbiAgICAgICAgdXJsOiBgaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvJHtuYW1lfS8tLyR7bmFtZX0tJHt2ZXJzaW9ufS50Z3pgLFxuICAgICAgICBpbnRlZ3JpdHk6IGludGVncml0eSxcbiAgICAgIH07XG4gICAgfSk7XG4gIGlmIChpbnB1dHMubGVuZ3RoICE9PSBuYW1lcy5zaXplIHx8IG5ldyBTZXQoaW5wdXRzLm1hcCgoZW50cnkpID0+IGVudHJ5Lm5hbWUpKS5zaXplICE9PSBuYW1lcy5zaXplKVxuICAgIHRocm93IG5ldyBFcnJvcihcIlRoZSBSZWFjdCByZWxlYXNlIG5lZWRzIGV4YWN0bHkgb25lIGxvY2tlZCB2ZXJzaW9uIG9mIGVhY2ggcnVudGltZSBkZXBlbmRlbmN5XCIpO1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaW5wdXRzLCBudWxsLCAyKSArIFwiXFxuXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVNYW5hZ2VkSW5wdXRzKHJvb3Q6IHN0cmluZywgc2VsZWN0ZWQ/OiBzdHJpbmcpOiBbc3RyaW5nLCBzdHJpbmddW10ge1xuICBjb25zdCBvdXRwdXRzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbXTtcbiAgY29uc3QgcHJvamVjdHMgPSBwYXJzZVRvbWwocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJ3b3JrYmVuY2gvcHJvamVjdHMudG9tbFwiKSwgXCJ1dGY4XCIpKTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHByb2plY3RzLmxhbmd1YWdlX3Jvb3QpKSB0aHJvdyBuZXcgRXJyb3IoXCJNaXNzaW5nIGxhbmd1YWdlIHJvb3RzXCIpO1xuICBjb25zdCByb290cyA9IHByb2plY3RzLmxhbmd1YWdlX3Jvb3QubWFwKChlbnRyeSkgPT4ge1xuICAgIGlmICghaXNSZWNvcmQoZW50cnkpIHx8IHR5cGVvZiBlbnRyeS5wYXRoICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGxhbmd1YWdlIHJvb3RcIik7XG4gICAgcmV0dXJuIGVudHJ5LnBhdGg7XG4gIH0pO1xuICBpZiAoc2VsZWN0ZWQgIT09IHVuZGVmaW5lZCAmJiAhcm9vdHMuaW5jbHVkZXMoc2VsZWN0ZWQpKSB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gbGFuZ3VhZ2Ugcm9vdDogJHtzZWxlY3RlZH1gKTtcbiAgZm9yIChjb25zdCBbZGlyZWN0b3J5LCBmaWxlLCBnZW5lcmF0ZV0gb2YgW1xuICAgIFtcImV4YW1wbGVzL2xhbmd1YWdlcy9ydXN0XCIsIFwiZ3VpeC1jcmF0ZXMuc2NtXCIsIHJ1c3RJbnB1dHNdLFxuICAgIFtcImV4YW1wbGVzL2ZyYW1ld29ya3MvcmVhY3RcIiwgXCJtYW5hZ2VkLWRlcGVuZGVuY2llcy5qc29uXCIsIHJlYWN0SW5wdXRzXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGlmIChzZWxlY3RlZCAhPT0gdW5kZWZpbmVkICYmIHNlbGVjdGVkICE9PSBkaXJlY3RvcnkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGxvY2F0aW9uID0gam9pbihyb290LCBkaXJlY3RvcnksIGZpbGUpO1xuICAgIGNvbnN0IGV4cGVjdGVkID0gZ2VuZXJhdGUoam9pbihyb290LCBkaXJlY3RvcnkpKTtcbiAgICBvdXRwdXRzLnB1c2goW2xvY2F0aW9uLCBleHBlY3RlZF0pO1xuICB9XG4gIGZvciAoY29uc3QgZGlyZWN0b3J5IG9mIG5ldyBTZXQocm9vdHMpKSB7XG4gICAgaWYgKHNlbGVjdGVkICE9PSB1bmRlZmluZWQgJiYgc2VsZWN0ZWQgIT09IGRpcmVjdG9yeSkgY29udGludWU7XG4gICAgZm9yIChjb25zdCBbZmlsZSwgZXhwZWN0ZWRdIG9mIFtcbiAgICAgIFtcIm1hbmFnZWQtY2hlY2staW5wdXRzLmpzb25cIiwgYCR7SlNPTi5zdHJpbmdpZnkobWFuYWdlZENoZWNrSW5wdXRzKGpvaW4ocm9vdCwgZGlyZWN0b3J5KSksIG51bGwsIDIpfVxcbmBdLFxuICAgICAgW1wiY2hlY2staW5wdXRzLnNjbVwiLCBndWl4Q2hlY2tJbnB1dHNdLFxuICAgICAgW1wiY2hlY2staW5wdXRzLm5peFwiLCBuaXhDaGVja0lucHV0c10sXG4gICAgXSBhcyBjb25zdCkge1xuICAgICAgY29uc3QgbG9jYXRpb24gPSBqb2luKHJvb3QsIGRpcmVjdG9yeSwgZmlsZSk7XG4gICAgICBvdXRwdXRzLnB1c2goW2xvY2F0aW9uLCBleHBlY3RlZF0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0cHV0cztcbn1cblxuaWYgKGlzTWFpblNjcmlwdChpbXBvcnQubWV0YS51cmwpKSB7XG4gIGNvbnN0IHsgdmFsdWVzIH0gPSBwYXJzZUFyZ3MoeyBvcHRpb25zOiB7IGNoZWNrOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sIHBhdGg6IHsgdHlwZTogXCJzdHJpbmdcIiB9IH0sIHN0cmljdDogdHJ1ZSB9KTtcbiAgY29uc3Qgb3V0cHV0cyA9IGRlcml2ZU1hbmFnZWRJbnB1dHMocmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpLCB2YWx1ZXMucGF0aCk7XG4gIGlmICh2YWx1ZXMuY2hlY2spIHtcbiAgICBmb3IgKGNvbnN0IFtwYXRoLCBleHBlY3RlZF0gb2Ygb3V0cHV0cylcbiAgICAgIGlmIChyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpICE9PSBleHBlY3RlZCkgdGhyb3cgbmV3IEVycm9yKGAke3BhdGh9OiByZWdlbmVyYXRlIG1hbmFnZWQgaW5wdXRzYCk7XG4gIH0gZWxzZSByZXBsYWNlTWFuYWdlZEZpbGVzKG91dHB1dHMpO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxVQUFVLFVBQVUsUUFBUSxjQUFjO0FBRW5ELFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsV0FBVyx5QkFBeUI7QUFDN0MsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxpQkFBaUIsc0JBQXNCO0FBR3pDLFNBQVMsV0FBVyxNQUFjO0FBQ3ZDLFFBQU0sT0FBTyxVQUFVLGFBQWEsS0FBSyxNQUFNLFlBQVksR0FBRyxNQUFNLENBQUM7QUFDckUsTUFBSSxDQUFDLE1BQU0sUUFBUSxLQUFLLE9BQU8sRUFBRyxPQUFNLElBQUksTUFBTSxnQ0FBZ0M7QUFDbEYsUUFBTSxTQUFTLEtBQUssUUFDakIsSUFBSSxDQUFDLFVBQVUsT0FBTyxPQUFPLDZCQUE2QixD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UyxjQUFjLElBQUksQ0FBQyxVQUFVO0FBQ2xELFFBQUksQ0FBQyxTQUFTLEtBQUssS0FBSyxPQUFPLE1BQU0sU0FBUyxTQUFVLE9BQU0sSUFBSSxNQUFNLHVCQUF1QjtBQUMvRixXQUFPLE1BQU07QUFBQSxFQUNmLENBQUM7QUFDRCxNQUFJLGFBQWEsVUFBYSxDQUFDLE1BQU0sU0FBUyxRQUFRLEVBQUcsT0FBTSxJQUFJLE1BQU0sMEJBQTBCLFFBQVEsRUFBRTtBQUM3RyxhQUFXLENBQUMsV0FBVyxNQUFNLFFBQVEsS0FBSztBQUFBLElBQ3hDLENBQUMsMkJBQTJCLG1CQUFtQixVQUFVO0FBQUEsSUFDekQsQ0FBQyw2QkFBNkIsNkJBQTZCLFdBQVc7QUFBQSxFQUN4RSxHQUFZO0FBQ1YsUUFBSSxhQUFhLFVBQWEsYUFBYSxVQUFXO0FBQ3RELFVBQU0sV0FBVyxLQUFLLE1BQU0sV0FBVyxJQUFJO0FBQzNDLFVBQU0sV0FBVyxTQUFTLEtBQUssTUFBTSxTQUFTLENBQUM7QUFDL0MsWUFBUSxLQUFLLENBQUMsVUFBVSxRQUFRLENBQUM7QUFBQSxFQUNuQztBQUNBLGFBQVcsYUFBYSxJQUFJLElBQUksS0FBSyxHQUFHO0FBQ3RDLFFBQUksYUFBYSxVQUFhLGFBQWEsVUFBVztBQUN0RCxlQUFXLENBQUMsTUFBTSxRQUFRLEtBQUs7QUFBQSxNQUM3QixDQUFDLDZCQUE2QixHQUFHLEtBQUssVUFBVSxtQkFBbUIsS0FBSyxNQUFNLFNBQVMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxDQUFDO0FBQUEsQ0FBSTtBQUFBLE1BQ3ZHLENBQUMsb0JBQW9CLGVBQWU7QUFBQSxNQUNwQyxDQUFDLG9CQUFvQixjQUFjO0FBQUEsSUFDckMsR0FBWTtBQUNWLFlBQU0sV0FBVyxLQUFLLE1BQU0sV0FBVyxJQUFJO0FBQzNDLGNBQVEsS0FBSyxDQUFDLFVBQVUsUUFBUSxDQUFDO0FBQUEsSUFDbkM7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUO0FBRUEsSUFBSSxhQUFhLFlBQVksR0FBRyxHQUFHO0FBQ2pDLFFBQU0sRUFBRSxPQUFPLElBQUksVUFBVSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsTUFBTSxVQUFVLEdBQUcsTUFBTSxFQUFFLE1BQU0sU0FBUyxFQUFFLEdBQUcsUUFBUSxLQUFLLENBQUM7QUFDaEgsUUFBTSxVQUFVLG9CQUFvQixRQUFRLFlBQVksU0FBUyxJQUFJLEdBQUcsT0FBTyxJQUFJO0FBQ25GLE1BQUksT0FBTyxPQUFPO0FBQ2hCLGVBQVcsQ0FBQyxNQUFNLFFBQVEsS0FBSztBQUM3QixVQUFJLGFBQWEsTUFBTSxNQUFNLE1BQU0sU0FBVSxPQUFNLElBQUksTUFBTSxHQUFHLElBQUksNkJBQTZCO0FBQUEsRUFDckcsTUFBTyxxQkFBb0IsT0FBTztBQUNwQzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL21hbmFnZWQtaW5wdXRzLm1qcyJ9
