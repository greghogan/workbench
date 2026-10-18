import { syncLocalContextIndex } from "./local-context.js";
import { type Command } from "commander";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { distributionRoot } from "./core.js";
import { readToolPin, toolSpecification, executingToolPin, type ToolPin } from "./launcher.js";
import { ownedPath } from "./paths.js";
import { detectedCompletionShell, installCompletion } from "./completion.js";

const marker = "// Workbench-owned launcher.\n";
export function installLauncher(
  root: string,
  options: { directory?: string; repository?: string; revision?: string },
): string {
  const distribution = distributionRoot(root);
  const pin: ToolPin | undefined =
    options.repository && options.revision
      ? { repository: options.repository, revision: options.revision }
      : (readToolPin(root) ?? executingToolPin(distribution));
  if (!!options.repository !== !!options.revision || !pin)
    throw new Error("supply --repository and --revision, or install using a project-pinned Workbench");
  toolSpecification(pin);
  const directory = resolve(
    options.directory ??
      (process.platform === "win32"
        ? join(
            process.env.LOCALAPPDATA ??
              (() => {
                throw new Error("LOCALAPPDATA is required");
              })(),
            "workbench/bin",
          )
        : join(homedir(), ".local/bin")),
  );
  const file = ownedPath(directory, process.platform === "win32" ? "workbench.cjs" : "workbench");
  mkdirSync(directory, { recursive: true });
  if (
    existsSync(file) &&
    (!lstatSync(file).isFile() || !readFileSync(file, "utf8").startsWith(`#!/usr/bin/env node\n${marker}`))
  )
    throw new Error(`preserving an existing executable: ${file}`);
  const shim = process.platform === "win32" ? ownedPath(directory, "workbench.cmd") : undefined;
  const shimContents = '@rem Workbench-owned launcher\r\n@node "%~dp0workbench.cjs" %*\r\n';
  if (shim && existsSync(shim) && readFileSync(shim, "utf8") !== shimContents)
    throw new Error(`preserving existing launcher: ${shim}`);
  const bytes = readFileSync(join(distribution, "bundle/launcher.cjs"), "utf8");
  writeFileSync(
    file,
    `#!/usr/bin/env node\n${marker}${bytes}\nmodule.exports.launch(process.argv.slice(2), ${JSON.stringify(pin)}).catch(error => { console.error("workbench: " + error.message); process.exitCode = 1; });\n`,
    { mode: 0o755 },
  );
  if (process.platform !== "win32") chmodSync(file, 0o755);
  if (shim) writeFileSync(shim, shimContents);
  syncLocalContextIndex();
  console.log(`Installed ${file} (${toolSpecification(pin)}).`);
  if (!(process.env.PATH ?? "").split(delimiter).some((entry) => resolve(entry) === directory))
    console.log(`Add ${directory} to PATH to use workbench.`);
  const shell = detectedCompletionShell();
  if (shell) installCompletion(shell);
  else console.log("Install completion for your shell with: workbench completion install SHELL");
  return file;
}
export function registerInstallationCommands(program: Command, root: string): void {
  program
    .command("install")
    .description("Install a user launcher; projects select their own exact executable revision")
    .option("--user", "Install for this user (default)")
    .option("--directory <path>", "Select the executable directory; system locations need administrator access")
    .option("--repository <url>", "Default Git repository URL (HTTPS or SSH)")
    .option("--revision <commit>", "Default full Git commit")
    .action((options: { directory?: string; repository?: string; revision?: string }) => {
      installLauncher(root, options);
    });
}
