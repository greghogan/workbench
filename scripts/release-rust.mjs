import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const result = spawnSync("cargo", ["build", "--release", "--locked", "--message-format=json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 16 * 1024 * 1024,
});
const artifacts = [];
for (const line of (result.stdout ?? "").split("\n").filter(Boolean)) {
  const event = JSON.parse(line);
  if (event.reason === "compiler-message" && event.message.rendered) process.stderr.write(event.message.rendered);
  if (event.reason === "compiler-artifact" && event.executable) artifacts.push(event.executable);
}
if (result.error || result.status !== 0) throw new Error(`Rust release failed: ${result.error ?? result.status}`);
if (!artifacts.length) throw new Error("this reference release adapter expects at least one executable");
mkdirSync("dist", { recursive: true });
for (const artifact of artifacts) copyFileSync(artifact, join("dist", basename(artifact)));
