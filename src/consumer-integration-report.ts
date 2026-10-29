import { record, records, string, strings } from "../scripts/values.mjs";
import { isCompilerFamily, type CompilerFamily } from "../scripts/compiler-catalog.mjs";
import { writeAtomic } from "../scripts/file-publication.mjs";
import type { ConsumerCommandResult, IntegrationState } from "./consumer-integration-runner.js";

export interface ConsumerCase {
  name: string;
  status: IntegrationState | "blocked";
  blockedBy?: string[];
  durationMs: number;
  started: string;
  finished?: string;
  error?: string;
}
export interface ConsumerSuiteReport {
  status: IntegrationState;
  cases: ConsumerCase[];
  commands: ConsumerCommandResult[];
  error?: string;
}
export interface ConsumerProfileReport extends ConsumerSuiteReport {
  id: string;
  compiler: CompilerFamily | "pins";
  languages: string[];
}
export interface ConsumerIntegrationReport {
  version: 3;
  kind: "workbench-consumer-integration";
  started: string;
  finished: string;
  status: IntegrationState;
  success: boolean;
  phase: "preparing" | "verifying" | "installations" | "profiles" | "cleanup" | "complete";
  platform: string;
  architecture: string;
  node: string;
  artifactSha256: string;
  sourceManifestSha256: string;
  installations: ConsumerSuiteReport;
  error: string;
  cleanupErrors: string[];
  profiles: ConsumerProfileReport[];
}
export class ConsumerReportRecorder {
  readonly result: ConsumerIntegrationReport = {
    version: 3,
    kind: "workbench-consumer-integration",
    started: new Date().toISOString(),
    finished: "",
    status: "running",
    success: false,
    phase: "preparing",
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    artifactSha256: "",
    sourceManifestSha256: "",
    installations: { status: "pending", cases: [], commands: [] },
    error: "",
    cleanupErrors: [],
    profiles: [],
  };
  constructor(private readonly path: string) {}
  save(): void {
    writeAtomic(this.path, JSON.stringify(this.result, null, 2) + "\n");
  }
  profile(id: string, languages: string[], compiler?: CompilerFamily): ConsumerProfileReport {
    const profile: ConsumerProfileReport = {
      id,
      languages,
      compiler: compiler ?? "pins",
      status: "pending",
      cases: [],
      commands: [],
    };
    this.result.profiles.push(profile);
    this.save();
    return profile;
  }
}

/** Validate the complete machine-readable contract rather than asserting a partially checked JSON cast. */
export function readConsumerIntegrationReport(value: unknown): ConsumerIntegrationReport {
  const input = record(value, "Invalid consumer integration report");
  if (input.version !== 3 || input.kind !== "workbench-consumer-integration" || typeof input.success !== "boolean")
    throw new Error("Invalid consumer integration report");
  const state = (value: unknown): IntegrationState => {
    if (value !== "pending" && value !== "running" && value !== "passed" && value !== "failed" && value !== "cancelled")
      throw new Error("Invalid integration state");
    return value;
  };
  const milliseconds = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("Invalid integration duration");
    return value;
  };
  const text = (value: unknown) => {
    if (typeof value !== "string") throw new Error("Invalid integration text");
    return value;
  };
  const failure = (value: unknown) => (value === undefined ? {} : { error: text(value) });
  const finished = (value: unknown) => (value === undefined ? {} : { finished: text(value) });
  const suite = (value: unknown): ConsumerSuiteReport => {
    const profile = record(value, "Invalid consumer suite");
    const cases = records(profile.cases, "Invalid consumer cases").map((entry): ConsumerCase => ({
      name: string(entry.name, "Invalid consumer case name"),
      status: entry.status === "blocked" ? "blocked" : state(entry.status),
      ...(entry.blockedBy === undefined
        ? {}
        : { blockedBy: strings(entry.blockedBy, "Invalid blocked prerequisites") }),
      durationMs: milliseconds(entry.durationMs),
      started: text(entry.started),
      ...finished(entry.finished),
      ...failure(entry.error),
    }));
    const names = new Set<string>();
    for (const entry of cases) {
      if (names.has(entry.name)) throw new Error("Duplicate consumer case");
      if (entry.status === "blocked") {
        if (!entry.blockedBy?.length || entry.blockedBy.some((name) => !names.has(name)))
          throw new Error("Invalid blocked prerequisites");
      } else if (entry.blockedBy !== undefined) throw new Error("Only blocked cases can have prerequisites");
      names.add(entry.name);
    }
    const commands = records(profile.commands, "Invalid consumer commands").map((entry): ConsumerCommandResult => {
      if (entry.status !== null && (typeof entry.status !== "number" || !Number.isInteger(entry.status)))
        throw new Error("Invalid consumer exit status");
      if (entry.signal !== null && typeof entry.signal !== "string") throw new Error("Invalid consumer signal");
      return {
        name: string(entry.name, "Invalid command name"),
        command: strings(entry.command, "Invalid command arguments"),
        cwd: string(entry.cwd, "Invalid command directory"),
        state: state(entry.state),
        status: entry.status,
        signal: entry.signal as NodeJS.Signals | null,
        durationMs: milliseconds(entry.durationMs),
        started: text(entry.started),
        ...finished(entry.finished),
        stdout: string(entry.stdout, "Invalid stdout log"),
        stderr: string(entry.stderr, "Invalid stderr log"),
        ...failure(entry.error),
      };
    });
    return { status: state(profile.status), cases, commands, ...failure(profile.error) };
  };
  const profiles = records(input.profiles, "Invalid consumer profiles").map((profile): ConsumerProfileReport => {
    const compiler = profile.compiler;
    if (compiler !== "pins" && !isCompilerFamily(compiler)) throw new Error("Invalid integration compiler");
    return {
      ...suite(profile),
      id: string(profile.id, "Invalid profile identity"),
      compiler,
      languages: strings(profile.languages, "Invalid profile languages"),
    };
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new Error("Duplicate consumer profile");
  const phase = input.phase;
  if (
    phase !== "preparing" &&
    phase !== "verifying" &&
    phase !== "installations" &&
    phase !== "profiles" &&
    phase !== "cleanup" &&
    phase !== "complete"
  )
    throw new Error("Invalid integration phase");
  return {
    version: 3,
    kind: "workbench-consumer-integration",
    started: text(input.started),
    finished: text(input.finished),
    status: state(input.status),
    success: input.success,
    phase,
    platform: string(input.platform, "Invalid report platform"),
    architecture: string(input.architecture, "Invalid report architecture"),
    node: string(input.node, "Invalid report Node version"),
    artifactSha256: text(input.artifactSha256),
    sourceManifestSha256: text(input.sourceManifestSha256),
    installations: suite(input.installations),
    error: text(input.error),
    cleanupErrors: strings(input.cleanupErrors, "Invalid cleanup failures"),
    profiles,
  };
}
