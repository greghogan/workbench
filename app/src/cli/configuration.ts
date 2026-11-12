import { Command, Option } from "commander";
import { configScopes, setConfiguration, type ConfigScope } from "../core/configuration/config-command.js";
import { registerCommand } from "./commands.js";
import { showConfiguration } from "./configuration-output.js";

export function registerConfigurationCommands(program: Command, root: string): void {
  const scopeOption = () => new Option("--scope <scope>", "Select the owning configuration file").choices(configScopes);
  const configuration = registerCommand(program, "config")
    .description("Inspect global settings, project choices, and local overrides")
    .addOption(scopeOption())
    .action((options: { scope?: ConfigScope }) => {
      showConfiguration(root, options.scope);
    });
  configuration
    .command("get")
    .description("Print one option value")
    .argument("<key>")
    .addOption(scopeOption())
    .action((key: string, options: { scope?: ConfigScope }) => {
      showConfiguration(root, options.scope, key);
    });
  configuration
    .command("set")
    .description("Validate and save an option in its owning scope")
    .argument("<key>")
    .argument("<value>")
    .addOption(scopeOption())
    .action((key: string, value: string, options: { scope?: ConfigScope }) => {
      setConfiguration(root, key, value, options.scope);
    });
  configuration
    .command("unset")
    .description("Remove an optional setting or restore a global default")
    .argument("<key>")
    .addOption(scopeOption())
    .action((key: string, options: { scope?: ConfigScope }) => {
      setConfiguration(root, key, undefined, options.scope);
    });
}
