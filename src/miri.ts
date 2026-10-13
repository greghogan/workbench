import { existsSync } from "node:fs";
import { join } from "node:path";
import { readToml } from "./core.js";
import { execute } from "./tool-downloads.js";

export const miriToolchainFile = "rust-toolchain-miri.toml";
interface MiriToolchain {
  channel: string;
  profile: "minimal";
  components: string[];
}

/** A supplementary rustup declaration never overrides the root's normal compiler. */
export function miriToolchain(directory: string): MiriToolchain | undefined {
  const file = join(directory, miriToolchainFile);
  if (!existsSync(file)) return undefined;
  const data = readToml(file) as { toolchain?: Record<string, unknown> };
  const pin = data.toolchain;
  const channel = pin?.channel;
  const date = typeof channel === "string" ? /^nightly-(\d{4}-\d{2}-\d{2})$/.exec(channel)?.[1] : undefined;
  if (!pin || !date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
    throw new Error(`${file}: Miri requires a dated nightly-YYYY-MM-DD pin`);
  if (
    Object.keys(data).some((key) => key !== "toolchain") ||
    Object.keys(pin).some((key) => !["channel", "profile", "components"].includes(key)) ||
    pin.profile !== "minimal" ||
    !Array.isArray(pin.components) ||
    pin.components.some((component: unknown) => typeof component !== "string" || !component) ||
    !["miri", "rust-src"].every((component) => (pin.components as unknown[]).includes(component))
  )
    throw new Error(`${file}: declare channel, profile = "minimal", and components including miri and rust-src`);
  return { channel: String(channel), profile: pin.profile, components: pin.components as string[] };
}

export function runMiri(directory: string, args: string[]): void {
  const pin = miriToolchain(directory);
  if (!pin) throw new Error(`Miri needs ${miriToolchainFile} in the selected language root`);
  if (process.env.GUIX_ENVIRONMENT || process.env.IN_NIX_SHELL)
    throw new Error("the rustup Miri check uses native or devcontainer; run it separately from Guix/Nix checks");
  console.log(`Miri toolchain: ${pin.channel} (${miriToolchainFile})`);
  const options = { cwd: directory, env: { ...process.env, RUSTUP_TOOLCHAIN: pin.channel, RUSTUP_AUTO_INSTALL: "0" } };
  const prefix = ["run", pin.channel, "cargo", "miri"];
  execute("rustup", [...prefix, "--version"], options);
  execute("rustup", [...prefix, ...args], options);
}
