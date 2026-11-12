import { gitNullConfiguration } from "../../src/core/runtime/windows-host.ts";

/** Test repositories own Git identity, configuration, and checkout state. */
export function isolateFixtureGit(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) Reflect.deleteProperty(env, name);
  env.GIT_CONFIG_GLOBAL = gitNullConfiguration;
  env.GIT_CONFIG_NOSYSTEM = "1";

  if (process.platform === "win32") {
    // Preserve the hosted Windows checkout contract without using the developer's Git configuration.
    const configuration = [
      ["core.symlinks", "true"],
      ["core.autocrlf", "false"],
      ["core.longpaths", "true"],
    ] as const;
    env.GIT_CONFIG_COUNT = String(configuration.length);
    for (const [index, [key, value]] of configuration.entries()) {
      env[`GIT_CONFIG_KEY_${String(index)}`] = key;
      env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
    }
  }
}
