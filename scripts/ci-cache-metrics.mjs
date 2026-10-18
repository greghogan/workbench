// Generated from ci-cache-metrics.mts; edit the TypeScript source.
import { required, record, string, stringRecord } from "./values.mjs";
import { appendFileSync, existsSync, globSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
const directory = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required"), "workbench-ci");
const path = join(directory, "cache-measurement.json");
if (process.argv[2] === "start") {
  writeFileSync(path, JSON.stringify({ started: (/* @__PURE__ */ new Date()).toISOString() }));
} else if (process.argv[2] === "finish") {
  const start = {
    started: string(
      record(JSON.parse(readFileSync(path, "utf8")), "Invalid measurement").started,
      "Missing start time"
    )
  };
  const plan = stringRecord(JSON.parse(readFileSync(join(directory, "cache-plan.json"), "utf8")), "Invalid cache plan");
  const bytes = (path2) => {
    const info = lstatSync(path2);
    return info.isSymbolicLink() ? 0 : info.isDirectory() ? readdirSync(path2).reduce((sum, name) => sum + bytes(join(path2, name)), 0) : info.size;
  };
  const groups = Object.entries(plan).filter(([key]) => /-(paths|path)$/.test(key)).map(([name, text]) => {
    const paths = [
      ...new Set(
        text.split("\n").filter(Boolean).flatMap((path2) => path2.includes("*") ? globSync(path2) : existsSync(path2) ? [path2] : [])
      )
    ].map((path2) => resolve(path2));
    const roots = paths.filter((path2) => !paths.some((other) => other !== path2 && path2.startsWith(other + sep)));
    return { name, bytes: roots.reduce((sum, path2) => sum + bytes(path2), 0) };
  });
  const result = {
    ...start,
    finished: (/* @__PURE__ */ new Date()).toISOString(),
    elapsed_seconds: (Date.now() - Date.parse(start.started)) / 1e3,
    groups
  };
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "\n## Cache footprint",
        "",
        "Elapsed time includes restore, setup, and checks; sizes are retained uncompressed file bytes.",
        "",
        "| Cache | Bytes |",
        "| --- | ---: |",
        ...groups.map((group) => `| ${group.name} | ${String(group.bytes)} |`),
        ""
      ].join("\n")
    );
} else throw new Error("select start or finish");
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLWNhY2hlLW1ldHJpY3MubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVpcmVkLCByZWNvcmQsIHN0cmluZywgc3RyaW5nUmVjb3JkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5pbXBvcnQgeyBhcHBlbmRGaWxlU3luYywgZXhpc3RzU3luYywgZ2xvYlN5bmMsIGxzdGF0U3luYywgcmVhZEZpbGVTeW5jLCByZWFkZGlyU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8vIE1lYXN1cmVtZW50cyBhcmUgZXZpZGVuY2UsIG5ldmVyIGEgcmVhc29uIHRvIHNraXAgdmVyaWZpY2F0aW9uIG9yIHJldGFpbiBhZGRpdGlvbmFsIGNhY2hlcy5cbmNvbnN0IGRpcmVjdG9yeSA9IGpvaW4ocmVxdWlyZWQocHJvY2Vzcy5lbnYuUlVOTkVSX1RFTVAsIFwiUlVOTkVSX1RFTVAgaXMgcmVxdWlyZWRcIiksIFwid29ya2JlbmNoLWNpXCIpO1xuY29uc3QgcGF0aCA9IGpvaW4oZGlyZWN0b3J5LCBcImNhY2hlLW1lYXN1cmVtZW50Lmpzb25cIik7XG5pZiAocHJvY2Vzcy5hcmd2WzJdID09PSBcInN0YXJ0XCIpIHtcbiAgd3JpdGVGaWxlU3luYyhwYXRoLCBKU09OLnN0cmluZ2lmeSh7IHN0YXJ0ZWQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9KSk7XG59IGVsc2UgaWYgKHByb2Nlc3MuYXJndlsyXSA9PT0gXCJmaW5pc2hcIikge1xuICBjb25zdCBzdGFydCA9IHtcbiAgICBzdGFydGVkOiBzdHJpbmcoXG4gICAgICByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIG1lYXN1cmVtZW50XCIpLnN0YXJ0ZWQsXG4gICAgICBcIk1pc3Npbmcgc3RhcnQgdGltZVwiLFxuICAgICksXG4gIH07XG4gIGNvbnN0IHBsYW4gPSBzdHJpbmdSZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJlY3RvcnksIFwiY2FjaGUtcGxhbi5qc29uXCIpLCBcInV0ZjhcIikpLCBcIkludmFsaWQgY2FjaGUgcGxhblwiKTtcbiAgY29uc3QgYnl0ZXMgPSAocGF0aDogc3RyaW5nKTogbnVtYmVyID0+IHtcbiAgICBjb25zdCBpbmZvID0gbHN0YXRTeW5jKHBhdGgpO1xuICAgIHJldHVybiBpbmZvLmlzU3ltYm9saWNMaW5rKClcbiAgICAgID8gMFxuICAgICAgOiBpbmZvLmlzRGlyZWN0b3J5KClcbiAgICAgICAgPyByZWFkZGlyU3luYyhwYXRoKS5yZWR1Y2UoKHN1bSwgbmFtZSkgPT4gc3VtICsgYnl0ZXMoam9pbihwYXRoLCBuYW1lKSksIDApXG4gICAgICAgIDogaW5mby5zaXplO1xuICB9O1xuICBjb25zdCBncm91cHMgPSBPYmplY3QuZW50cmllcyhwbGFuKVxuICAgIC5maWx0ZXIoKFtrZXldKSA9PiAvLShwYXRoc3xwYXRoKSQvLnRlc3Qoa2V5KSlcbiAgICAubWFwKChbbmFtZSwgdGV4dF0pID0+IHtcbiAgICAgIGNvbnN0IHBhdGhzID0gW1xuICAgICAgICAuLi5uZXcgU2V0KFxuICAgICAgICAgIHRleHRcbiAgICAgICAgICAgIC5zcGxpdChcIlxcblwiKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICAgICAgLmZsYXRNYXAoKHBhdGg6IHN0cmluZykgPT4gKHBhdGguaW5jbHVkZXMoXCIqXCIpID8gZ2xvYlN5bmMocGF0aCkgOiBleGlzdHNTeW5jKHBhdGgpID8gW3BhdGhdIDogW10pKSxcbiAgICAgICAgKSxcbiAgICAgIF0ubWFwKChwYXRoKSA9PiByZXNvbHZlKHBhdGgpKTtcbiAgICAgIGNvbnN0IHJvb3RzID0gcGF0aHMuZmlsdGVyKChwYXRoKSA9PiAhcGF0aHMuc29tZSgob3RoZXIpID0+IG90aGVyICE9PSBwYXRoICYmIHBhdGguc3RhcnRzV2l0aChvdGhlciArIHNlcCkpKTtcbiAgICAgIHJldHVybiB7IG5hbWUsIGJ5dGVzOiByb290cy5yZWR1Y2UoKHN1bSwgcGF0aCkgPT4gc3VtICsgYnl0ZXMocGF0aCksIDApIH07XG4gICAgfSk7XG4gIGNvbnN0IHJlc3VsdCA9IHtcbiAgICAuLi5zdGFydCxcbiAgICBmaW5pc2hlZDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGVsYXBzZWRfc2Vjb25kczogKERhdGUubm93KCkgLSBEYXRlLnBhcnNlKHN0YXJ0LnN0YXJ0ZWQpKSAvIDEwMDAsXG4gICAgZ3JvdXBzLFxuICB9O1xuICB3cml0ZUZpbGVTeW5jKHBhdGgsIEpTT04uc3RyaW5naWZ5KHJlc3VsdCwgbnVsbCwgMikgKyBcIlxcblwiKTtcbiAgaWYgKHByb2Nlc3MuZW52LkdJVEhVQl9TVEVQX1NVTU1BUlkpXG4gICAgYXBwZW5kRmlsZVN5bmMoXG4gICAgICBwcm9jZXNzLmVudi5HSVRIVUJfU1RFUF9TVU1NQVJZLFxuICAgICAgW1xuICAgICAgICBcIlxcbiMjIENhY2hlIGZvb3RwcmludFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIkVsYXBzZWQgdGltZSBpbmNsdWRlcyByZXN0b3JlLCBzZXR1cCwgYW5kIGNoZWNrczsgc2l6ZXMgYXJlIHJldGFpbmVkIHVuY29tcHJlc3NlZCBmaWxlIGJ5dGVzLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcInwgQ2FjaGUgfCBCeXRlcyB8XCIsXG4gICAgICAgIFwifCAtLS0gfCAtLS06IHxcIixcbiAgICAgICAgLi4uZ3JvdXBzLm1hcCgoZ3JvdXApID0+IGB8ICR7Z3JvdXAubmFtZX0gfCAke1N0cmluZyhncm91cC5ieXRlcyl9IHxgKSxcbiAgICAgICAgXCJcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICApO1xufSBlbHNlIHRocm93IG5ldyBFcnJvcihcInNlbGVjdCBzdGFydCBvciBmaW5pc2hcIik7XG4iXSwibWFwcGluZ3MiOiI7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
