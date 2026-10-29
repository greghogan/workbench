import { InvalidInput } from "../input-errors.js";
import { Route } from "./routes.js";

export const demonstrationBase = Route.Demonstration;
export function projectBase(id: string): string {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new InvalidInput("Invalid project identity");
  return Route.Projects + "/" + id;
}
export function projectMount(path: string): { id: string; path: string } | undefined {
  const parts = path.split("/");
  const id = parts[2];
  if (parts[1] !== Route.Projects.slice(1) || !id || !/^[a-f0-9]{24}$/.test(id)) return;
  return { id, path: "/" + parts.slice(3).join("/") };
}
