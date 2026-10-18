// Keep this example independent of the Workbench checkout.
export function builderCPUArguments(builder: string, cpus?: string) {
  if (cpus === undefined) {
    const budgets = [process.env.WORKBENCH_CPU_BUDGET, process.env.WORKBENCH_CPUS].filter(
      (value) => value !== undefined,
    );
    for (const value of budgets)
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error("CPU budgets must be positive integers");
    if (budgets.length) cpus = String(Math.min(...budgets.map(Number)));
  }
  if (cpus === undefined) return [];
  if (!/^[1-9][0-9]*$/.test(cpus) || !Number.isSafeInteger(Number(cpus)))
    throw new Error("WORKBENCH_CPUS must be a positive integer");
  if (builder === "nix") return ["--cores", cpus, "--max-jobs", "1"];
  if (builder === "guix") return [`--cores=${cpus}`, "--max-jobs=1"];
  throw new Error(`Unknown managed builder: ${builder}`);
}
