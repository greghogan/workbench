export function ciCacheEnvironment(cache: string, data?: string, isolateRust?: boolean): Record<string, string>;
export function forwardedCIEnvironment(env: NodeJS.ProcessEnv): string[];
