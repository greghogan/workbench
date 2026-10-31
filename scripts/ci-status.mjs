// Generated from ci-status.mts; edit the TypeScript source.
import { record, string } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { matrixJobGroups, readHostedPlan } from "./ci-plan-contract.mjs";
function aggregateCI(needs, matrix) {
  const expected = matrixJobGroups(matrix);
  const failures = [];
  for (const name of /* @__PURE__ */ new Set(["plan", "validation", ...Object.keys(expected), ...Object.keys(needs)])) {
    const result = needs[name]?.result;
    const wanted = !Object.hasOwn(expected, name) || expected[name];
    if (wanted ? result !== "success" : result !== "skipped")
      failures.push(`${name}: ${result ?? "missing"} (expected ${wanted ? "success" : "skipped"})`);
  }
  return failures;
}
function statusCI(environment = process.env) {
  let failures;
  try {
    const raw = record(JSON.parse(environment.WORKBENCH_CI_NEEDS ?? "null"), "expected job results");
    const needs = Object.fromEntries(
      Object.entries(raw).map(([name, value]) => {
        const entry = record(value, "Invalid job result"), outputs = entry.outputs === void 0 ? void 0 : record(entry.outputs, "Invalid job outputs");
        return [
          name,
          {
            ...entry.result === void 0 ? {} : { result: string(entry.result, "Invalid job status") },
            ...outputs?.matrix === void 0 ? {} : { outputs: { matrix: string(outputs.matrix, "Invalid matrix output") } }
          }
        ];
      })
    );
    const encoded = needs.plan?.outputs?.matrix;
    failures = encoded ? aggregateCI(needs, readHostedPlan(JSON.parse(encoded))) : ["plan: no matrix produced"];
  } catch (error) {
    failures = [`CI status input: ${errorMessage(error)}`];
  }
  for (const failure of failures) console.error(failure);
  if (!failures.length) console.log("Every configured check and validation passed.");
  return failures;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = statusCI().length ? 1 : 0;
export {
  aggregateCI,
  statusCI
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXN0YXR1cy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVjb3JkLCBzdHJpbmcgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBlcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi9jaS1yZXN1bHRzLm1qc1wiO1xuaW50ZXJmYWNlIEpvYlJlc3VsdCB7XG4gIHJlc3VsdD86IHN0cmluZztcbiAgb3V0cHV0cz86IHsgbWF0cml4Pzogc3RyaW5nIH07XG59XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgbWF0cml4Sm9iR3JvdXBzLCByZWFkSG9zdGVkUGxhbiB9IGZyb20gXCIuL2NpLXBsYW4tY29udHJhY3QubWpzXCI7XG5cbi8qKiBBIHNraXBwZWQgam9iIGlzIHN1Y2Nlc3NmdWwgb25seSB3aGVuIHRoZSBwbGFubmVyIGludGVudGlvbmFsbHkgcHJvZHVjZWQgbm8gd29yayBmb3IgaXQuICovXG5leHBvcnQgZnVuY3Rpb24gYWdncmVnYXRlQ0kobmVlZHM6IFJlY29yZDxzdHJpbmcsIEpvYlJlc3VsdD4sIG1hdHJpeDogdW5rbm93bikge1xuICBjb25zdCBleHBlY3RlZDogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gPSBtYXRyaXhKb2JHcm91cHMobWF0cml4KTtcbiAgY29uc3QgZmFpbHVyZXMgPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5ldyBTZXQoW1wicGxhblwiLCBcInZhbGlkYXRpb25cIiwgLi4uT2JqZWN0LmtleXMoZXhwZWN0ZWQpLCAuLi5PYmplY3Qua2V5cyhuZWVkcyldKSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IG5lZWRzW25hbWVdPy5yZXN1bHQ7XG4gICAgY29uc3Qgd2FudGVkID0gIU9iamVjdC5oYXNPd24oZXhwZWN0ZWQsIG5hbWUpIHx8IGV4cGVjdGVkW25hbWVdO1xuICAgIGlmICh3YW50ZWQgPyByZXN1bHQgIT09IFwic3VjY2Vzc1wiIDogcmVzdWx0ICE9PSBcInNraXBwZWRcIilcbiAgICAgIGZhaWx1cmVzLnB1c2goYCR7bmFtZX06ICR7cmVzdWx0ID8/IFwibWlzc2luZ1wifSAoZXhwZWN0ZWQgJHt3YW50ZWQgPyBcInN1Y2Nlc3NcIiA6IFwic2tpcHBlZFwifSlgKTtcbiAgfVxuICByZXR1cm4gZmFpbHVyZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGF0dXNDSShlbnZpcm9ubWVudCA9IHByb2Nlc3MuZW52KSB7XG4gIGxldCBmYWlsdXJlcztcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWNvcmQoSlNPTi5wYXJzZShlbnZpcm9ubWVudC5XT1JLQkVOQ0hfQ0lfTkVFRFMgPz8gXCJudWxsXCIpLCBcImV4cGVjdGVkIGpvYiByZXN1bHRzXCIpO1xuICAgIGNvbnN0IG5lZWRzOiBSZWNvcmQ8c3RyaW5nLCBKb2JSZXN1bHQ+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMocmF3KS5tYXAoKFtuYW1lLCB2YWx1ZV0pID0+IHtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBqb2IgcmVzdWx0XCIpLFxuICAgICAgICAgIG91dHB1dHMgPSBlbnRyeS5vdXRwdXRzID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiByZWNvcmQoZW50cnkub3V0cHV0cywgXCJJbnZhbGlkIGpvYiBvdXRwdXRzXCIpO1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAge1xuICAgICAgICAgICAgLi4uKGVudHJ5LnJlc3VsdCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHJlc3VsdDogc3RyaW5nKGVudHJ5LnJlc3VsdCwgXCJJbnZhbGlkIGpvYiBzdGF0dXNcIikgfSksXG4gICAgICAgICAgICAuLi4ob3V0cHV0cz8ubWF0cml4ID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICA6IHsgb3V0cHV0czogeyBtYXRyaXg6IHN0cmluZyhvdXRwdXRzLm1hdHJpeCwgXCJJbnZhbGlkIG1hdHJpeCBvdXRwdXRcIikgfSB9KSxcbiAgICAgICAgICB9LFxuICAgICAgICBdO1xuICAgICAgfSksXG4gICAgKTtcbiAgICBjb25zdCBlbmNvZGVkID0gbmVlZHMucGxhbj8ub3V0cHV0cz8ubWF0cml4O1xuICAgIGZhaWx1cmVzID0gZW5jb2RlZCA/IGFnZ3JlZ2F0ZUNJKG5lZWRzLCByZWFkSG9zdGVkUGxhbihKU09OLnBhcnNlKGVuY29kZWQpKSkgOiBbXCJwbGFuOiBubyBtYXRyaXggcHJvZHVjZWRcIl07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZXMgPSBbYENJIHN0YXR1cyBpbnB1dDogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWBdO1xuICB9XG4gIGZvciAoY29uc3QgZmFpbHVyZSBvZiBmYWlsdXJlcykgY29uc29sZS5lcnJvcihmYWlsdXJlKTtcbiAgaWYgKCFmYWlsdXJlcy5sZW5ndGgpIGNvbnNvbGUubG9nKFwiRXZlcnkgY29uZmlndXJlZCBjaGVjayBhbmQgdmFsaWRhdGlvbiBwYXNzZWQuXCIpO1xuICByZXR1cm4gZmFpbHVyZXM7XG59XG5cbmlmIChwcm9jZXNzLmFyZ3ZbMV0gJiYgaW1wb3J0Lm1ldGEudXJsID09PSBwYXRoVG9GaWxlVVJMKHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZilcbiAgcHJvY2Vzcy5leGl0Q29kZSA9IHN0YXR1c0NJKCkubGVuZ3RoID8gMSA6IDA7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsY0FBYztBQUMvQixTQUFTLG9CQUFvQjtBQUs3QixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGVBQWU7QUFDeEIsU0FBUyxpQkFBaUIsc0JBQXNCO0FBR3pDLFNBQVMsWUFBWSxPQUFrQyxRQUFpQjtBQUM3RSxRQUFNLFdBQW9DLGdCQUFnQixNQUFNO0FBQ2hFLFFBQU0sV0FBVyxDQUFDO0FBQ2xCLGFBQVcsUUFBUSxvQkFBSSxJQUFJLENBQUMsUUFBUSxjQUFjLEdBQUcsT0FBTyxLQUFLLFFBQVEsR0FBRyxHQUFHLE9BQU8sS0FBSyxLQUFLLENBQUMsQ0FBQyxHQUFHO0FBQ25HLFVBQU0sU0FBUyxNQUFNLElBQUksR0FBRztBQUM1QixVQUFNLFNBQVMsQ0FBQyxPQUFPLE9BQU8sVUFBVSxJQUFJLEtBQUssU0FBUyxJQUFJO0FBQzlELFFBQUksU0FBUyxXQUFXLFlBQVksV0FBVztBQUM3QyxlQUFTLEtBQUssR0FBRyxJQUFJLEtBQUssVUFBVSxTQUFTLGNBQWMsU0FBUyxZQUFZLFNBQVMsR0FBRztBQUFBLEVBQ2hHO0FBQ0EsU0FBTztBQUNUO0FBRU8sU0FBUyxTQUFTLGNBQWMsUUFBUSxLQUFLO0FBQ2xELE1BQUk7QUFDSixNQUFJO0FBQ0YsVUFBTSxNQUFNLE9BQU8sS0FBSyxNQUFNLFlBQVksc0JBQXNCLE1BQU0sR0FBRyxzQkFBc0I7QUFDL0YsVUFBTSxRQUFtQyxPQUFPO0FBQUEsTUFDOUMsT0FBTyxRQUFRLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQyxNQUFNLEtBQUssTUFBTTtBQUN6QyxjQUFNLFFBQVEsT0FBTyxPQUFPLG9CQUFvQixHQUM5QyxVQUFVLE1BQU0sWUFBWSxTQUFZLFNBQVksT0FBTyxNQUFNLFNBQVMscUJBQXFCO0FBQ2pHLGVBQU87QUFBQSxVQUNMO0FBQUEsVUFDQTtBQUFBLFlBQ0UsR0FBSSxNQUFNLFdBQVcsU0FBWSxDQUFDLElBQUksRUFBRSxRQUFRLE9BQU8sTUFBTSxRQUFRLG9CQUFvQixFQUFFO0FBQUEsWUFDM0YsR0FBSSxTQUFTLFdBQVcsU0FDcEIsQ0FBQyxJQUNELEVBQUUsU0FBUyxFQUFFLFFBQVEsT0FBTyxRQUFRLFFBQVEsdUJBQXVCLEVBQUUsRUFBRTtBQUFBLFVBQzdFO0FBQUEsUUFDRjtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0g7QUFDQSxVQUFNLFVBQVUsTUFBTSxNQUFNLFNBQVM7QUFDckMsZUFBVyxVQUFVLFlBQVksT0FBTyxlQUFlLEtBQUssTUFBTSxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsMEJBQTBCO0FBQUEsRUFDNUcsU0FBUyxPQUFPO0FBQ2QsZUFBVyxDQUFDLG9CQUFvQixhQUFhLEtBQUssQ0FBQyxFQUFFO0FBQUEsRUFDdkQ7QUFDQSxhQUFXLFdBQVcsU0FBVSxTQUFRLE1BQU0sT0FBTztBQUNyRCxNQUFJLENBQUMsU0FBUyxPQUFRLFNBQVEsSUFBSSwrQ0FBK0M7QUFDakYsU0FBTztBQUNUO0FBRUEsSUFBSSxRQUFRLEtBQUssQ0FBQyxLQUFLLFlBQVksUUFBUSxjQUFjLFFBQVEsUUFBUSxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDakYsVUFBUSxXQUFXLFNBQVMsRUFBRSxTQUFTLElBQUk7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9jaS1zdGF0dXMubWpzIn0=
