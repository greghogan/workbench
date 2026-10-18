import { quote } from "./toolchains.js";
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { validateCheckControl } from "./check-control.js";
import { CheckLines } from "./check-progress.js";
import { checkDetailPrefix, readCheckDetail } from "../scripts/check-detail-data.mjs";
import { coverageChange } from "../scripts/coverage-summary.mjs";
import { safeOutput } from "./terminal-text.js";
import { once } from "node:events";
import type { Writable } from "node:stream";
export { checkLogDirectory } from "./builds.js";

/** Read closed logs while their owner still holds the run lock. */
export async function presentCheckSummaries(
  logs: { log: string; root: string; environment: string }[],
  output: Writable = process.stdout,
  reportError: (message: string) => unknown = console.error,
): Promise<void> {
  for (const entry of logs) {
    let heading = false;
    try {
      for await (const line of checkSummary(entry.log)) {
        if (!heading) {
          if (!output.write(`Check details: ${safeOutput(entry.root)} (${safeOutput(entry.environment)})\n`))
            await once(output, "drain");
          heading = true;
        }
        if (!output.write(`${line}\n`)) await once(output, "drain");
      }
    } catch (failure) {
      reportError(`Cannot present check details: ${safeOutput(String(failure))}`);
    }
  }
}

/** Present each root's result lines together after the active display has finished. */
export async function* checkSummary(path: string): AsyncGenerator<string> {
  const lines: string[] = [];
  let previousDetail: string | undefined;
  const decoder = new CheckLines((line) => {
    if (!line.startsWith(checkDetailPrefix)) return;
    if (line === previousDetail) return;
    previousDetail = line;
    const detail = readCheckDetail(JSON.parse(line.slice(checkDetailPrefix.length)));
    if (detail.kind === "slow") {
      lines.push(
        `SLOW ${detail.scope} ${safeOutput(detail.name)}: ${String(detail.elapsedSeconds)}s (soft cap ${String(detail.thresholdSeconds)}s; advisory only)`,
      );
    } else if (detail.kind === "coverage-unavailable") {
      lines.push(`Coverage change unavailable: ${safeOutput(detail.reason)}`);
    } else {
      if (detail.notice) lines.push(safeOutput(detail.notice));
      lines.push(
        `Coverage root: ${safeOutput(detail.root)}`,
        ...coverageChange(
          { total: detail.current },
          detail.baseline ? { total: detail.baseline } : undefined,
          safeOutput(detail.revision),
        )
          .split("\n")
          .filter((entry) => entry && !entry.startsWith("##")),
      );
    }
  });
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("unexpected check log encoding");
      decoder.push(chunk);
      yield* lines.splice(0);
    }
    decoder.end();
    yield* lines;
  } finally {
    stream.destroy();
  }
}

/** One progress/logging prelude per session keeps command arguments bounded. */
export function checkOutputPrelude(total: number, verbose: boolean, run: string, control?: string): string[] {
  if (control !== undefined) validateCheckControl(control);
  const events = control !== undefined || process.env.WORKBENCH_CHECK_EVENTS === "1";
  return [
    ...(control ? ["export WORKBENCH_CHECK_DETAILS=1"] : []),
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
    const length = Math.min(size, 8192);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, size - length);
    const lines = bytes
      .subarray(0, bytesRead)
      .toString("utf8")
      .trimEnd()
      .split(/\r?\n/)
      .filter(
        (line) =>
          !line.startsWith(checkDetailPrefix) &&
          !/^WORKBENCH_CHECK_(?:EVENT\t|CONTROL\t[0-9a-f]{32}\t)(?:start|pass|fail)\t[0-9]+$/.test(line),
      );
    return `${size > length || lines.length > 40 ? "Earlier output omitted; see the full log.\n" : ""}${lines.slice(-40).join("\n")}\n`;
  } finally {
    await file.close();
  }
}
