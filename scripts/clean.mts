import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// The project declares disposable paths. Never follow links into shared caches.
function remove(path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).some((part: string) => !part || part === "." || part === ".."))
    throw new Error(`cleanup requires a project-relative path: ${path}`);
  const parts = path.split(/[\\/]/);
  for (let index = 1; index < parts.length; index++) {
    const parent = join(...parts.slice(0, index));
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error(`cleanup refuses a symlinked parent: ${parent}`);
  }
  rmSync(path, { force: true, recursive: true });
}

function pythonCaches(directory: string) {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name === "__pycache__" || entry.name.endsWith(".egg-info")) remove(path);
    else pythonCaches(path);
  }
}

for (const path of process.argv.slice(2)) {
  if (path === "--python-caches") {
    pythonCaches("src");
    pythonCaches("tests");
  } else remove(path);
}
