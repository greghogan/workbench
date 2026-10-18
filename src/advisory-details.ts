import { isRecord } from "../scripts/values.mjs";
import { safeOutput } from "./terminal-text.js";

export interface Advisory {
  id: string;
  summary?: string;
  severity?: string;
  affected: {
    name: string;
    ecosystem: string;
    ranges: { type?: string; events: { kind: string; value: string }[] }[];
  }[];
}
export const advisoryInline = (text: string): string => safeOutput(text).replace(/\s+/g, " ").trim().slice(0, 2000);

export function readAdvisory(value: unknown, id: string): Advisory {
  if (!isRecord(value) || value.id !== id) throw new Error("Invalid advisory details");
  return {
    id,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(isRecord(value.database_specific) && typeof value.database_specific.severity === "string"
      ? { severity: value.database_specific.severity }
      : {}),
    affected: (Array.isArray(value.affected) ? value.affected : []).flatMap((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !isRecord(entry.package) ||
        typeof entry.package.name !== "string" ||
        typeof entry.package.ecosystem !== "string" ||
        !Array.isArray(entry.ranges)
      )
        return [];
      return [
        {
          name: entry.package.name,
          ecosystem: entry.package.ecosystem,
          ranges: entry.ranges.flatMap((range: unknown) => {
            if (!isRecord(range) || !Array.isArray(range.events)) return [];
            return [
              {
                ...(typeof range.type === "string" ? { type: range.type } : {}),
                events: range.events.flatMap((event: unknown) =>
                  !isRecord(event)
                    ? []
                    : ["introduced", "fixed", "last_affected", "limit"].flatMap((kind) => {
                        const field = event[kind];
                        return typeof field === "string" ? [{ kind, value: field }] : [];
                      }),
                ),
              },
            ];
          }),
        },
      ];
    }),
  };
}

/** Optional enrichment never suppresses the primary locked-dependency finding. */
export async function fetchAdvisory(id: string): Promise<Advisory | undefined> {
  try {
    const response = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    return readAdvisory(await response.json(), id);
  } catch {
    return undefined;
  }
}

export function formatAdvisory(
  id: string,
  advisory: Advisory | undefined,
  query: { name: string; ecosystem: string },
): string[] {
  const link = /^GHSA-[a-z0-9-]+$/.test(id)
    ? `https://github.com/advisories/${id}`
    : `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
  if (!advisory)
    return ["  Advisory details unavailable; the locked dependency finding still blocks this check.", `  ${link}`];
  const lines: string[] = [],
    fixed = new Set<string>();
  if (advisory.summary !== undefined) lines.push(`  ${advisoryInline(advisory.summary)}`);
  if (advisory.severity !== undefined) lines.push(`  Severity: ${advisoryInline(advisory.severity)}`);
  for (const entry of advisory.affected.filter(
    (entry) => entry.name === query.name && entry.ecosystem === query.ecosystem,
  )) {
    for (const range of entry.ranges) {
      const boundaries = range.events.map((event) => {
        if (event.kind === "fixed" && range.type !== "GIT") fixed.add(advisoryInline(event.value));
        return `${event.kind}: ${advisoryInline(event.value)}`;
      });
      if (boundaries.length) lines.push(`  Affected range: ${boundaries.join("; ")}`);
    }
  }
  lines.push(
    fixed.size
      ? `  Fixed release boundaries reported: ${[...fixed].join(", ")}`
      : "  No fixed release reported; review the advisory.",
  );
  return [...lines, `  ${link}`];
}
