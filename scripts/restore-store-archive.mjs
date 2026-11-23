// Generated from restore-store-archive.mts; edit the TypeScript source.
import { chownSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  importManagedProfiles,
  readManagedProfileArchive,
  restoredProfileDirectory
} from "../app/src/core/execution/environments/managed/profile-transfer.mjs";
import { record, required, strings } from "../app/src/core/runtime/values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
const file = required(process.argv[2], "Missing managed archive");
const selection = record(
  JSON.parse(required(process.argv[3], "Missing managed profile selection")),
  "Invalid selection"
);
const { builder, architecture, kind } = selection;
if (builder !== "nix" && builder !== "guix" || architecture !== "x64" && architecture !== "arm64" || kind !== "toolchain" && kind !== "development")
  throw new Error("Invalid managed profile selection");
const roots = strings(selection.roots, "Invalid managed archive roots");
const expected = { builder, architecture, kind, roots };
if (!existsSync("/.dockerenv") || process.getuid?.() !== 0 || process.arch !== architecture)
  throw new Error("Archive qualification must run in a disposable container matching its architecture");
const directory = restoredProfileDirectory;
const profiles = await readManagedProfileArchive(file, expected);
if (profiles.profiles.some(({ profile }) => existsSync(profile)))
  throw new Error("The bootstrap image already contains a selected archive profile");
mkdirSync(directory, { mode: 493 });
const env = { ...process.env, ...builder === "nix" ? { NIX_REMOTE: "daemon" } : {} };
const home = "/tmp/workbench-home";
const user = process.argv[4] ?? "1000:1000";
if (!/^[1-9]\d{0,9}:\d{1,10}$/.test(user)) throw new Error("Archive execution requires a non-root user and group");
const [uid, gid] = user.split(":").map(Number);
if (uid === void 0 || gid === void 0 || uid >= 4294967295 || gid >= 4294967295)
  throw new Error("Invalid numeric user for archive execution");
