import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";

const root = import.meta.dirname;
const accounts = JSON.parse(readFileSync(join(root, "accounts.json"), "utf8"));
const account = userInfo();
const own = accounts.find(({ name }) => name === account.username);
assert.ok(own, "worker has the wrong Windows account");
const directory = join(root, own.sid);
try {
  assert.equal(resolve(process.cwd()), resolve(account.homedir));
  assert.equal(resolve(process.env.USERPROFILE), resolve(account.homedir));
  assert.equal(process.env.WORKBENCH_SERVICE_FIXTURE, undefined);
  for (const item of accounts) {
    const marker = join(root, item.sid, "marker");
    if (item === own) assert.equal(readFileSync(marker, "utf8"), own.name);
    else
      assert.throws(
        () => readFileSync(marker),
        (error) => ["EACCES", "EPERM"].includes(error.code),
      );
  }

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  assert.ok(child.pid, "worker could not start its child");
  const pending = join(directory, "ready.json.pending");
  writeFileSync(pending, JSON.stringify({ pid: process.pid, child: child.pid }), {
    flag: "wx",
  });
  renameSync(pending, join(directory, "ready.json"));
  setInterval(() => {}, 1000);
} catch (error) {
  writeFileSync(join(directory, "failure.txt"), String(error).slice(0, 2048), { flag: "wx" });
  throw error;
}
