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
function hostedTargets(value, selected) {
  const covered = new Set();
  const paths = (entries, location, nonempty = false) => {
    uniqueStrings(entries, location, nonempty);
    for (const path of entries) {
      if (!selected.has(path)) fail(`${location}: '${path}' is not selected`);
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
  for (const path of selected) if (!covered.has(path)) fail(`selected root '${path}' has no matrix target`);
}

/** The planner and aggregate status agree on which empty groups intentionally skip. */
export function matrixJobGroups(matrix) {
  if (!object(matrix)) fail("expected a matrix object");
  const groups = {};
  for (const name of ["native", "compatibility", "environments"]) {
    const entries = matrix[name]?.include;
    if (!Array.isArray(entries) || !entries.every(object)) fail(`${name}.include must contain objects`);
    groups[name] = entries.length > 0;
  }
  if (!strings(matrix.devcontainer?.paths)) fail("devcontainer.paths must contain strings");
  groups.devcontainer = matrix.devcontainer.paths.length > 0;
  return groups;
}

/** Validate data crossing the CLI/GitHub-output boundary without changing its format. */
export function readHostedPlan(value) {
  matrixJobGroups(value);
  const selection = value.selection;
  if (!object(selection) || selection.version !== 1) fail("selection.version must be 1");
  if (!["full", "affected", "fallback"].includes(selection.mode)) fail("selection.mode is unknown");
  if (selection.base !== null && typeof selection.base !== "string") fail("selection.base must be a string or null");
  if (typeof selection.head !== "string" || typeof selection.reason !== "string")
    fail("selection revisions/reason must be strings");
  if (
    selection.changedCount === null
      ? selection.mode === "affected"
      : !Number.isSafeInteger(selection.changedCount) || selection.changedCount < 0
  )
    fail("selection.changedCount must be a nonnegative integer, or null when not compared");
  if (selection.changed !== undefined && !strings(selection.changed)) fail("selection.changed must contain strings");
  if (selection.changed !== undefined) {
    uniqueStrings(selection.changed, "selection.changed");
    if (selection.changed.length !== selection.changedCount)
      fail("selection.changedCount differs from changed filenames");
  }
  const changed = new Set(selection.changed);
  if (selection.mode === "affected" && selection.base === null) fail("affected selection requires a base");
  if (selection.mode === "full" && (selection.changedCount !== null || selection.changed !== undefined))
    fail("full selection must not claim a comparison");
  if (selection.failure !== undefined) {
    const failure = selection.failure;
    if (
      selection.mode !== "fallback" ||
      !object(failure) ||
      !["history", "input", "changes", "checkout"].includes(failure.kind) ||
      !text(failure.operation) ||
      !text(failure.message)
    )
      fail("selection.failure must describe a fallback operation");
  }
  if (
    !Array.isArray(selection.selected) ||
    !selection.selected.every((entry) => object(entry) && typeof entry.path === "string" && strings(entry.reasons))
  )
    fail("selection.selected must contain paths and reasons");
  if (
    !Array.isArray(selection.excluded) ||
    !selection.excluded.every(
      (entry) => object(entry) && typeof entry.path === "string" && typeof entry.reason === "string",
    )
  )
    fail("selection.excluded must contain paths and reasons");
  const selected = new Set();
  const excluded = new Set();
  for (const entry of selection.selected) {
    if (!text(entry.path) || selected.has(entry.path)) fail("selection.selected paths must be nonempty and unique");
    selected.add(entry.path);
    uniqueStrings(entry.reasons, `selection.selected '${entry.path}' reasons`, true);
    if (
      entry.matches !== undefined &&
      (!Array.isArray(entry.matches) ||
        !entry.matches.every((match) => object(match) && typeof match.reason === "string" && strings(match.files)))
    )
      fail("selection matches must contain reasons and files");
    if (entry.matches !== undefined) {
      if (selection.changed === undefined) fail("selection matches require changed filenames");
      uniqueStrings(
        entry.matches.map((match) => match.reason),
        "selection match reasons",
      );
      for (const match of entry.matches) {
        if (!entry.reasons.includes(match.reason)) fail("selection match reason must belong to selected reasons");
        uniqueStrings(match.files, "selection match files", true);
        if (match.files.some((file) => !changed.has(file)))
          fail("selection match files must belong to changed filenames");
      }
    }
  }
  for (const entry of selection.excluded) {
    if (!text(entry.path) || excluded.has(entry.path)) fail("selection.excluded paths must be nonempty and unique");
    if (selected.has(entry.path)) fail(`root '${entry.path}' is both selected and excluded`);
    if (!text(entry.reason)) fail("selection.excluded reasons must be nonempty");
    excluded.add(entry.path);
  }
  if (selection.mode !== "affected" && excluded.size) fail("full and fallback selections cannot exclude roots");
  hostedTargets(value, selected);
  return value;
}
