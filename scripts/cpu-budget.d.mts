export function positiveInteger(value: unknown, location: string): number;
export function cpuBudget(env?: NodeJS.ProcessEnv): number;
export function builderCPUArguments(builder: "nix" | "guix", cpus: number | string): string[];
export function cpuEnvironment(cpus: number, env?: NodeJS.ProcessEnv): Record<string, string>;
