import { toolAdapter, type ProbeTool } from "./tool-adapters.js";
/** Package-owned executable contracts. Package names never imply executable names or arguments. */
export interface ToolProbe {
  name: string;
  executable: string;
  args: string[];
  expected?: string;
  match?: "exact" | "prefix" | "word" | "llvm" | "ninja" | "contains";
  windowsSuffix?: string;
  reportArgs?: string[];
  compilerVariable?: "WORKBENCH_CC" | "WORKBENCH_CXX";
  showOutput?: boolean;
}

/** A required SDK cannot run; executing the gate cannot repair this prerequisite. */
export class NativeToolUnavailable extends Error {}

export function toolProbes(tool: ProbeTool, purpose: "development" | "compatibility" = "development"): ToolProbe[] {
  return toolAdapter(tool).probes(tool, purpose);
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Shared shell matcher, emitted once per guard to keep command arguments bounded. */
export const probePrelude = String.raw`workbench_quiet_tools=0
workbench_probe() {
  tool_name=$1 tool_source=$2 tool_expected=$3 tool_mode=$4 tool_enforce=$5 tool_environment=$6 tool_output=$7
  shift 7
  tool_actual=$("$@" 2>&1) || { printf 'workbench: cannot execute %s for %s; run workbench tools install or supply matching tools on PATH\n%s\n' "$tool_name" "$tool_source" "$tool_actual" >&2; exit 1; }
  tool_actual=$(printf "%s" "$tool_actual" | tr -d "\r")
  if [ "$tool_enforce" = true ] && [ "$tool_mode" != none ]; then
    tool_match=false
    case "$tool_mode" in
      contains) case "$tool_actual" in *"$tool_expected"*) tool_match=true;; esac;;
      exact) case "$tool_actual" in "$tool_expected") tool_match=true;; esac;;
      prefix) case "$tool_actual" in "$tool_expected"*) tool_match=true;; esac;;
      llvm) case "$tool_actual" in *"$tool_expected"|*"$tool_expected"[!0-9.]*) tool_match=true;; esac;;
      word|ninja)
        set -f
        for tool_word in $tool_actual; do
          case "$tool_word" in "$tool_expected"|"v$tool_expected") tool_match=true;; esac
          if [ "$tool_mode" = ninja ]; then
            case "$tool_word" in "$tool_expected".git.kitware.*) tool_match=true;; esac
          fi
        done;;
    esac
    "$tool_match" || { printf 'workbench: %s must match %s: expected %s; run workbench tools install or supply matching tools on PATH\n%s\n' "$tool_name" "$tool_source" "$tool_expected" "$tool_actual" >&2; exit 1; }
  fi
  if [ "$workbench_quiet_tools" != 1 ]; then
    printf 'Toolchain (%s): %s\n' "$tool_environment" "$tool_name"
    if [ "$tool_output" = true ]; then printf '%s\n' "$tool_actual"; fi
  fi
}`;

/** Explicit executable arguments and version matching, shared by installation and environment checks. */
export function probeScript(
  probe: ToolProbe,
  command: string[],
  source: string,
  enforce: boolean,
  managed = false,
): string[] {
  const lines = [
    [
      "workbench_probe",
      probe.name,
      source,
      probe.expected ?? "",
      probe.expected === undefined ? "none" : (probe.match ?? "exact"),
      String(enforce),
      managed ? "pinned environment" : "host",
      String(!probe.reportArgs && probe.showOutput !== false),
      ...command,
    ]
      .map(quote)
      .join(" "),
  ];
  if (probe.reportArgs)
    lines.push(
      `if [ "\${workbench_quiet_tools:-0}" != 1 ]; then ${[...command.slice(0, command.length - probe.args.length), ...probe.reportArgs].map(quote).join(" ")}; fi`,
    );
  return lines;
}
