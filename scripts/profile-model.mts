export const profileCases = ["startup", "validation", "checks", "web"] as const;
export type ProfileCase = (typeof profileCases)[number];
export function isProfileCase(value: string): value is ProfileCase {
  return (profileCases as readonly string[]).includes(value);
}
export interface ProfileMeasurement {
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  blockInputOps: number;
  blockOutputOps: number;
  maximumRssKiB: number;
}
export function decodeMeasurement(value: unknown): ProfileMeasurement {
  if (!value || typeof value !== "object") throw new Error("Profiling measurement was not produced");
  const record = value as Record<string, unknown>;
  const keys = ["wallMs", "cpuUserMs", "cpuSystemMs", "blockInputOps", "blockOutputOps", "maximumRssKiB"] as const;
  for (const key of keys)
    if (!(key in value) || typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0)
      throw new Error(`Invalid profiling measurement: ${key}`);
  return value as ProfileMeasurement;
}
export interface ProfileSample {
  profiled: boolean;
  wallMs: number;
  status: "passed" | "failed";
  measurement?: ProfileMeasurement;
  error?: string;
  process?: { status: number | null; signal: string | null };
  captures: { path: string; bytes: number }[];
}
export interface ProfileResult {
  kind: ProfileCase;
  samples: ProfileSample[];
}
