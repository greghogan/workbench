import { required } from "../src/invariants.ts";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, afterEach } from "vitest";
const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "workbench-managed-scripts-"));
  temporary.push(base);
  const root = join(base, "project"),
    bin = join(base, "bin"),
    log = join(base, "calls.jsonl"),
    state = join(base, "state.json");
  mkdirSync(bin);
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, "other"));
  mkdirSync(join(root, ".devcontainer/guix"), { recursive: true });
  copyFileSync(join(distribution, ".devcontainer/guix/image.json"), join(root, ".devcontainer/guix/image.json"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="fixture"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="other"\n',
  );
  const tool = join(bin, "tool.cjs");
  writeFileSync(
    tool,
    `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'),{spawnSync}=require('node:child_process'); const name=p.basename(process.argv[1]),a=process.argv.slice(2),log=${JSON.stringify(log)},state=${JSON.stringify(state)}; fs.appendFileSync(log,JSON.stringify({name,args:a})+'\\n');
if(name==='nix'){if(a[0]==='--version'){if(process.env.BROKEN_MANAGER)process.exit(7);console.log('nix fixture');process.exit(0);} const profile=a.indexOf('--profile');if(profile>=0){const target=p.join(${JSON.stringify(base)},'real-profile-'+fs.readFileSync(log,'utf8').split('\\n').length);fs.mkdirSync(target);fs.symlinkSync(target,a[profile+1]);}if(a.includes('--print-out-paths')){const image='/nix/store/fixture-image.tar';const out=a[a.indexOf('--out-link')+1];fs.symlinkSync(image,out);console.log(image);} process.exit(0);}
if(name==='bash'){const child=spawnSync('docker',['load'],{input:'managed image archive',encoding:'utf8'});process.stdout.write(child.stdout);process.exit(child.status);}
if(name!=='docker')throw Error('unexpected tool');
const bk=state+'.buildkit',owned=fs.existsSync(bk)?JSON.parse(fs.readFileSync(bk)):{};const save=()=>fs.writeFileSync(bk,JSON.stringify(owned));
if(a[0]==='ps'){console.log(a.includes('--no-trunc')?(owned.container?.Id??''):(owned.container?.Id??''));process.exit(0);}
if(a[0]==='volume'&&a[1]==='ls'){console.log(owned.volume?.Name??'');process.exit(0);}
if(a[0]==='volume'&&a[1]==='create'&&a.at(-1).startsWith('buildx_')){owned.volume={Name:a.at(-1),CreatedAt:'created',Labels:Object.fromEntries(a.filter(x=>x.startsWith('org.workbench.')).map(x=>x.split('=')))};save();console.log(a.at(-1));process.exit(0);}
if(a[0]==='volume'&&a[1]==='inspect'&&a[2].startsWith('buildx_')){console.log(JSON.stringify([owned.volume]));process.exit(0);}
if(a[0]==='container'&&a[1]==='inspect'){console.log(JSON.stringify([owned.container]));process.exit(0);}
if(a[0]==='buildx'){if(a[1]==='create'){owned.node=a[a.indexOf('--node')+1];owned.image=a.find(x=>x.startsWith('image=')).slice(6);owned.token=a.find(x=>x.startsWith('env.WORKBENCH_BUILDER_TOKEN=')).slice(4);save();}else if(a[1]==='inspect'){owned.container={Id:'c'.repeat(64),Created:'created',Config:{Image:owned.image,Env:[owned.token]},Mounts:[{Name:owned.volume.Name,Destination:'/var/lib/buildkit'}]};save();}process.exit(0);}

if(a[0]==='image'&&a[1]==='ls')console.log('fixture-image');
else if(a[0]==='container'&&a[1]==='ls'&&fs.existsSync(state))console.log('fixture-container');
else if(a[0]==='info')console.log('fixture-engine');
else if(a[0]==='volume'&&a[1]==='inspect')console.log(JSON.stringify(a.slice(2).map(Name=>({Name,CreatedAt:'2026-10-19T00:00:00Z'}))));
else if(a[0]==='image'&&a[1]==='inspect'){console.log(a.includes('{{json .Config}}')?JSON.stringify({Cmd:['original-command']}):'sha256:fixture');}
else if(a[0]==='create'&&a[a.indexOf('--name')+1].startsWith('workbench-finalize-')){console.log('finalize-container');}
else if(a[0]==='create'){const mount=a.filter(x=>x.startsWith('type=bind,')).find(x=>x.includes('dst=/output'));fs.writeFileSync(state,JSON.stringify({output:mount.split('src=')[1].split(',')[0]}));}
else if(a[0]==='start'){const {output}=JSON.parse(fs.readFileSync(state));fs.writeFileSync(p.join(output,'image-path'),'/'+(process.env.FIXTURE_BUILDER==='guix'?'gnu':'nix')+'/store/fixture-image.tar');}
else if(a[0]==='inspect')console.log('0');
else if(a[0]==='load'){let bytes='';process.stdin.on('data',chunk=>bytes+=chunk);process.stdin.on('end',()=>{if(bytes!=='managed image archive')throw Error('wrong archive');console.log('Loaded image: fixture-loaded');});}
else if(a[0]==='cp'&&a.includes('--follow-link')){fs.writeFileSync(a.at(-1),'account');}
else if(a[0]==='rm'&&process.env.FAIL_CLEANUP){console.error('fixture container cleanup failed');process.exit(8);}
`,
    { mode: 0o755 },
  );
  for (const name of ["docker", "bash"]) {
    // Independent wrappers keep process.argv[1] identifying the selected fake tool.
    const path = join(bin, name);
    writeFileSync(path, readFileSync(tool), { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin,
    WORKBENCH_IMAGE_INPUTS: "a".repeat(64),
    WORKBENCH_MANAGED_CORES: "2",
    WORKBENCH_MANAGED_JOBS: "2",
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_CONFIG_HOME: join(base, "config"),
    WORKBENCH_CACHE_HOME: join(base, "cache"),
    WORKBENCH_STORAGE_ROOT: join(base, "cache"),
    WORKBENCH_STORAGE_EXTERNAL: "true",
    WORKBENCH_STATE_HOME: join(base, "workbench-state"),
    WORKBENCH_DATA_HOME: join(base, "data"),
    WORKBENCH_LOCAL_CONFIG_ROOT: root,
    WORKBENCH_CONTAINER_CHECKOUT: root,
  };
  return { base, root, bin, log, state, env, tool };
}
async function run(f: ReturnType<typeof fixture>, builder = "nix") {
  const child = spawn(
    process.execPath,
    [join(distribution, "scripts/prepare-managed-development.mjs"), builder, "fixture-output"],
    { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (b) => {
    output += String(b);
  });
  child.stderr.on("data", (b) => {
    output += String(b);
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    code,
    output,
    calls: existsSync(f.log)
      ? readFileSync(f.log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { name: string; args: string[] })
      : [],
  };
}
test.skipIf(process.platform !== "linux").each(["installed", "missing", "broken", "cleanup-fails"])(
  "managed entry point handles %s manager/container state",
  async (condition) => {
    const f = fixture();
    if (["installed", "broken"].includes(condition))
      writeFileSync(join(f.bin, "nix"), readFileSync(f.tool), { mode: 0o755 });
    if (condition === "broken") f.env.BROKEN_MANAGER = "1";
    if (condition === "cleanup-fails") f.env.FAIL_CLEANUP = "1";
    const result = await run(f);
    if (condition === "broken") {
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("failed: 7");
      expect(result.calls.some((c) => c.name === "docker")).toBe(false);
    } else if (condition === "cleanup-fails") {
      expect(result.code).not.toBe(0);
      expect(result.calls.some((c) => c.name === "docker" && c.args[0] === "image" && c.args[1] === "rm")).toBe(true);
      const state = JSON.parse(readFileSync(f.state, "utf8")) as { output: string };
      expect(existsSync(state.output)).toBe(false);
    } else {
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(condition === "installed" ? "host store" : "Docker builder");
      expect(
        result.calls.some((c) => c.name === "docker" && c.args[0] === "tag" && c.args.at(-1) === "fixture-output"),
      ).toBe(true);
      if (condition === "installed")
        expect(result.calls.filter((c) => c.name === "nix" && c.args.includes("--profile"))).toHaveLength(2);
      else expect(existsSync((JSON.parse(readFileSync(f.state, "utf8")) as { output: string }).output)).toBe(false);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "Guix assembly materializes account files after importing its closure",
  async () => {
    const f = fixture();
    f.env.FIXTURE_BUILDER = "guix";
    writeFileSync(join(f.root, "channels.scm"), "fixture channel pin");
    const result = await run(f, "guix");
    expect(result.code, result.output).toBe(0);
    const imported = result.calls.findIndex(
      (call) => call.name === "docker" && call.args[0] === "tag" && call.args.at(-1) === "fixture-output",
    );
    const finalized = result.calls.findIndex((call) => call.name === "docker" && call.args[0] === "commit");
    expect(imported).toBeGreaterThan(-1);
    expect(finalized).toBeGreaterThan(imported);
    expect(result.calls.filter((call) => call.args[0] === "cp" && call.args.includes("--follow-link"))).toHaveLength(2);
    expect(required(result.calls[finalized], "Expected fixture value").args.at(-1)).toBe("fixture-output");
    expect(existsSync((JSON.parse(readFileSync(f.state, "utf8")) as { output: string }).output)).toBe(false);
  },
);
