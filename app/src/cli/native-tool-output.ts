import { delimiter } from "node:path";
import { nativeToolInspection, type NativeToolSelection } from "../core/toolchains/native/native-tools.js";
export function listNativeTools(
  root: string,
  selected?: string,
  json = false,
  selection: NativeToolSelection = {},
): void {
  const entries = nativeToolInspection(root, selected, selection);
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  let previous: string | undefined;
  for (const entry of entries) {
    if (entry.root !== previous) {
      console.log(`${entry.root}:`);
      previous = entry.root;
    }
    const artifact = "directory" in entry;
    const location = artifact
      ? entry.directory
      : {
          rustup: "rustup",
          "visual-studio": "Visual Studio Installer (pinned toolset and Windows SDK)",
          uv: "uv python dir",
          unavailable: "no verified artifact metadata",
        }[entry.manager];
    console.log(
      `  ${entry.tool} ${entry.version} (${entry.source}): ${location}${artifact ? ` [${entry.state}]` : ""}`,
    );
    if (entry.binPaths.length) console.log(`    bin: ${entry.binPaths.join(delimiter)}`);
  }
}
