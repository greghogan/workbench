import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { hasCollectionProject } from "../core/collections/collections.js";
import { CollectionOperation } from "../core/diagnostics/diagnostics.mjs";
import { distributionRoot } from "../core/projects/project-context.js";
import { registerCommand } from "./commands.js";
import { requireProjectRegistration } from "./project-admission.js";

export function registerServerCommands(program: Command, root: string): void {
  registerCommand(program, "serve")
    .description("Browse, edit, and review project records in a local browser")
    .addOption(
      new Option("--host <address>", "Loopback listener address").choices(["127.0.0.1", "::1"]).default("127.0.0.1"),
    )
    .option("--port <port>", "Local listener port (0 selects an available port)", Number, 8080)
    .option("--demo", "Start with a disposable, offline demonstration")
    .action(async (options: { host: "127.0.0.1" | "::1"; port: number; demo?: boolean }) => {
      if (!options.demo && hasCollectionProject(root)) await requireProjectRegistration(root);
      const { projectHubEnvironment, startProjectHub } = await import("../server/runtime.js");
      const hubEnvironment = projectHubEnvironment(process.env);
      for (const name of Object.keys(process.env))
        if (!(name in hubEnvironment)) Reflect.deleteProperty(process.env, name);
      const web = await startProjectHub(distributionRoot(root), options);
      console.log(`Workbench web UI: ${web.url}`);
      console.log(`Sign-in username: ${web.signIn.username}`);
      // Use the shared terminal transcript's credential redaction label.
      console.log(`Sign-in password: ${web.signIn.password}`);
      console.log("Press Ctrl-C to stop.");
      let stop: () => void = () => undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          stop = () => {
            void web.close().then(resolve, reject);
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          web.server.once("error", reject);
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await web.close();
      }
    });
  registerCommand(program, "web-demo", { hidden: true })
    .argument("<distribution>")
    .argument("<directory>")
    .action(async (distribution: string, directory: string) => {
      if (process.env.WORKBENCH_DEMONSTRATION_CHILD !== directory)
        throw new Error("web-demo is an owned internal service");
      const { serveDemonstration } = await import("../server/runtime.js");
      await serveDemonstration(distribution, directory);
    });
  registerCommand(program, "web-collection", { hidden: true })
    .argument("<operation>")
    .action(async (operation: string) => {
      const { decodeCollectionWorkerRequest, previewCollection, applyCollectionForReview } =
        await import("../server/runtime.js");
      const payload = readFileSync(0, "utf8");
      if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("collection request exceeds 64 KiB");
      const { request, expected } = decodeCollectionWorkerRequest(JSON.parse(payload));
      if (operation === CollectionOperation.Preview) console.log(JSON.stringify(previewCollection(root, request)));
      else if (operation === CollectionOperation.Apply && typeof expected === "string") {
        console.log(JSON.stringify(await applyCollectionForReview(root, request, expected)));
      } else throw new Error("unknown collection operation or missing review digest");
    });
}
