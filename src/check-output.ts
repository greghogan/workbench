import { quote } from "./toolchains.js";
import { open } from "node:fs/promises";
import { validateCheckControl } from "./check-control.js";
import { checkDetailPrefix, type CheckDetail } from "../scripts/check-detail-data.mjs";
import { coverageMetrics } from "../scripts/coverage-summary.mjs";
import { safeOutput } from "./terminal-output.js";
import { redact } from "./diagnostics.js";
export { checkLogDirectory } from "./builds.js";

/** Coverage deltas and warnings belong to the completed check, never a second table after the gate. */
export function checkDetailLines(detail: CheckDetail): string[] {
  const inline = (value: string) => safeOutput(value).replace(/\s+/g, " ").trim();
  if (detail.kind === "slow")
    return [
      `SLOW ${detail.scope} ${inline(detail.name)}: ${detail.elapsedSeconds.toFixed(2)}s (soft cap ${String(detail.thresholdSeconds)}s; advisory only)`,
    ];
  if (detail.kind === "coverage-unavailable") return [`Coverage change unavailable: ${inline(detail.reason)}`];
  const metrics = coverageMetrics.flatMap((name) => {
    const current = detail.current[name];
    if (!current) return [];
    const before = detail.baseline?.[name];
    const delta =
      typeof current.pct === "number" && typeof before?.pct === "number"
        ? Math.round((current.pct - before.pct) * 100) / 100
        : undefined;
    return [
      `${name} ${String(current.pct)}${typeof current.pct === "number" ? "%" : ""}${delta === undefined ? " (change unavailable)" : ` (${delta > 0 ? "+" : ""}${delta.toFixed(2)} pp)`}`,
    ];
  });
  return [
    ...(detail.notice ? [inline(detail.notice)] : []),
    `Coverage vs ${inline(detail.revision)}: ${metrics.join("; ")}${detail.baseline ? "" : "; no committed baseline"}`,
  ];
}

/** One progress/logging prelude per session keeps command arguments bounded. */
export function checkOutputPrelude(total: number, verbose: boolean, run: string, control?: string): string[] {
  if (control !== undefined) validateCheckControl(control);
  const events = control !== undefined || process.env.WORKBENCH_CHECK_EVENTS === "1";
  return [
    ...(control ? ["export WORKBENCH_CHECK_DETAILS=1"] : []),
    // An EXIT trap can run inside a redirected brace group when sh reads a script file.
    "exec 3>&1 4>&2",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `workbench_check_total=${String(total)}`,
    'workbench_check_build_dir="${WORKBENCH_BUILD_DIR:-${TMPDIR:-/tmp}}"',
    `workbench_check_run=${quote(run)}`,
    `workbench_check_verbose=${verbose ? "1" : "0"}`,
    `workbench_check_events=${events ? "1" : "0"}`,
    `workbench_check_control=${quote(control ?? "")}`,
    String.raw`workbench_check_event() {
  if [ -n "$workbench_check_control" ]; then
    printf '\nWORKBENCH_CHECK_CONTROL\t%s\t%s\t%s\n' "$workbench_check_control" "$1" "$workbench_check_step"
  else printf '\nWORKBENCH_CHECK_EVENT\t%s\t%s\n' "$1" "$workbench_check_step"; fi
}
workbench_check_failed() {
  workbench_check_status=$?
  exec 1>&3 2>&4
  if [ "$workbench_check_events" = 1 ]; then workbench_check_event fail
  else printf '[%s/%s completed] Failed %s\n' "$((workbench_check_step - 1))" "$workbench_check_total" "$workbench_check_label"; fi
  if [ "$workbench_check_verbose" = 0 ] && [ "$workbench_check_replay" != 0 ]; then cat "$workbench_check_log"; fi
  exit "$workbench_check_status"
}
workbench_check_start() {
  workbench_check_step=$1 workbench_check_label=$2 workbench_check_replay=1
  if [ "$workbench_check_events" = 1 ]; then workbench_check_event start
  else printf '[%s/%s completed] Running %s\n' "$((workbench_check_step - 1))" "$workbench_check_total" "$workbench_check_label"; fi
  if [ "$workbench_check_verbose" = 0 ]; then
    workbench_check_log_dir="$workbench_check_build_dir/check-logs/$workbench_check_run"
    mkdir -p "$workbench_check_log_dir"
    workbench_check_log=$(mktemp "$workbench_check_log_dir/step-$workbench_check_step.XXXXXX")
  fi
  trap workbench_check_failed 0
}
workbench_check_done() {
  trap - 0
  if [ "$workbench_check_verbose" = 0 ]; then
    grep '^WORKBENCH_CHECK_DETAIL' "$workbench_check_log" || :
  fi
  if [ "$workbench_check_events" = 1 ]; then workbench_check_event pass
  else printf '[%s/%s completed] Passed %s\n' "$workbench_check_step" "$workbench_check_total" "$workbench_check_label"; fi
}`,
  ];
}

/** Redirection preserves shared shell state and the caller's errexit behavior. */
export function checkOutput(
  commands: string[],
  label: string,
  step: number,
  verbose: boolean,
  after: string[] = [],
): string[] {
  const body = commands.join("\n");
  return [
    `workbench_check_start ${String(step)} ${quote(label)}`,
    verbose ? body : `{\n${body}\n} >"$workbench_check_log" 2>&1`,
    ...after,
    "workbench_check_done",
  ];
}

/** Concise failures show bounded context; the complete bytes remain in the retained log. */
export async function checkFailureExcerpt(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 8192),
      headLength = size > length ? 2048 : 0;
    const head = Buffer.alloc(headLength),
      tail = Buffer.alloc(length - headLength);
    if (headLength) await file.read(head, 0, headLength, 0);
    const offset = size - tail.length;
    const { bytesRead } = await file.read(tail, 0, tail.length, offset);
    let start = 0;
    while (start < bytesRead && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
    const text = `${headLength ? head.toString("utf8").replace(/\uFFFD$/, "") + "\n[Middle output omitted; see the retained log.]\n" : ""}${tail.subarray(start, bytesRead).toString("utf8")}`;
    const lines = text
      .trimEnd()
      .split(/\r?\n/)
      .filter(
        (line) =>
          !line.startsWith(checkDetailPrefix) &&
          !line.startsWith("WORKBENCH_CHECK_CONTROL\t") &&
          !/^WORKBENCH_CHECK_(?:EVENT\t|CONTROL\t[0-9a-f]{32}\t)(?:start|pass|fail)\t[0-9]+$/.test(line),
      );
    const selected =
      lines.length > 40
        ? [...lines.slice(0, 9), "[Middle lines omitted; see the retained log.]", ...lines.slice(-30)]
        : lines;
    return redact(
      `${size > length || lines.length > 40 ? "Earlier output omitted; see the full log.\n" : ""}${selected.join("\n")}\n`,
    );
  } finally {
    await file.close();
  }
}
