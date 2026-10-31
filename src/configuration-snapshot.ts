import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { readToml } from "./files.js";

const active = new AsyncLocalStorage<Map<string, unknown>>();

/** A caller owns one immutable configuration view; later operations acquire fresh inputs. */
export function withConfigurationSnapshot<T>(action: () => T): T {
  return active.getStore() ? action() : active.run(new Map(), action);
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

export function configurationValue<T>(key: string, acquire: () => T): T {
  const values = active.getStore();
  if (!values) return acquire();
  if (!values.has(key)) {
    const value = acquire();
    freeze(value);
    values.set(key, value);
  }
  return values.get(key) as T;
}

export function readConfigurationToml(path: string): unknown {
  return configurationValue(`toml:${resolve(path)}`, () => readToml(path));
}
