// Generated from ci-status.mts; edit the TypeScript source.
import { record, string } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { matrixJobGroups, readHostedPlan } from "./ci-plan-contract.mjs";
function aggregateCI(needs, matrix) {
  const expected = matrixJobGroups(matrix);
  const failures = [];
  for (const name of ["plan", "validation", ...Object.keys(expected)]) {
    const result = needs[name]?.result;
    const wanted = name === "plan" || name === "validation" || expected[name];
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXN0YXR1cy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVjb3JkLCBzdHJpbmcgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBlcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi9jaS1yZXN1bHRzLm1qc1wiO1xuaW50ZXJmYWNlIEpvYlJlc3VsdCB7XG4gIHJlc3VsdD86IHN0cmluZztcbiAgb3V0cHV0cz86IHsgbWF0cml4Pzogc3RyaW5nIH07XG59XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgbWF0cml4Sm9iR3JvdXBzLCByZWFkSG9zdGVkUGxhbiB9IGZyb20gXCIuL2NpLXBsYW4tY29udHJhY3QubWpzXCI7XG5cbi8qKiBBIHNraXBwZWQgam9iIGlzIHN1Y2Nlc3NmdWwgb25seSB3aGVuIHRoZSBwbGFubmVyIGludGVudGlvbmFsbHkgcHJvZHVjZWQgbm8gd29yayBmb3IgaXQuICovXG5leHBvcnQgZnVuY3Rpb24gYWdncmVnYXRlQ0kobmVlZHM6IFJlY29yZDxzdHJpbmcsIEpvYlJlc3VsdD4sIG1hdHJpeDogdW5rbm93bikge1xuICBjb25zdCBleHBlY3RlZDogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gPSBtYXRyaXhKb2JHcm91cHMobWF0cml4KTtcbiAgY29uc3QgZmFpbHVyZXMgPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIFtcInBsYW5cIiwgXCJ2YWxpZGF0aW9uXCIsIC4uLk9iamVjdC5rZXlzKGV4cGVjdGVkKV0pIHtcbiAgICBjb25zdCByZXN1bHQgPSBuZWVkc1tuYW1lXT8ucmVzdWx0O1xuICAgIGNvbnN0IHdhbnRlZCA9IG5hbWUgPT09IFwicGxhblwiIHx8IG5hbWUgPT09IFwidmFsaWRhdGlvblwiIHx8IGV4cGVjdGVkW25hbWVdO1xuICAgIGlmICh3YW50ZWQgPyByZXN1bHQgIT09IFwic3VjY2Vzc1wiIDogcmVzdWx0ICE9PSBcInNraXBwZWRcIilcbiAgICAgIGZhaWx1cmVzLnB1c2goYCR7bmFtZX06ICR7cmVzdWx0ID8/IFwibWlzc2luZ1wifSAoZXhwZWN0ZWQgJHt3YW50ZWQgPyBcInN1Y2Nlc3NcIiA6IFwic2tpcHBlZFwifSlgKTtcbiAgfVxuICByZXR1cm4gZmFpbHVyZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGF0dXNDSShlbnZpcm9ubWVudCA9IHByb2Nlc3MuZW52KSB7XG4gIGxldCBmYWlsdXJlcztcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWNvcmQoSlNPTi5wYXJzZShlbnZpcm9ubWVudC5XT1JLQkVOQ0hfQ0lfTkVFRFMgPz8gXCJudWxsXCIpLCBcImV4cGVjdGVkIGpvYiByZXN1bHRzXCIpO1xuICAgIGNvbnN0IG5lZWRzOiBSZWNvcmQ8c3RyaW5nLCBKb2JSZXN1bHQ+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMocmF3KS5tYXAoKFtuYW1lLCB2YWx1ZV0pID0+IHtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZWNvcmQodmFsdWUsIFwiSW52YWxpZCBqb2IgcmVzdWx0XCIpLFxuICAgICAgICAgIG91dHB1dHMgPSBlbnRyeS5vdXRwdXRzID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiByZWNvcmQoZW50cnkub3V0cHV0cywgXCJJbnZhbGlkIGpvYiBvdXRwdXRzXCIpO1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAge1xuICAgICAgICAgICAgLi4uKGVudHJ5LnJlc3VsdCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHJlc3VsdDogc3RyaW5nKGVudHJ5LnJlc3VsdCwgXCJJbnZhbGlkIGpvYiBzdGF0dXNcIikgfSksXG4gICAgICAgICAgICAuLi4ob3V0cHV0cz8ubWF0cml4ID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICA6IHsgb3V0cHV0czogeyBtYXRyaXg6IHN0cmluZyhvdXRwdXRzLm1hdHJpeCwgXCJJbnZhbGlkIG1hdHJpeCBvdXRwdXRcIikgfSB9KSxcbiAgICAgICAgICB9LFxuICAgICAgICBdO1xuICAgICAgfSksXG4gICAgKTtcbiAgICBjb25zdCBlbmNvZGVkID0gbmVlZHMucGxhbj8ub3V0cHV0cz8ubWF0cml4O1xuICAgIGZhaWx1cmVzID0gZW5jb2RlZCA/IGFnZ3JlZ2F0ZUNJKG5lZWRzLCByZWFkSG9zdGVkUGxhbihKU09OLnBhcnNlKGVuY29kZWQpKSkgOiBbXCJwbGFuOiBubyBtYXRyaXggcHJvZHVjZWRcIl07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbHVyZXMgPSBbYENJIHN0YXR1cyBpbnB1dDogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWBdO1xuICB9XG4gIGZvciAoY29uc3QgZmFpbHVyZSBvZiBmYWlsdXJlcykgY29uc29sZS5lcnJvcihmYWlsdXJlKTtcbiAgaWYgKCFmYWlsdXJlcy5sZW5ndGgpIGNvbnNvbGUubG9nKFwiRXZlcnkgY29uZmlndXJlZCBjaGVjayBhbmQgdmFsaWRhdGlvbiBwYXNzZWQuXCIpO1xuICByZXR1cm4gZmFpbHVyZXM7XG59XG5cbmlmIChwcm9jZXNzLmFyZ3ZbMV0gJiYgaW1wb3J0Lm1ldGEudXJsID09PSBwYXRoVG9GaWxlVVJMKHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZilcbiAgcHJvY2Vzcy5leGl0Q29kZSA9IHN0YXR1c0NJKCkubGVuZ3RoID8gMSA6IDA7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFFBQVEsY0FBYztBQUMvQixTQUFTLG9CQUFvQjtBQUs3QixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGVBQWU7QUFDeEIsU0FBUyxpQkFBaUIsc0JBQXNCO0FBR3pDLFNBQVMsWUFBWSxPQUFrQyxRQUFpQjtBQUM3RSxRQUFNLFdBQW9DLGdCQUFnQixNQUFNO0FBQ2hFLFFBQU0sV0FBVyxDQUFDO0FBQ2xCLGFBQVcsUUFBUSxDQUFDLFFBQVEsY0FBYyxHQUFHLE9BQU8sS0FBSyxRQUFRLENBQUMsR0FBRztBQUNuRSxVQUFNLFNBQVMsTUFBTSxJQUFJLEdBQUc7QUFDNUIsVUFBTSxTQUFTLFNBQVMsVUFBVSxTQUFTLGdCQUFnQixTQUFTLElBQUk7QUFDeEUsUUFBSSxTQUFTLFdBQVcsWUFBWSxXQUFXO0FBQzdDLGVBQVMsS0FBSyxHQUFHLElBQUksS0FBSyxVQUFVLFNBQVMsY0FBYyxTQUFTLFlBQVksU0FBUyxHQUFHO0FBQUEsRUFDaEc7QUFDQSxTQUFPO0FBQ1Q7QUFFTyxTQUFTLFNBQVMsY0FBYyxRQUFRLEtBQUs7QUFDbEQsTUFBSTtBQUNKLE1BQUk7QUFDRixVQUFNLE1BQU0sT0FBTyxLQUFLLE1BQU0sWUFBWSxzQkFBc0IsTUFBTSxHQUFHLHNCQUFzQjtBQUMvRixVQUFNLFFBQW1DLE9BQU87QUFBQSxNQUM5QyxPQUFPLFFBQVEsR0FBRyxFQUFFLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxNQUFNO0FBQ3pDLGNBQU0sUUFBUSxPQUFPLE9BQU8sb0JBQW9CLEdBQzlDLFVBQVUsTUFBTSxZQUFZLFNBQVksU0FBWSxPQUFPLE1BQU0sU0FBUyxxQkFBcUI7QUFDakcsZUFBTztBQUFBLFVBQ0w7QUFBQSxVQUNBO0FBQUEsWUFDRSxHQUFJLE1BQU0sV0FBVyxTQUFZLENBQUMsSUFBSSxFQUFFLFFBQVEsT0FBTyxNQUFNLFFBQVEsb0JBQW9CLEVBQUU7QUFBQSxZQUMzRixHQUFJLFNBQVMsV0FBVyxTQUNwQixDQUFDLElBQ0QsRUFBRSxTQUFTLEVBQUUsUUFBUSxPQUFPLFFBQVEsUUFBUSx1QkFBdUIsRUFBRSxFQUFFO0FBQUEsVUFDN0U7QUFBQSxRQUNGO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUNBLFVBQU0sVUFBVSxNQUFNLE1BQU0sU0FBUztBQUNyQyxlQUFXLFVBQVUsWUFBWSxPQUFPLGVBQWUsS0FBSyxNQUFNLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQywwQkFBMEI7QUFBQSxFQUM1RyxTQUFTLE9BQU87QUFDZCxlQUFXLENBQUMsb0JBQW9CLGFBQWEsS0FBSyxDQUFDLEVBQUU7QUFBQSxFQUN2RDtBQUNBLGFBQVcsV0FBVyxTQUFVLFNBQVEsTUFBTSxPQUFPO0FBQ3JELE1BQUksQ0FBQyxTQUFTLE9BQVEsU0FBUSxJQUFJLCtDQUErQztBQUNqRixTQUFPO0FBQ1Q7QUFFQSxJQUFJLFFBQVEsS0FBSyxDQUFDLEtBQUssWUFBWSxRQUFRLGNBQWMsUUFBUSxRQUFRLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNqRixVQUFRLFdBQVcsU0FBUyxFQUFFLFNBQVMsSUFBSTsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL2NpLXN0YXR1cy5tanMifQ==
