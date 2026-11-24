import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { hasCollectionProject } from "../core/collections/collections.js";
import { CollectionOperation } from "../core/diagnostics/diagnostics.mjs";
import { distributionRoot } from "../core/projects/project-context.js";
import { registerCommand } from "./commands.js";
import { requireProjectRegistration } from "./project-admission.js";

export function registerServerCommands(program: Command, root: string, logDirectory: () => string | undefined): void {
  registerCommand(program, "serve")
    .description("Browse, edit, and review project records in a local browser")
    .addOption(
      new Option("--host <address>", "Loopback listener address").choices(["127.0.0.1", "::1"]).default("127.0.0.1"),
    )
    .option("--port <port>", "Starting port for the private listener (0 selects an available port)", Number)
    .option("--demo", "Start with a disposable, offline demonstration")
    .addOption(
      new Option("--daemon", "Start a private server in the background and print its sign-in").conflicts("service"),
    )
    .addOption(new Option("--service", "Run under a supervisor without printing sign-in").conflicts("daemon"))
    .action(
      async (options: {
        host: "127.0.0.1" | "::1";
        port?: number;
        demo?: boolean;
        daemon?: boolean;
        service?: boolean;
      }) => {
        if (!options.demo && !options.service && hasCollectionProject(root)) await requireProjectRegistration(root);
        const { projectHubEnvironment, runPrivateService, startSystemService } = await import("../server/runtime.js");
        const hubEnvironment = projectHubEnvironment(process.env);
        for (const name of Object.keys(process.env))
          if (!(name in hubEnvironment)) Reflect.deleteProperty(process.env, name);
        const mode = options.service ? "service" : options.daemon ? "daemon" : "foreground";
        if (options.service && process.env.WORKBENCH_SYSTEM_SERVICE === "1") {
          if (options.demo) throw new Error("The shared service opens demonstration projects after sign-in");
          await startSystemService(distributionRoot(root), options);
          return;
        }
        await runPrivateService(
          distributionRoot(root),
          { ...options, mode, logs: logDirectory() },
          (access, started) => {
            if (access.logs) console.log(`Server logs: ${access.logs}`);
            console.log(`Workbench web UI: ${access.url}`);
            if (mode === "service") return;
            console.log(`Sign-in username: ${access.signIn.username}`);
            // Use the shared terminal transcript's credential redaction label.
            console.log(`Sign-in password: ${access.signIn.password}`);
            if (mode === "daemon" && !access.shared) console.log(`Server PID: ${String(access.pid)}`);
            if (started) console.log("Press Ctrl-C to stop.");
          },
        );
      },
    );
  registerCommand(program, "web-demo", { hidden: true })
    .argument("<distribution>")
    .argument("<directory>")
    .action(async (distribution: string, directory: string) => {
      if (process.env.WORKBENCH_DEMONSTRATION_CHILD !== directory)
        throw new Error("web-demo is an owned internal service");
      const { serveDemonstration } = await import("../server/runtime.js");
      await serveDemonstration(distribution, directory);
    });
  registerCommand(program, "web-account", { hidden: true })
    .argument("<socket>")
    .action(async (socket: string) => {
      const { serveAccountWorker } = await import("../server/runtime.js");
      await serveAccountWorker(distributionRoot(root), socket);
    });
  registerCommand(program, "web-windows-system", { hidden: true }).action(async () => {
    const { serveWindowsSystem } = await import("../server/runtime.js");
    await serveWindowsSystem(distributionRoot(root), process.stdin, process.stdout);
  });
  registerCommand(program, "web-windows-account", { hidden: true }).action(async () => {
    const { serveWindowsAccount } = await import("../server/runtime.js");
    await serveWindowsAccount(distributionRoot(root));
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