mkdirSync(home, { mode: 448 });
chownSync(home, uid, gid);
await withManagedProcesses(async (scope) => {
  const command = builder === "nix" ? "nix" : "guix";
  const args = builder === "nix" ? ["--extra-experimental-features", "nix-command", "store", "ping"] : ["gc", "--list-roots"];
  for (let attempt = 0; ; attempt++) {
    try {
      await scope.run(command, args, { capture: true, env });
      break;
    } catch (cause) {
      if (attempt >= 59) throw new Error(`The bootstrap ${builder} daemon did not become ready`, { cause });
      await delay(250);
    }
  }
  const restored = await importManagedProfiles(file, expected, {
    env,
    guixVerifier: join(import.meta.dirname, "verify-guix-profile-archive.scm")
  });
  if (builder === "guix") mkdirSync(join(directory, "runtimes"));
  const registered = [];
  for (const [index, entry] of restored.entries()) {
    const name = String(index);
    const path = join(directory, name);
    if (builder === "nix") {
      await scope.run(
        "nix-store",
        ["--option", "substitute", "false", "--max-jobs", "0", "--add-root", path, "--realise", entry.profile],
        { env }
      );
    } else {
      const runtime = join(directory, "runtimes", name);
      const manager = join(directory, `manager-${name}`);
      symlinkSync(entry.profile, path);
      symlinkSync(required(entry.runtime, "Missing Guix runtime"), runtime);
      symlinkSync(required(entry.manager, "Missing Guix manager"), manager);
      registered.push(path, runtime, manager);
    }
  }
  if (registered.length) {
    await scope.run(
      "guix",
      ["repl", join(import.meta.dirname, "ci-guix-bootstrap.scm"), "register-roots", ...registered],
      { env }
    );
    const listed = (await scope.run("guix", ["gc", "--list-roots"], { capture: true, env })).split(/\r?\n/);
    if (registered.some((root) => !listed.includes(root)))
      throw new Error("Guix did not retain every restored profile root");
  }
  writeFileSync(join(directory, "roots.json"), JSON.stringify(roots), { flag: "wx", mode: 420 });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJlc3RvcmUtc3RvcmUtYXJjaGl2ZS5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY2hvd25TeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMsIHN5bWxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBzZXRUaW1lb3V0IGFzIGRlbGF5IH0gZnJvbSBcIm5vZGU6dGltZXJzL3Byb21pc2VzXCI7XG5pbXBvcnQge1xuICBpbXBvcnRNYW5hZ2VkUHJvZmlsZXMsXG4gIHJlYWRNYW5hZ2VkUHJvZmlsZUFyY2hpdmUsXG4gIHJlc3RvcmVkUHJvZmlsZURpcmVjdG9yeSxcbn0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vZW52aXJvbm1lbnRzL21hbmFnZWQvcHJvZmlsZS10cmFuc2Zlci5tanNcIjtcbmltcG9ydCB7IHJlY29yZCwgcmVxdWlyZWQsIHN0cmluZ3MgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5cbmNvbnN0IGZpbGUgPSByZXF1aXJlZChwcm9jZXNzLmFyZ3ZbMl0sIFwiTWlzc2luZyBtYW5hZ2VkIGFyY2hpdmVcIik7XG5jb25zdCBzZWxlY3Rpb24gPSByZWNvcmQoXG4gIEpTT04ucGFyc2UocmVxdWlyZWQocHJvY2Vzcy5hcmd2WzNdLCBcIk1pc3NpbmcgbWFuYWdlZCBwcm9maWxlIHNlbGVjdGlvblwiKSksXG4gIFwiSW52YWxpZCBzZWxlY3Rpb25cIixcbik7XG5jb25zdCB7IGJ1aWxkZXIsIGFyY2hpdGVjdHVyZSwga2luZCB9ID0gc2VsZWN0aW9uO1xuaWYgKFxuICAoYnVpbGRlciAhPT0gXCJuaXhcIiAmJiBidWlsZGVyICE9PSBcImd1aXhcIikgfHxcbiAgKGFyY2hpdGVjdHVyZSAhPT0gXCJ4NjRcIiAmJiBhcmNoaXRlY3R1cmUgIT09IFwiYXJtNjRcIikgfHxcbiAgKGtpbmQgIT09IFwidG9vbGNoYWluXCIgJiYga2luZCAhPT0gXCJkZXZlbG9wbWVudFwiKVxuKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1hbmFnZWQgcHJvZmlsZSBzZWxlY3Rpb25cIik7XG5jb25zdCByb290cyA9IHN0cmluZ3Moc2VsZWN0aW9uLnJvb3RzLCBcIkludmFsaWQgbWFuYWdlZCBhcmNoaXZlIHJvb3RzXCIpO1xuY29uc3QgZXhwZWN0ZWQgPSB7IGJ1aWxkZXIsIGFyY2hpdGVjdHVyZSwga2luZCwgcm9vdHMgfSBhcyBjb25zdDtcbmlmICghZXhpc3RzU3luYyhcIi8uZG9ja2VyZW52XCIpIHx8IHByb2Nlc3MuZ2V0dWlkPy4oKSAhPT0gMCB8fCBwcm9jZXNzLmFyY2ggIT09IGFyY2hpdGVjdHVyZSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiQXJjaGl2ZSBxdWFsaWZpY2F0aW9uIG11c3QgcnVuIGluIGEgZGlzcG9zYWJsZSBjb250YWluZXIgbWF0Y2hpbmcgaXRzIGFyY2hpdGVjdHVyZVwiKTtcbmNvbnN0IGRpcmVjdG9yeSA9IHJlc3RvcmVkUHJvZmlsZURpcmVjdG9yeTtcbmNvbnN0IHByb2ZpbGVzID0gYXdhaXQgcmVhZE1hbmFnZWRQcm9maWxlQXJjaGl2ZShmaWxlLCBleHBlY3RlZCk7XG5pZiAocHJvZmlsZXMucHJvZmlsZXMuc29tZSgoeyBwcm9maWxlIH0pID0+IGV4aXN0c1N5bmMocHJvZmlsZSkpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJUaGUgYm9vdHN0cmFwIGltYWdlIGFscmVhZHkgY29udGFpbnMgYSBzZWxlY3RlZCBhcmNoaXZlIHByb2ZpbGVcIik7XG5ta2RpclN5bmMoZGlyZWN0b3J5LCB7IG1vZGU6IDBvNzU1IH0pO1xuY29uc3QgZW52ID0geyAuLi5wcm9jZXNzLmVudiwgLi4uKGJ1aWxkZXIgPT09IFwibml4XCIgPyB7IE5JWF9SRU1PVEU6IFwiZGFlbW9uXCIgfSA6IHt9KSB9O1xuY29uc3QgaG9tZSA9IFwiL3RtcC93b3JrYmVuY2gtaG9tZVwiO1xuY29uc3QgdXNlciA9IHByb2Nlc3MuYXJndls0XSA/PyBcIjEwMDA6MTAwMFwiO1xuaWYgKCEvXlsxLTldXFxkezAsOX06XFxkezEsMTB9JC8udGVzdCh1c2VyKSkgdGhyb3cgbmV3IEVycm9yKFwiQXJjaGl2ZSBleGVjdXRpb24gcmVxdWlyZXMgYSBub24tcm9vdCB1c2VyIGFuZCBncm91cFwiKTtcbmNvbnN0IFt1aWQsIGdpZF0gPSB1c2VyLnNwbGl0KFwiOlwiKS5tYXAoTnVtYmVyKTtcbmlmICh1aWQgPT09IHVuZGVmaW5lZCB8fCBnaWQgPT09IHVuZGVmaW5lZCB8fCB1aWQgPj0gMHhmZmZmX2ZmZmYgfHwgZ2lkID49IDB4ZmZmZl9mZmZmKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG51bWVyaWMgdXNlciBmb3IgYXJjaGl2ZSBleGVjdXRpb25cIik7XG5ta2RpclN5bmMoaG9tZSwgeyBtb2RlOiAwbzcwMCB9KTtcbmNob3duU3luYyhob21lLCB1aWQsIGdpZCk7XG5cbmF3YWl0IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzKGFzeW5jIChzY29wZSkgPT4ge1xuICBjb25zdCBjb21tYW5kID0gYnVpbGRlciA9PT0gXCJuaXhcIiA/IFwibml4XCIgOiBcImd1aXhcIjtcbiAgY29uc3QgYXJncyA9XG4gICAgYnVpbGRlciA9PT0gXCJuaXhcIiA/IFtcIi0tZXh0cmEtZXhwZXJpbWVudGFsLWZlYXR1cmVzXCIsIFwibml4LWNvbW1hbmRcIiwgXCJzdG9yZVwiLCBcInBpbmdcIl0gOiBbXCJnY1wiLCBcIi0tbGlzdC1yb290c1wiXTtcbiAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IDsgYXR0ZW1wdCsrKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHNjb3BlLnJ1bihjb21tYW5kLCBhcmdzLCB7IGNhcHR1cmU6IHRydWUsIGVudiB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH0gY2F0Y2ggKGNhdXNlKSB7XG4gICAgICBpZiAoYXR0ZW1wdCA+PSA1OSkgdGhyb3cgbmV3IEVycm9yKGBUaGUgYm9vdHN0cmFwICR7YnVpbGRlcn0gZGFlbW9uIGRpZCBub3QgYmVjb21lIHJlYWR5YCwgeyBjYXVzZSB9KTtcbiAgICAgIGF3YWl0IGRlbGF5KDI1MCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHJlc3RvcmVkID0gYXdhaXQgaW1wb3J0TWFuYWdlZFByb2ZpbGVzKGZpbGUsIGV4cGVjdGVkLCB7XG4gICAgZW52LFxuICAgIGd1aXhWZXJpZmllcjogam9pbihpbXBvcnQubWV0YS5kaXJuYW1lLCBcInZlcmlmeS1ndWl4LXByb2ZpbGUtYXJjaGl2ZS5zY21cIiksXG4gIH0pO1xuICBpZiAoYnVpbGRlciA9PT0gXCJndWl4XCIpIG1rZGlyU3luYyhqb2luKGRpcmVjdG9yeSwgXCJydW50aW1lc1wiKSk7XG4gIGNvbnN0IHJlZ2lzdGVyZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgW2luZGV4LCBlbnRyeV0gb2YgcmVzdG9yZWQuZW50cmllcygpKSB7XG4gICAgY29uc3QgbmFtZSA9IFN0cmluZyhpbmRleCk7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oZGlyZWN0b3J5LCBuYW1lKTtcbiAgICBpZiAoYnVpbGRlciA9PT0gXCJuaXhcIikge1xuICAgICAgYXdhaXQgc2NvcGUucnVuKFxuICAgICAgICBcIm5peC1zdG9yZVwiLFxuICAgICAgICBbXCItLW9wdGlvblwiLCBcInN1YnN0aXR1dGVcIiwgXCJmYWxzZVwiLCBcIi0tbWF4LWpvYnNcIiwgXCIwXCIsIFwiLS1hZGQtcm9vdFwiLCBwYXRoLCBcIi0tcmVhbGlzZVwiLCBlbnRyeS5wcm9maWxlXSxcbiAgICAgICAgeyBlbnYgfSxcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHJ1bnRpbWUgPSBqb2luKGRpcmVjdG9yeSwgXCJydW50aW1lc1wiLCBuYW1lKTtcbiAgICAgIGNvbnN0IG1hbmFnZXIgPSBqb2luKGRpcmVjdG9yeSwgYG1hbmFnZXItJHtuYW1lfWApO1xuICAgICAgc3ltbGlua1N5bmMoZW50cnkucHJvZmlsZSwgcGF0aCk7XG4gICAgICBzeW1saW5rU3luYyhyZXF1aXJlZChlbnRyeS5ydW50aW1lLCBcIk1pc3NpbmcgR3VpeCBydW50aW1lXCIpLCBydW50aW1lKTtcbiAgICAgIHN5bWxpbmtTeW5jKHJlcXVpcmVkKGVudHJ5Lm1hbmFnZXIsIFwiTWlzc2luZyBHdWl4IG1hbmFnZXJcIiksIG1hbmFnZXIpO1xuICAgICAgcmVnaXN0ZXJlZC5wdXNoKHBhdGgsIHJ1bnRpbWUsIG1hbmFnZXIpO1xuICAgIH1cbiAgfVxuICBpZiAocmVnaXN0ZXJlZC5sZW5ndGgpIHtcbiAgICBhd2FpdCBzY29wZS5ydW4oXG4gICAgICBcImd1aXhcIixcbiAgICAgIFtcInJlcGxcIiwgam9pbihpbXBvcnQubWV0YS5kaXJuYW1lLCBcImNpLWd1aXgtYm9vdHN0cmFwLnNjbVwiKSwgXCJyZWdpc3Rlci1yb290c1wiLCAuLi5yZWdpc3RlcmVkXSxcbiAgICAgIHsgZW52IH0sXG4gICAgKTtcbiAgICBjb25zdCBsaXN0ZWQgPSAoYXdhaXQgc2NvcGUucnVuKFwiZ3VpeFwiLCBbXCJnY1wiLCBcIi0tbGlzdC1yb290c1wiXSwgeyBjYXB0dXJlOiB0cnVlLCBlbnYgfSkpLnNwbGl0KC9cXHI/XFxuLyk7XG4gICAgaWYgKHJlZ2lzdGVyZWQuc29tZSgocm9vdCkgPT4gIWxpc3RlZC5pbmNsdWRlcyhyb290KSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJHdWl4IGRpZCBub3QgcmV0YWluIGV2ZXJ5IHJlc3RvcmVkIHByb2ZpbGUgcm9vdFwiKTtcbiAgfVxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBcInJvb3RzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHJvb3RzKSwgeyBmbGFnOiBcInd4XCIsIG1vZGU6IDBvNjQ0IH0pO1xufSk7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFdBQVcs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
