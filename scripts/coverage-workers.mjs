// Generated from coverage-workers.mts; edit the TypeScript source.
import { Worker } from "node:worker_threads";
import { InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import { positiveInteger } from "./cpu-budget.mjs";
async function coverageJobs(jobs, limit) {
  positiveInteger(limit, "coverage workers");
  const workers = [];
  const results = new Array(jobs.length);
  let next = 0;
  const execute = (worker, job) => new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", message);
      worker.off("error", failure);
      worker.off("exit", exited);
    };
    const message = (reply) => {
      cleanup();
      if ("error" in reply) {
        const diagnostic = reply.diagnostic;
        reject(
          diagnostic ? new InvalidNodeCoverageReport(diagnostic.file, diagnostic.bytes, diagnostic.reason) : new Error(reply.error)
        );
      } else resolve(reply.result);
    };
    const failure = (error) => {
      cleanup();
      reject(error);
    };
    const exited = (status) => {
      cleanup();
      reject(new Error(`Coverage worker exited before returning a result (${String(status)})`));
    };
    worker.once("message", message);
    worker.once("error", failure);
    worker.once("exit", exited);
    try {
      worker.postMessage(job);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Cannot dispatch coverage job", { cause: error }));
    }
  });
  try {
    for (let index = 0; index < Math.min(limit, jobs.length); index++)
      workers.push(new Worker(new URL("./coverage-worker.mjs", import.meta.url)));
    await Promise.all(
      workers.map(async (worker) => {
        while (next < jobs.length) {
          const index = next++;
          const job = jobs[index];
          if (!job) throw new Error("Missing coverage job");
          results[index] = await execute(worker, job);
        }
      })
    );
    return results;
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}
export {
  coverageJobs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNvdmVyYWdlLXdvcmtlcnMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFdvcmtlciB9IGZyb20gXCJub2RlOndvcmtlcl90aHJlYWRzXCI7XG5pbXBvcnQgeyBJbnZhbGlkTm9kZUNvdmVyYWdlUmVwb3J0IH0gZnJvbSBcIi4vbm9kZS1jb3ZlcmFnZS1yZXBvcnRzLm1qc1wiO1xuaW1wb3J0IHR5cGUgeyBNZWFzdXJlZFNjcmlwdCwgU2Nhbm5lZENvdmVyYWdlIH0gZnJvbSBcIi4vY292ZXJhZ2UtcHJvY2Vzc2luZy5tanNcIjtcbmltcG9ydCB0eXBlIHsgRmlsZUNvdmVyYWdlRGF0YSB9IGZyb20gXCJpc3RhbmJ1bC1saWItY292ZXJhZ2VcIjtcbmltcG9ydCB7IHBvc2l0aXZlSW50ZWdlciB9IGZyb20gXCIuL2NwdS1idWRnZXQubWpzXCI7XG5cbmV4cG9ydCB0eXBlIENvdmVyYWdlSm9iID1cbiAgfCB7IGtpbmQ6IFwic2NhblwiOyBkaXJlY3Rvcnk6IHN0cmluZzsgcm9vdDogc3RyaW5nOyBjYW5kaWRhdGVzOiBNZWFzdXJlZFNjcmlwdFtdOyBmaWxlczogc3RyaW5nW10gfVxuICB8IHsga2luZDogXCJjb252ZXJ0XCI7IHNjcmlwdDogTWVhc3VyZWRTY3JpcHQgfTtcbnR5cGUgUmVzdWx0PFQgZXh0ZW5kcyBDb3ZlcmFnZUpvYj4gPSBUIGV4dGVuZHMgeyBraW5kOiBcInNjYW5cIiB9ID8gU2Nhbm5lZENvdmVyYWdlIDogUmVjb3JkPHN0cmluZywgRmlsZUNvdmVyYWdlRGF0YT47XG5leHBvcnQgdHlwZSBDb3ZlcmFnZVdvcmtlclJlcGx5ID1cbiAgfCB7IHJlc3VsdDogU2Nhbm5lZENvdmVyYWdlIHwgUmVjb3JkPHN0cmluZywgRmlsZUNvdmVyYWdlRGF0YT4gfVxuICB8IHsgZXJyb3I6IHN0cmluZzsgZGlhZ25vc3RpYz86IEludmFsaWROb2RlQ292ZXJhZ2VSZXBvcnRbXCJkaWFnbm9zdGljXCJdIH07XG5cbi8qKiBBIGJvdW5kZWQgcGhhc2Ugb3ducyBpdHMgd29ya2VycyBhbmQgZHJhaW5zIHRoZW0gYmVmb3JlIHJldHVybmluZyBvciByZW1vdmluZyByYXcgaW5wdXRzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvdmVyYWdlSm9iczxUIGV4dGVuZHMgQ292ZXJhZ2VKb2I+KGpvYnM6IFRbXSwgbGltaXQ6IG51bWJlcik6IFByb21pc2U8UmVzdWx0PFQ+W10+IHtcbiAgcG9zaXRpdmVJbnRlZ2VyKGxpbWl0LCBcImNvdmVyYWdlIHdvcmtlcnNcIik7XG4gIGNvbnN0IHdvcmtlcnM6IFdvcmtlcltdID0gW107XG4gIGNvbnN0IHJlc3VsdHM6IFJlc3VsdDxUPltdID0gbmV3IEFycmF5PFJlc3VsdDxUPj4oam9icy5sZW5ndGgpO1xuICBsZXQgbmV4dCA9IDA7XG4gIGNvbnN0IGV4ZWN1dGUgPSAod29ya2VyOiBXb3JrZXIsIGpvYjogVCkgPT5cbiAgICBuZXcgUHJvbWlzZTxSZXN1bHQ8VD4+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IGNsZWFudXAgPSAoKSA9PiB7XG4gICAgICAgIHdvcmtlci5vZmYoXCJtZXNzYWdlXCIsIG1lc3NhZ2UpO1xuICAgICAgICB3b3JrZXIub2ZmKFwiZXJyb3JcIiwgZmFpbHVyZSk7XG4gICAgICAgIHdvcmtlci5vZmYoXCJleGl0XCIsIGV4aXRlZCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgbWVzc2FnZSA9IChyZXBseTogQ292ZXJhZ2VXb3JrZXJSZXBseSkgPT4ge1xuICAgICAgICBjbGVhbnVwKCk7XG4gICAgICAgIGlmIChcImVycm9yXCIgaW4gcmVwbHkpIHtcbiAgICAgICAgICBjb25zdCBkaWFnbm9zdGljID0gcmVwbHkuZGlhZ25vc3RpYztcbiAgICAgICAgICByZWplY3QoXG4gICAgICAgICAgICBkaWFnbm9zdGljXG4gICAgICAgICAgICAgID8gbmV3IEludmFsaWROb2RlQ292ZXJhZ2VSZXBvcnQoZGlhZ25vc3RpYy5maWxlLCBkaWFnbm9zdGljLmJ5dGVzLCBkaWFnbm9zdGljLnJlYXNvbilcbiAgICAgICAgICAgICAgOiBuZXcgRXJyb3IocmVwbHkuZXJyb3IpLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSByZXNvbHZlKHJlcGx5LnJlc3VsdCBhcyBSZXN1bHQ8VD4pO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IGZhaWx1cmUgPSAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgICAgIGNsZWFudXAoKTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH07XG4gICAgICBjb25zdCBleGl0ZWQgPSAoc3RhdHVzOiBudW1iZXIpID0+IHtcbiAgICAgICAgY2xlYW51cCgpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKGBDb3ZlcmFnZSB3b3JrZXIgZXhpdGVkIGJlZm9yZSByZXR1cm5pbmcgYSByZXN1bHQgKCR7U3RyaW5nKHN0YXR1cyl9KWApKTtcbiAgICAgIH07XG4gICAgICB3b3JrZXIub25jZShcIm1lc3NhZ2VcIiwgbWVzc2FnZSk7XG4gICAgICB3b3JrZXIub25jZShcImVycm9yXCIsIGZhaWx1cmUpO1xuICAgICAgd29ya2VyLm9uY2UoXCJleGl0XCIsIGV4aXRlZCk7XG4gICAgICB0cnkge1xuICAgICAgICB3b3JrZXIucG9zdE1lc3NhZ2Uoam9iKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNsZWFudXAoKTtcbiAgICAgICAgcmVqZWN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihcIkNhbm5vdCBkaXNwYXRjaCBjb3ZlcmFnZSBqb2JcIiwgeyBjYXVzZTogZXJyb3IgfSkpO1xuICAgICAgfVxuICAgIH0pO1xuICB0cnkge1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBNYXRoLm1pbihsaW1pdCwgam9icy5sZW5ndGgpOyBpbmRleCsrKVxuICAgICAgd29ya2Vycy5wdXNoKG5ldyBXb3JrZXIobmV3IFVSTChcIi4vY292ZXJhZ2Utd29ya2VyLm1qc1wiLCBpbXBvcnQubWV0YS51cmwpKSk7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICB3b3JrZXJzLm1hcChhc3luYyAod29ya2VyKSA9PiB7XG4gICAgICAgIHdoaWxlIChuZXh0IDwgam9icy5sZW5ndGgpIHtcbiAgICAgICAgICBjb25zdCBpbmRleCA9IG5leHQrKztcbiAgICAgICAgICBjb25zdCBqb2IgPSBqb2JzW2luZGV4XTtcbiAgICAgICAgICBpZiAoIWpvYikgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBjb3ZlcmFnZSBqb2JcIik7XG4gICAgICAgICAgcmVzdWx0c1tpbmRleF0gPSBhd2FpdCBleGVjdXRlKHdvcmtlciwgam9iKTtcbiAgICAgICAgfVxuICAgICAgfSksXG4gICAgKTtcbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQod29ya2Vycy5tYXAoKHdvcmtlcikgPT4gd29ya2VyLnRlcm1pbmF0ZSgpKSk7XG4gIH1cbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsY0FBYztBQUN2QixTQUFTLGlDQUFpQztBQUcxQyxTQUFTLHVCQUF1QjtBQVdoQyxlQUFzQixhQUFvQyxNQUFXLE9BQXFDO0FBQ3hHLGtCQUFnQixPQUFPLGtCQUFrQjtBQUN6QyxRQUFNLFVBQW9CLENBQUM7QUFDM0IsUUFBTSxVQUF1QixJQUFJLE1BQWlCLEtBQUssTUFBTTtBQUM3RCxNQUFJLE9BQU87QUFDWCxRQUFNLFVBQVUsQ0FBQyxRQUFnQixRQUMvQixJQUFJLFFBQW1CLENBQUMsU0FBUyxXQUFXO0FBQzFDLFVBQU0sVUFBVSxNQUFNO0FBQ3BCLGFBQU8sSUFBSSxXQUFXLE9BQU87QUFDN0IsYUFBTyxJQUFJLFNBQVMsT0FBTztBQUMzQixhQUFPLElBQUksUUFBUSxNQUFNO0FBQUEsSUFDM0I7QUFDQSxVQUFNLFVBQVUsQ0FBQyxVQUErQjtBQUM5QyxjQUFRO0FBQ1IsVUFBSSxXQUFXLE9BQU87QUFDcEIsY0FBTSxhQUFhLE1BQU07QUFDekI7QUFBQSxVQUNFLGFBQ0ksSUFBSSwwQkFBMEIsV0FBVyxNQUFNLFdBQVcsT0FBTyxXQUFXLE1BQU0sSUFDbEYsSUFBSSxNQUFNLE1BQU0sS0FBSztBQUFBLFFBQzNCO0FBQUEsTUFDRixNQUFPLFNBQVEsTUFBTSxNQUFtQjtBQUFBLElBQzFDO0FBQ0EsVUFBTSxVQUFVLENBQUMsVUFBaUI7QUFDaEMsY0FBUTtBQUNSLGFBQU8sS0FBSztBQUFBLElBQ2Q7QUFDQSxVQUFNLFNBQVMsQ0FBQyxXQUFtQjtBQUNqQyxjQUFRO0FBQ1IsYUFBTyxJQUFJLE1BQU0scURBQXFELE9BQU8sTUFBTSxDQUFDLEdBQUcsQ0FBQztBQUFBLElBQzFGO0FBQ0EsV0FBTyxLQUFLLFdBQVcsT0FBTztBQUM5QixXQUFPLEtBQUssU0FBUyxPQUFPO0FBQzVCLFdBQU8sS0FBSyxRQUFRLE1BQU07QUFDMUIsUUFBSTtBQUNGLGFBQU8sWUFBWSxHQUFHO0FBQUEsSUFDeEIsU0FBUyxPQUFPO0FBQ2QsY0FBUTtBQUNSLGFBQU8saUJBQWlCLFFBQVEsUUFBUSxJQUFJLE1BQU0sZ0NBQWdDLEVBQUUsT0FBTyxNQUFNLENBQUMsQ0FBQztBQUFBLElBQ3JHO0FBQUEsRUFDRixDQUFDO0FBQ0gsTUFBSTtBQUNGLGFBQVMsUUFBUSxHQUFHLFFBQVEsS0FBSyxJQUFJLE9BQU8sS0FBSyxNQUFNLEdBQUc7QUFDeEQsY0FBUSxLQUFLLElBQUksT0FBTyxJQUFJLElBQUkseUJBQXlCLFlBQVksR0FBRyxDQUFDLENBQUM7QUFDNUUsVUFBTSxRQUFRO0FBQUEsTUFDWixRQUFRLElBQUksT0FBTyxXQUFXO0FBQzVCLGVBQU8sT0FBTyxLQUFLLFFBQVE7QUFDekIsZ0JBQU0sUUFBUTtBQUNkLGdCQUFNLE1BQU0sS0FBSyxLQUFLO0FBQ3RCLGNBQUksQ0FBQyxJQUFLLE9BQU0sSUFBSSxNQUFNLHNCQUFzQjtBQUNoRCxrQkFBUSxLQUFLLElBQUksTUFBTSxRQUFRLFFBQVEsR0FBRztBQUFBLFFBQzVDO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUNBLFdBQU87QUFBQSxFQUNULFVBQUU7QUFDQSxVQUFNLFFBQVEsV0FBVyxRQUFRLElBQUksQ0FBQyxXQUFXLE9BQU8sVUFBVSxDQUFDLENBQUM7QUFBQSxFQUN0RTtBQUNGOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvY292ZXJhZ2Utd29ya2Vycy5tanMifQ==
