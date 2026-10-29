import { AsyncLocalStorage } from "node:async_hooks";
import { routeScope } from "./routes.js";
const scope = new AsyncLocalStorage<string>();
/** A request owns its URL scope; shared assets and the project index remain global. */
export function withProjectPaths<T>(base: string, render: () => T): T {
  return scope.run(base, render);
}
export function projectPath(path: string, base = scope.getStore() ?? ""): string {
  if (
    !base ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    routeScope(path) === "global" ||
    path.startsWith(base + "/")
  )
    return path;
  return base + path;
}
