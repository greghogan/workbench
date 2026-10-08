import { type Command, type Option } from "commander";
import { projectField, projectOptionKeys } from "./config-schema.js";
import { userOptions } from "./user-config.js";

export const completionShells = ["bash", "zsh", "fish", "powershell"];

/** Inspect the parser model without loading project settings, installing tools, or running commands. */
export function completionCandidates(program: Command, words: string[]): string[] {
  let command = program;
  let pending: Option | undefined;
  let scope: string | undefined;
  const arguments_: string[] = [];
  const prefix = words.at(-1) ?? "";
  for (const word of words.slice(0, -1)) {
    if (word === "--") return [];
    if (pending) {
      if (pending.long === "--scope") scope = word;
      pending = undefined;
      continue;
    }
    const option = command
      .createHelp()
      .visibleOptions(command)
      .find((candidate) => candidate.long === word.split("=")[0] || candidate.short === word);
    if (option) {
      if (option.long === "--scope" && word.includes("=")) scope = word.slice(word.indexOf("=") + 1);
      if ((option.required || option.optional) && !word.includes("=")) pending = option;
      continue;
    }
    const child = command
      .createHelp()
      .visibleCommands(command)
      .find((candidate) => candidate.name() === word || candidate.aliases().includes(word));
    if (child) {
      command = child;
      arguments_.length = 0;
    } else arguments_.push(word);
  }
  if (pending) return (pending.argChoices ?? []).filter((value) => value.startsWith(prefix));
  if (prefix.includes("=")) {
    const [name = "", value = ""] = prefix.split("=");
    const option = command.options.find((candidate) => candidate.long === name);
    return (option?.argChoices ?? []).filter((choice) => choice.startsWith(value)).map((choice) => `${name}=${choice}`);
  }
  let values: string[] = [];
  if (command.parent?.name() === "config") {
    if (!arguments_.length)
      values =
        scope === "global"
          ? Object.keys(userOptions)
          : scope === "project"
            ? projectOptionKeys
            : scope === "local"
              ? [...Object.keys(userOptions), "checks.environment"]
              : [...Object.keys(userOptions), ...projectOptionKeys];
    else if (
      command.name() === "set" &&
      arguments_.length === 1 &&
      Object.entries(userOptions).find(([key]) => key === arguments_[0])?.[1].type === "boolean"
    )
      values = ["true", "false"];
    else if (command.name() === "set" && arguments_.length === 1)
      values = projectField(arguments_[0] ?? "")?.choices ?? [];
    if (scope === "local" && arguments_[0] === "checks.environment")
      values = values.filter((value) => value !== "nix-docker");
  } else if (command.name() === "completion" && !arguments_.length) values = completionShells;
  else values = command.registeredArguments[arguments_.length]?.argChoices ?? [];
  const options = command
    .createHelp()
    .visibleOptions(command)
    .flatMap((option) => [option.short, option.long].filter((value): value is string => !!value));
  const children = arguments_.length
    ? []
    : command
        .createHelp()
        .visibleCommands(command)
        .map((child) => child.name());
  return [...new Set(prefix.startsWith("-") ? options : [...children, ...values])]
    .filter((value) => value.startsWith(prefix))
    .sort();
}

export function completionScript(shell: string): string {
  switch (shell) {
    case "bash":
      return `_workbench_complete() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do COMPREPLY+=("$candidate"); done < <(command workbench complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
}
complete -o default -F _workbench_complete workbench
`;
    case "zsh":
      return `#compdef workbench
_workbench_complete() {
  local -a candidates
  candidates=("\${(@f)$(command workbench complete -- "\${words[@]:1:$((CURRENT-1))}" 2>/dev/null)}")
  if (( \${#candidates} )); then compadd -- "\${candidates[@]}"; else _files; fi
}
compdef _workbench_complete workbench
`;
    case "fish":
      return `function __workbench_candidates
  set -l tokens (commandline -opc)
  set -l current (commandline -ct)
  command workbench complete -- $tokens[2..-1] "$current" 2>/dev/null
end
complete -c workbench -a '(__workbench_candidates)'
`;
    case "powershell":
      return `Register-ArgumentCompleter -Native -CommandName workbench -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | Where-Object { $_.Extent.StartOffset -lt $cursorPosition } | ForEach-Object {
    if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } else { $_.Extent.Text }
  })
  $completeOptions = @()
  if ($wordToComplete -eq '') { $completeOptions += '--empty' } else { $words[-1] = $wordToComplete }
  workbench complete @completeOptions -- @words 2>$null | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
    default:
      throw new Error(`completion shell must be ${completionShells.join(", ")}`);
  }
}
