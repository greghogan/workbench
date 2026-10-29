import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { withCacheLockSync } from "./cache-lock.js";
import { InvalidInput, StateConflict } from "./input-errors.js";

export const CompatibilityDecision = { Approve: "approve", Dismiss: "dismiss" } as const;
export type CompatibilityDecision = (typeof CompatibilityDecision)[keyof typeof CompatibilityDecision];
export interface CompatibilityFinding {
  id: string;
  summary: string;
  details: string;
  records: string[];
  proposed_resolution: string;
  decision: { outcome: CompatibilityDecision; reviewed_at: string } | null;
}
export interface CompatibilityAssessment {
  schema_version: 1;
  policy_digest: string;
  reported_at: string;
  findings: CompatibilityFinding[];
}
const digest = /^[a-f0-9]{64}$/;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const compatibilityFindingsPath = (receipt: string): string => join(dirname(receipt), "findings.json");
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function table(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidInput("Invalid compatibility findings");
  return value as Record<string, unknown>;
}
function prose(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new InvalidInput(`Compatibility finding requires ${name}`);
  return value;
}
function content(value: unknown): Omit<CompatibilityFinding, "id" | "decision"> {
  const item = table(value);
  for (const key of Object.keys(item))
    if (!["id", "decision", "summary", "details", "records", "proposed_resolution"].includes(key))
      throw new InvalidInput(`Unknown compatibility finding field: ${key}`);
  if (
    !Array.isArray(item.records) ||
    !item.records.length ||
    item.records.some(
      (record: unknown) => typeof record !== "string" || !/^[a-z][a-z0-9_-]*:(?:ADR-[0-9A-Z]+|CHARTER)$/.test(record),
    )
  )
    throw new InvalidInput("Compatibility finding requires scoped ADR or charter references");
  return {
    summary: prose(item.summary, "summary"),
    details: prose(item.details, "details"),
    records: [...new Set(item.records as string[])].sort(),
    proposed_resolution: prose(item.proposed_resolution, "proposed_resolution"),
  };
}
export function compatibilityFindingId(policy: string, finding: Omit<CompatibilityFinding, "id" | "decision">): string {
  return hash({
    policy,
    summary: finding.summary,
    details: finding.details,
    records: [...finding.records].sort(),
    proposed_resolution: finding.proposed_resolution,
  });
}
export function decodeCompatibilityAssessment(value: unknown): CompatibilityAssessment {
  const data = table(value);
  if (Object.keys(data).some((key) => !["schema_version", "policy_digest", "reported_at", "findings"].includes(key)))
    throw new InvalidInput("Unknown compatibility assessment field");
  if (
    data.schema_version !== 1 ||
    typeof data.policy_digest !== "string" ||
    !digest.test(data.policy_digest) ||
    !timestamp(data.reported_at) ||
    !Array.isArray(data.findings) ||
    !data.findings.length ||
    data.findings.length > 256 ||
    Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
  )
    throw new InvalidInput("Invalid compatibility assessment");
  const policyDigest = data.policy_digest;
  const seen = new Set<string>();
  const findings = (data.findings as unknown[]).map((entry) => {
    const item = table(entry),
      finding = content(item);
    if (item.id !== compatibilityFindingId(policyDigest, finding) || seen.has(item.id))
      throw new InvalidInput("Invalid or duplicate compatibility finding identity");
    seen.add(item.id);
    let decision: CompatibilityFinding["decision"] = null;
    if (item.decision !== null) {
      const selected = table(item.decision);
      if (Object.keys(selected).some((key) => !["outcome", "reviewed_at"].includes(key)))
        throw new InvalidInput("Unknown compatibility decision field");
      if (
        !Object.values(CompatibilityDecision).some((outcome) => outcome === selected.outcome) ||
        !timestamp(selected.reviewed_at)
      )
        throw new InvalidInput("Invalid compatibility finding decision");
      decision = { outcome: selected.outcome as CompatibilityDecision, reviewed_at: selected.reviewed_at };
    }
    return { id: item.id, ...finding, decision };
  });
  return { schema_version: 1, policy_digest: data.policy_digest, reported_at: data.reported_at, findings };
}
export function readCompatibilityAssessment(receipt: string): CompatibilityAssessment | null {
  const path = compatibilityFindingsPath(receipt);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) throw new InvalidInput("Compatibility assessment exceeds 1 MiB");
  return decodeCompatibilityAssessment(JSON.parse(bytes.toString("utf8")));
}
function publish(receipt: string, value: CompatibilityAssessment): void {
  decodeCompatibilityAssessment(value);
  const contents = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new InvalidInput("Compatibility assessment exceeds 1 MiB");
  writeAtomic(compatibilityFindingsPath(receipt), contents);
}
/** Called under the compatibility receipt lock after checking the policy digest and referenced records. */
export function recordCompatibilityAssessment(receipt: string, policy: string, input: unknown): void {
  if (!digest.test(policy) || !Array.isArray(input) || !input.length)
    throw new InvalidInput("Supply a nonempty array of compatibility findings");
  const findings = (input as unknown[]).map((entry): CompatibilityFinding => {
    const supplied = table(entry);
    if (Object.keys(supplied).some((key) => !["summary", "details", "records", "proposed_resolution"].includes(key)))
      throw new InvalidInput("Compatibility report contains unknown finding fields");
    const finding = content(entry);
    return { id: compatibilityFindingId(policy, finding), ...finding, decision: null };
  });
  const previous = readCompatibilityAssessment(receipt);
  if (previous?.findings.some((finding) => !finding.decision) && previous.policy_digest !== policy)
    throw new StateConflict("Review the outstanding compatibility findings before replacing their policy version");
  if (previous?.policy_digest === policy) {
    const merged = new Map(previous.findings.map((finding) => [finding.id, finding]));
    for (const finding of findings) if (!merged.has(finding.id)) merged.set(finding.id, finding);
    publish(receipt, { ...previous, findings: [...merged.values()] });
  } else {
    if (previous)
      writeAtomic(
        join(dirname(receipt), "findings-history", hash(previous) + ".json"),
        JSON.stringify(previous, null, 2) + "\n",
      );
    publish(receipt, { schema_version: 1, policy_digest: policy, reported_at: new Date().toISOString(), findings });
  }
}
/** Human decisions acknowledge the exact proposed resolution; they do not edit or approve policy files. */
export function decideCompatibilityFinding(
  receipt: string,
  policy: string,
  id: string,
  outcome: CompatibilityDecision,
): void {
  withCacheLockSync(receipt, () => {
    const assessment = readCompatibilityAssessment(receipt);
    const finding = assessment?.findings.find((finding) => finding.id === id);
    if (assessment?.policy_digest !== policy || !finding)
      throw new StateConflict("Compatibility finding changed; reload before reviewing it");
    if (!Object.values(CompatibilityDecision).includes(outcome))
      throw new InvalidInput("Choose a compatibility resolution decision");
    if (finding.decision) {
      if (finding.decision.outcome !== outcome)
        throw new StateConflict("This finding was already reviewed; reload its recorded decision");
      return;
    }
    finding.decision = { outcome, reviewed_at: new Date().toISOString() };
    publish(receipt, assessment);
  });
}
/** Receipt publication must succeed before the assessment is retired. */
export function retireCompatibilityAssessment(receipt: string): void {
  const assessment = readCompatibilityAssessment(receipt);
  if (assessment)
    writeAtomic(
      join(dirname(receipt), "findings-history", hash(assessment) + ".json"),
      JSON.stringify(assessment, null, 2) + "\n",
    );
  rmSync(compatibilityFindingsPath(receipt), { force: true });
}
