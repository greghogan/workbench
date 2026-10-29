import { BoundedState } from "./bounded-state.js";
import { InvalidInput } from "./input-errors.js";
import { decodeCompatibilityAssessment, type CompatibilityAssessment } from "./policy-findings.js";
import { record, records, string } from "../scripts/values.mjs";

interface PolicySource {
  id: string;
  directory: string;
  digest: string;
}
export interface CompatibilityAcknowledgment {
  digest: string;
  project: string;
  local: string;
  reviewed: true;
  reviewed_at?: string;
  sources?: PolicySource[];
  resolved_assessment?: CompatibilityAssessment | null;
}
interface Receipts extends CompatibilityAcknowledgment {
  history: CompatibilityAcknowledgment[];
}
const digest = (value: unknown) => {
  const text = string(value, "Missing compatibility digest");
  if (!/^[a-f0-9]{64}$/.test(text)) throw new InvalidInput("Invalid compatibility digest");
  return text;
};
function acknowledgment(value: unknown): CompatibilityAcknowledgment {
  const item = record(value, "Invalid compatibility acknowledgment");
  if (item.reviewed !== true) throw new InvalidInput("Invalid compatibility acknowledgment");
  if (
    item.reviewed_at !== undefined &&
    (typeof item.reviewed_at !== "string" || !Number.isFinite(Date.parse(item.reviewed_at)))
  )
    throw new InvalidInput("Invalid compatibility review time");
  return {
    digest: digest(item.digest),
    project: digest(item.project),
    local: digest(item.local),
    reviewed: true,
    ...(typeof item.reviewed_at === "string" ? { reviewed_at: item.reviewed_at } : {}),
    ...(item.sources === undefined
      ? {}
      : {
          sources: records(item.sources, "Invalid reviewed policy sources").map((source) => ({
            id: string(source.id, "Missing reviewed source ID"),
            directory: string(source.directory, "Missing reviewed source directory"),
            digest: digest(source.digest),
          })),
        }),
    ...(item.resolved_assessment === undefined
      ? {}
      : {
          resolved_assessment:
            item.resolved_assessment === null ? null : decodeCompatibilityAssessment(item.resolved_assessment),
        }),
  };
}
function decode(value: unknown): Receipts {
  const item = record(value, "Invalid compatibility receipts"),
    latest = acknowledgment(item);
  const history =
    item.history === undefined
      ? []
      : records(item.history, "Invalid compatibility receipt history").map(acknowledgment);
  if (history.length >= 10000 || new Set([latest, ...history].map((entry) => entry.digest)).size !== history.length + 1)
    throw new InvalidInput("Invalid or excessive compatibility receipt history");
  return { ...latest, history };
}
const store = (path: string) =>
  new BoundedState<Receipts | undefined>(
    () => path,
    16 * 1024 * 1024,
    decode,
    () => undefined,
  );

/** Each acknowledgment remains bound to its own policy digest, independent of the most recently selected tree. */
export function compatibilityAcknowledgments(path: string): CompatibilityAcknowledgment[] {
  const saved = store(path).read();
  if (!saved) return [];
  const { history, ...latest } = saved;
  return [latest, ...history];
}
/** The caller holds the shared receipt lock across review validation and publication. */
export function recordCompatibilityAcknowledgment(path: string, value: CompatibilityAcknowledgment): void {
  const history = compatibilityAcknowledgments(path).filter((entry) => entry.digest !== value.digest);
  store(path).write({ ...value, history });
}
