export function ciCacheEnvironment(
  cache: string,
  data?: string,
  isolateRust?: boolean,
  platform?: NodeJS.Platform,
): Record<string, string>;
export function ciBuildCachePaths(cache: string, environment?: string, platform?: NodeJS.Platform): string[];
export function forwardedCIEnvironment(env: NodeJS.ProcessEnv): string[];
