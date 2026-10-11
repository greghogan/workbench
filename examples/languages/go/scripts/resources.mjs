// Keep this example independent of the Workbench checkout.
export function builderCPUArguments(builder, cpus = process.env.WORKBENCH_CPUS) {
  if (cpus === undefined) return [];
  if (!/^[1-9][0-9]*$/.test(cpus) || !Number.isSafeInteger(Number(cpus)))
    throw new Error("WORKBENCH_CPUS must be a positive integer");
  if (builder === "nix") return ["--cores", String(cpus), "--max-jobs", "1"];
  if (builder === "guix") return [`--cores=${cpus}`, "--max-jobs=1"];
  throw new Error(`Unknown managed builder: ${builder}`);
}
