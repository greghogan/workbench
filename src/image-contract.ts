import { createHash } from "node:crypto";
import { join } from "node:path";
import { userDirectory } from "./storage.js";

export const imageHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const imageDigest = /^sha256:[a-f0-9]{64}$/;
export function imageProfileLock(root: string, profile: string): string {
  return join(userDirectory("cache"), "offline-profiles", imageHash(root), `${profile}.json`);
}
export function parsePreparedTag(tag: string) {
  const match = /^linux-(x64|arm64)-([a-f0-9]{64})$/.exec(tag);
  return match ? { architecture: match[1] ?? "", inputs: match[2] ?? "" } : undefined;
}
export function preparedImageTag(architecture: string, inputs: string): string {
  const tag = `linux-${architecture}-${inputs}`;
  if (!parsePreparedTag(tag)) throw new Error("Invalid prepared image identity");
  return tag;
}
export function imageDisplayTag(reference: string): string {
  const tag = reference.slice(reference.lastIndexOf(":") + 1);
  const parsed = parsePreparedTag(tag);
  return parsed ? `linux-${parsed.architecture}-${parsed.inputs.slice(0, 12)}` : tag;
}
export function localPreparedReference(reference: string): boolean {
  const separator = reference.indexOf(":");
  return (
    /^workbench-prepared-[a-f0-9]{24}$/.test(reference.slice(0, separator)) &&
    parsePreparedTag(reference.slice(separator + 1)) !== undefined
  );
}
const protectionMessages = {
  changed: "image no longer matches its verification receipt",
  attached: "referenced by a Docker container",
  locked: "active or recovery-required preparation lock",
  unrelatedTags: "version also has tags outside Workbench's prepared-image namespace",
} as const;
export type ImageProtection = keyof typeof protectionMessages;
export function imageProtection(reason?: ImageProtection) {
  return reason ? { blockedReason: reason, blockedBy: protectionMessages[reason] } : {};
}
interface ImageEntry {
  key: string;
  checkout: string;
  profile: string;
  reference: string;
  image: string;
  bytes: number;
  lock: string;
  identity: string;
  blockedReason?: ImageProtection;
  blockedBy?: string;
}
export interface LocalImageEntry extends ImageEntry {
  catalog: string;
  verified?: string;
}
export interface RegistryImageEntry extends ImageEntry {
  endpoint: string;
  tags: string[];
  created: string;
}
export interface LocalImageReport {
  location: "local";
  entries: LocalImageEntry[];
  issues: string[];
}
export interface RegistryImageReport {
  location: "registry";
  entries: RegistryImageEntry[];
  issues: string[];
}
export type PreparedImageEntry = LocalImageEntry | RegistryImageEntry;
export type PreparedImageReport = LocalImageReport | RegistryImageReport;
export function filterPreparedImages<T extends PreparedImageReport>(
  report: T,
  predicate: (entry: PreparedImageEntry) => boolean,
): T {
  return { ...report, entries: report.entries.filter(predicate) };
}
