import { AsyncLocalStorage } from "node:async_hooks";

const active = new AsyncLocalStorage<NodeJS.ProcessEnv>();

/** An operation's selection and child environment never change another operation's process state. */
export function currentExecutionEnvironment(): NodeJS.ProcessEnv {
  return active.getStore() ?? process.env;
}

export function withExecutionEnvironment<T>(environment: NodeJS.ProcessEnv, action: () => T): T {
  return active.run(environment, action);
}
