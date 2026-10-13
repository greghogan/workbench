const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const fail = (path) => {
  throw new Error(`Invalid CI plan: ${path}`);
};
const text = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0");
function uniqueStrings(value, path, nonempty = false) {
  if (!strings(value) || value.some((entry) => !text(entry)) || (nonempty && !value.length))
    fail(`${path} must contain ${nonempty ? "one or more " : ""}nonempty strings`);
  if (new Set(value).size !== value.length) fail(`${path} must not contain duplicates`);
}

/** Check the fields the workflow uses before it can expand a matrix or install tools. */
function hostedTargets(value) {
  const covered = new Set();
  const paths = (entries, location, nonempty = false) => {
    uniqueStrings(entries, location, nonempty);
    for (const path of entries) {
      covered.add(path);
    }
  };
  for (const name of ["native", "compatibility", "environments"])
    for (const [index, entry] of value[name].include.entries()) {
      const location = `${name}.include[${index}]`;
      paths(entry.paths, `${location}.paths`, true);
      if (!text(entry.path) || !entry.paths.includes(entry.path)) fail(`${location}.path must belong to paths`);
      if (typeof entry.msvc !== "boolean") fail(`${location}.msvc must be Boolean`);
      if (name === "native") {
        if (!["linux", "macos", "windows"].includes(entry.os)) fail(`${location}.os is unknown`);
        if (!["x64", "arm64"].includes(entry.architecture)) fail(`${location}.architecture is unknown`);
        for (const key of ["runner", "node"]) if (!text(entry[key])) fail(`${location}.${key} must be nonempty`);
      } else if (name === "compatibility") {
        if (!["node", "python", "go", "rust", "java", "ruby", "php", "clang", "gcc"].includes(entry.runtime))
          fail(`${location}.runtime is unknown`);
        if (!text(entry.version)) fail(`${location}.version must be nonempty`);
        if (entry.architecture !== undefined && !["x64", "arm64"].includes(entry.architecture))
          fail(`${location}.architecture is unknown`);
        for (const key of ["runner", "node"])
          if (entry[key] !== undefined && !text(entry[key])) fail(`${location}.${key} must be nonempty`);
        if (entry.roles !== undefined || ["clang", "gcc"].includes(entry.runtime))
          uniqueStrings(entry.roles, `${location}.roles`, true);
      } else {
        if (!["nix", "guix", "nix-docker"].includes(entry.environment)) fail(`${location}.environment is unknown`);
        if (!text(entry.node)) fail(`${location}.node must be nonempty`);
      }
    }
  paths(value.devcontainer.paths, "devcontainer.paths");
}

/** The planner and aggregate status agree on which empty groups intentionally skip. */
export function matrixJobGroups(matrix) {
  if (!object(matrix)) fail("expected a matrix object");
  const groups = {};
  for (const name of ["native", "compatibility", "environments"]) {
    const entries = matrix[name]?.include;
    if (!Array.isArray(entries) || !entries.every(object)) fail(`${name}.include must contain objects`);
    if (name !== "compatibility") groups[name] = entries.length > 0;
  }
  if (!strings(matrix.devcontainer?.paths)) fail("devcontainer.paths must contain strings");
  groups.devcontainer = matrix.devcontainer.paths.length > 0;
  return groups;
}

/** Validate data crossing the CLI/GitHub-output boundary without changing its format. */
export function readHostedPlan(value) {
  matrixJobGroups(value);
  hostedTargets(value);
  for (const target of value.compatibility.include)
    for (const path of target.paths)
      if (
        !value.native.include.some(
          (job) =>
            job.os === "linux" && job.architecture === (target.architecture ?? "x64") && job.paths.includes(path),
        )
      )
        fail(`compatibility for ${path} requires a matching native Linux job`);
  return value;
}
