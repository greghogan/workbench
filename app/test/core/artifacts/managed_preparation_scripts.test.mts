import { required } from "../../../src/core/runtime/invariants.ts";
import { PreparationStore } from "../../../src/core/execution/environments/managed/managed-contract.mts";
import { selectPreparationStore } from "../../../src/core/artifacts/preparation-store.ts";
import { pendingManagedPreparations } from "../../../src/core/storage/managed-preparation.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, afterEach, vi } from "vitest";
import {
  importManagedProfiles,
  readManagedProfileArchive,
} from "../../../src/core/execution/environments/managed/profile-transfer.mjs";
const distribution = resolve(import.meta.dirname, "../../../..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a managed transfer matches the requested roots before any payload reaches a manager", async () => {
  const folder = mkdtempSync(join(tmpdir(), "workbench-manager-transfer-"));
  temporary.push(folder);
  const file = join(folder, "dev.archive");
  const expected = { builder: "nix", architecture: "x64", kind: "development", roots: [".", "apps/client"] } as const;
  const profiles = [
    { path: ".", profile: `/nix/store/${"a".repeat(32)}-root` },
    { path: "apps/client", profile: `/nix/store/${"b".repeat(32)}-client` },
  ];
  const payload = Buffer.from([0, 148, 255]);
  const writeArchive = (selected: typeof profiles) => {
    const metadata = Buffer.from(JSON.stringify({ version: 1, ...expected, profiles: selected }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.length);
    writeFileSync(file, Buffer.concat([prefix, metadata, payload]));
  };

  writeArchive(profiles);
  const selection = { ...expected, roots: [...expected.roots] };
  const opened = await readManagedProfileArchive(file, selection);
  expect(opened.profiles).toEqual(profiles);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.payload()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks)).toEqual(payload);
  const isolated = { env: { PATH: folder } };
  await expect(importManagedProfiles(file, { ...selection, architecture: "arm64" }, isolated)).rejects.toThrow(
    /manager, architecture, and kind/,
  );
  await expect(importManagedProfiles(file, { ...selection, roots: ["."] }, isolated)).rejects.toThrow(/project roots/);
  writeArchive([{ path: ".", profile: `/gnu/store/${"a".repeat(32)}-wrong-store` }]);
  await expect(importManagedProfiles(file, selection, isolated)).rejects.toThrow(/immutable store output/);
});

test.skipIf(process.platform !== "linux")(
  "local preparation reports a missing selected daemon with its startup command",
  async () => {
    const { base, bin, root } = fixture();
    const config = join(base, "config");
    mkdirSync(config);
    vi.stubEnv("WORKBENCH_CONFIG_HOME", config);
    vi.stubEnv("PATH", bin);
    await expect(selectPreparationStore("guix", root)).rejects.toThrow("Guix image preparation is disabled");
    expect(await selectPreparationStore("native", root)).toBeUndefined();
    writeFileSync(join(config, "config.toml"), '[preparation]\nguix_store = "system"\n');
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nprintf 'loaded\\n'\n", { mode: 0o755 });
    await expect(selectPreparationStore("guix", root)).rejects.toThrow(
      /sudo systemctl start guix-daemon\.service[\s\S]+preparation\.guix_store managed/,
    );
    writeFileSync(join(bin, "guix"), '#!/bin/sh\n[ "$*" = "gc --list-roots" ]\n', { mode: 0o755 });
    expect(await selectPreparationStore("guix", root)).toBe(PreparationStore.System);
    writeFileSync(join(config, "config.toml"), '[preparation]\nguix_store = "managed"\n');
    expect(await selectPreparationStore("guix", root)).toBe(PreparationStore.Managed);
  },
);
function fixture(project = "project") {
  const base = mkdtempSync(join(tmpdir(), "workbench-managed-scripts-"));
  temporary.push(base);
  const root = join(base, project),
    bin = join(base, "bin"),
    log = join(base, "calls.jsonl"),
    state = join(base, "state.json");
  mkdirSync(bin);
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, "other"));
  mkdirSync(join(root, ".devcontainer/guix"), { recursive: true });
  copyFileSync(join(distribution, ".devcontainer/guix/image.json"), join(root, ".devcontainer/guix/image.json"));
  copyFileSync(join(distribution, ".devcontainer/guix/prepare.sh"), join(root, ".devcontainer/guix/prepare.sh"));
  symlinkSync("/bin/sh", join(bin, "sh"));
  symlinkSync(process.execPath, join(bin, "node"));
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
if(name==='guix'){
 const base=p.dirname(log),stamp=fs.readFileSync(log,'utf8').split('\\n').length;
 if(a[0]==='--version'){if(process.env.BROKEN_MANAGER)process.exit(7);console.log('guix fixture');process.exit(0);}
 if(a[0]==='time-machine'||(a[0]==='repl'&&a[2]==='profile-for-system')){const target=p.join(base,'guix-runtime-'+stamp);fs.mkdirSync(p.join(target,'bin'),{recursive:true});fs.writeFileSync(p.join(target,'bin/guix'),fs.readFileSync(process.argv[1]),{mode:0o755});console.log(target);process.exit(0);}
 if(a[0]==='repl')process.exit(0);
 if(a[0]==='build'){const target=p.join(base,'guix-environments-'+stamp);const roots=JSON.parse(fs.readFileSync(process.env.WORKBENCH_ROOTS_FILE));roots.forEach((_,index)=>fs.mkdirSync(p.join(target,'share/workbench/environments',String(index)),{recursive:true}));fs.symlinkSync(target,a.find(x=>x.startsWith('--root=')).slice(7));console.log(target);process.exit(0);}
 if(a[0]==='pack'){const image='/gnu/store/fixture-image.tar';fs.symlinkSync(image,a.find(x=>x.startsWith('--root=')).slice(7));console.log(image);process.exit(0);}
 throw Error('unexpected guix call '+a.join(' '));
}
if(name==='nix'){if(process.env.BROKEN_MANAGER)process.exit(7);const profile=a.indexOf('--profile');if(profile>=0){const target=p.join(${JSON.stringify(base)},'real-profile-'+fs.readFileSync(log,'utf8').split('\\n').length);fs.mkdirSync(target);fs.symlinkSync(target,a[profile+1]);}if(a.includes('--print-out-paths')){const image='/nix/store/fixture-image.tar';const out=a[a.indexOf('--out-link')+1];fs.symlinkSync(image,out);console.log(image);} process.exit(0);}
if(name==='bash'){const child=spawnSync('docker',['load'],{input:'managed image archive',encoding:'utf8'});process.stdout.write(child.stdout);process.exit(child.status);}
if(name!=='docker')throw Error('unexpected tool');
const mounts=a.flatMap((arg,index)=>a[index-1]==='--mount'
 ? [Array.from(arg.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^",]+))(?=,|$)/g), field=>field[1]?.replaceAll('""','"')??field[2])]
 : []);
const sourceOf=destination=>mounts.find(fields=>fields.includes('dst='+destination))?.find(field=>field.startsWith('src='))?.slice(4);
const recipePath=p.join(process.env.WORKBENCH_CACHE_HOME,'fixture-bootstrap-recipe');
if(a[0]==='buildx'&&a[1]==='build'){
 const recipe=a.find(x=>x.startsWith('org.workbench.guix-bootstrap='));
 if(recipe){
   const context=a.at(-1);
   if(fs.readdirSync(context).sort().join(',')!=='Dockerfile,channels.scm,scripts'||!fs.existsSync(p.join(context,'scripts/ci-guix-bootstrap.scm')))throw Error('unbounded Guix bootstrap context');
   fs.writeFileSync(recipePath,recipe.split('=')[1]);
 }
 process.exit(0);
}
if(a[0]==='image'&&a[1]==='inspect'&&a.some(x=>x.includes('org.workbench.guix-bootstrap'))){
 console.log(fs.existsSync(recipePath)?fs.readFileSync(recipePath,'utf8'):'');process.exit(0);
}
const bk=state+'.buildkit',owned=fs.existsSync(bk)?JSON.parse(fs.readFileSync(bk)):{};const save=()=>fs.writeFileSync(bk,JSON.stringify(owned));
if(a[0]==='run'&&a.at(-1).startsWith('cat /workbench-store-probe/token;')){
 const source=sourceOf('/workbench-store-probe');
 process.stdout.write(fs.readFileSync(p.join(source,'token')));
 console.log('default');
 if(a.at(-1).endsWith('/opt/workbench-guix'))console.log('/gnu/store/'+'a'.repeat(32)+'-guix');
 else {console.log('/nix/store/'+'a'.repeat(32)+'-bootstrap');console.log('/nix/store/'+'b'.repeat(32)+'-nix');}
 process.exit(0);
}
if(a[0]==='volume'&&a[1]==='create'&&a.at(-1).startsWith('workbench-managed-')){
 const volumeFile=state+'.'+a.at(-1);
 if(!fs.existsSync(volumeFile))fs.writeFileSync(volumeFile,JSON.stringify(Object.fromEntries(a.filter((value,index)=>a[index-1]==='--opt').map(value=>value.split('=')))));
 console.log(a.at(-1));process.exit(0);
}
if(a[0]==='volume'&&a[1]==='inspect'&&a.at(-1).startsWith('workbench-managed-')){console.log(fs.readFileSync(state+'.'+a.at(-1),'utf8'));process.exit(0);}
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
else if(a[0]==='image'&&a[1]==='inspect'){console.log(a.includes('{{json .Config}}')?JSON.stringify({Cmd:['original-command']}):'sha256:'+ 'f'.repeat(64));}
else if(a[0]==='create'&&a[a.indexOf('--name')+1].startsWith('workbench-finalize-')){console.log('finalize-container');}
else if(a[0]==='create'){
 if(process.env.FAIL_MANAGED_CREATE)throw Error('fixture builder could not start');
 if(sourceOf('/preparation')!==process.env.WORKBENCH_PROJECT_ROOT)throw Error('wrong preparation directory');
 fs.writeFileSync(state,JSON.stringify({output:sourceOf('/output')}));
}
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
    WORKBENCH_PREPARATION_STORE: PreparationStore.Managed,
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
    GUIX_STATE_DIRECTORY: join(base, "guix-state"),
    WORKBENCH_LOCAL_CONFIG_ROOT: root,
    WORKBENCH_CONTAINER_CHECKOUT: root,
  };
  return { base, root, bin, log, state, env, tool };
}
async function run(
  f: ReturnType<typeof fixture>,
  builder = "nix",
  script = ["scripts/prepare-managed-development.mjs", builder, "fixture-output"],
) {
  const [entry, ...args] = script;
  const child = spawn(process.execPath, [join(distribution, required(entry, "Missing fixture script")), ...args], {
    cwd: f.root,
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

test.skipIf(process.platform !== "linux").each([false, true])(
  "Guix reuses the bootstrap manager for matching channels with foreign target %s",
  async (foreign) => {
    const f = fixture();
    const selected = "authenticated bootstrap channels";
    const manager = join(f.base, "manager"),
      output = join(f.base, "output");
    mkdirSync(join(manager, "bin"), { recursive: true });
    mkdirSync(output);
    for (const path of [join(f.bin, "guix"), join(manager, "bin", "guix")])
      writeFileSync(path, readFileSync(f.tool), { mode: 0o755 });
    writeFileSync(join(f.root, "channels.scm"), selected);
    const independent = join(f.root, "other/channels.scm");
    writeFileSync(independent, "different authenticated channels");
    const roots = join(output, "roots.json");
    writeFileSync(roots, JSON.stringify([".", "other"]));
    Object.assign(f.env, {
      WORKBENCH_ROOTS_FILE: roots,
      WORKBENCH_MANAGED_OUTPUT: output,
      WORKBENCH_GUIX_BOOTSTRAP_CHANNELS: createHash("sha256").update(selected).digest("hex"),
      WORKBENCH_GUIX_TIME_MACHINE_PROFILE: manager,
      WORKBENCH_IMAGE_ARCHITECTURE: foreign ? (process.arch === "arm64" ? "x64" : "arm64") : process.arch,
    });
    const result = await run(f, "guix", ["scripts/prepare-guix-profiles.mjs"]);
    expect(result.code, result.output).toBe(0);
    const lookups = result.calls.filter(({ args }) => args[0] === "time-machine");
    expect(lookups.map(({ args }) => args[2])).toEqual([independent]);
    const runtimeLookups = result.calls.filter(({ args }) => args[2] === "profile-for-system");
    expect(runtimeLookups).toHaveLength(foreign ? 2 : 0);
    const profiles = JSON.parse(readFileSync(join(output, "guix-profiles.json"), "utf8")) as {
      manager: string;
      runtime: string;
    }[];
    expect(profiles[0]?.manager).toBe(manager);
    if (foreign) expect(profiles[0]?.runtime).not.toBe(manager);
    else expect(profiles[0]?.runtime).toBe(manager);
  },
);
test.skipIf(process.platform !== "linux").each(["system", "managed", "broken", "cleanup-fails"])(
  "preparation honors the selected %s store",
  async (condition) => {
    const f = fixture();
    writeFileSync(join(f.bin, "nix"), readFileSync(f.tool), { mode: 0o755 });
    if (["system", "broken"].includes(condition)) f.env.WORKBENCH_PREPARATION_STORE = PreparationStore.System;
    if (condition === "broken") f.env.BROKEN_MANAGER = "1";
    if (condition === "cleanup-fails") f.env.FAIL_CLEANUP = "1";
    const result = await run(f);
    if (condition === "broken") {
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("status=7");
      expect(result.calls.some((c) => c.name === "docker")).toBe(false);
    } else if (condition === "cleanup-fails") {
      expect(result.code).not.toBe(0);
      expect(result.calls.some((c) => c.name === "docker" && c.args[0] === "image" && c.args[1] === "rm")).toBe(true);
      const state = JSON.parse(readFileSync(f.state, "utf8")) as { output: string };
      expect(existsSync(state.output)).toBe(false);
    } else {
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(condition === "system" ? "host store" : "managed Docker store");
      expect(
        result.calls.some((c) => c.name === "docker" && c.args[0] === "tag" && c.args.at(-1) === "fixture-output"),
      ).toBe(true);
      if (condition === "system")
        expect(result.calls.filter((c) => c.name === "nix" && c.args.includes("--profile"))).toHaveLength(2);
      else {
        expect(result.calls.some((c) => c.name === "nix")).toBe(false);
        expect(existsSync((JSON.parse(readFileSync(f.state, "utf8")) as { output: string }).output)).toBe(false);
      }
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

test.skipIf(process.platform !== "linux").each(["nix", "guix"])(
  "%s foreign preparation reuses the host manager with target-specific profiles",
  async (builder) => {
    const f = fixture();
    f.env.WORKBENCH_PREPARATION_STORE = PreparationStore.System;
    const architecture = process.arch === "arm64" ? "x64" : "arm64";
    f.env.WORKBENCH_IMAGE_ARCHITECTURE = architecture;
    f.env.FIXTURE_BUILDER = builder;
    writeFileSync(join(f.root, "channels.scm"), "fixture channel pin");
    writeFileSync(join(f.bin, builder), readFileSync(f.tool), { mode: 0o755 });
    const result = await run(f, builder);
    expect(result.code, result.output).toBe(0);
    expect(result.calls.some((call) => call.name === builder)).toBe(true);
    expect(result.output).toContain("host store");
    expect(
      result.calls.some(
        (call) =>
          call.name === builder &&
          call.args.some((arg) => arg.includes(architecture === "x64" ? "x86_64-linux" : "aarch64-linux")),
      ),
    ).toBe(true);
    expect(
      result.calls.some((call) => call.name === "docker" && call.args[0] === "buildx" && call.args[1] === "build"),
    ).toBe(false);
  },
);

test.skipIf(process.platform !== "linux")(
  "a failed Docker start leaves the exact preparation scope for recovery",
  async () => {
    const f = fixture();
    const cache = required(f.env.WORKBENCH_CACHE_HOME, "Missing fixture cache");
    f.env.WORKBENCH_PREPARATION_PROFILE = "linux";
    f.env.FAIL_MANAGED_CREATE = "1";
    vi.stubEnv("WORKBENCH_CACHE_HOME", cache);
    const result = await run(f);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("fixture builder could not start");
    const issues: string[] = [];
    const data = pendingManagedPreparations(f.root, issues);
    const [receipt] = data;
    expect(issues).toEqual([]);
    expect(data).toHaveLength(1);
    expect(receipt?.value).toMatchObject({
      checkout: f.root,
      profile: "linux",
      builder: "nix",
      inputs: f.env.WORKBENCH_IMAGE_INPUTS,
      architecture: process.arch,
    });
    const mountedStore = join(
      cache,
      "managed-stores",
      "nix",
      required(receipt, "Missing preparation receipt").value.key,
      "store",
    );
    expect(result.calls.some(({ args }) => args.includes(`device=${mountedStore}`))).toBe(true);
  },
);

test.skipIf(process.platform !== "linux").each(["nix", "guix"])(
  "%s projects with the same bootstrap share cache storage across target architectures",
  async (builder) => {
    const first = fixture(),
      second = fixture('second, project "mounted"');
    first.env.WORKBENCH_CACHE_HOME = join(first.base, 'cache, "shared"');
    second.env.WORKBENCH_CACHE_HOME = first.env.WORKBENCH_CACHE_HOME;
    second.env.WORKBENCH_IMAGE_ARCHITECTURE = process.arch === "arm64" ? "x64" : "arm64";
    for (const source of [first, second]) {
      source.env.FIXTURE_BUILDER = builder;
      writeFileSync(join(source.root, "channels.scm"), "fixture channel pin");
      if (builder === "guix") {
        mkdirSync(join(source.root, "scripts"));
        for (const file of [".devcontainer/guix/Dockerfile", "scripts/ci-guix-bootstrap.scm"])
          copyFileSync(join(distribution, file), join(source.root, file));
      }
    }
    const original = await run(first, builder),
      reused = await run(second, builder);
    expect(original.code, original.output).toBe(0);
    expect(reused.code, reused.output).toBe(0);
    const volumes = (result: Awaited<ReturnType<typeof run>>) =>
      result.calls
        .filter(
          ({ name, args }) =>
            name === "docker" &&
            args[0] === "volume" &&
            args[1] === "create" &&
            args.at(-1)?.startsWith("workbench-managed-"),
        )
        .map(({ args }) => ({ key: args.at(-1), device: args.find((arg) => arg.startsWith("device=")) }));
    const mounted = volumes(original);
    expect(mounted).toHaveLength(builder === "guix" ? 2 : 1);
    for (const { device } of mounted) expect(device).toContain(`/managed-stores/${builder}/`);
    expect(volumes(reused)).toEqual(mounted);
    const owner = (result: Awaited<ReturnType<typeof run>>) =>
      result.calls.flatMap(({ args }) => args.filter((arg) => arg.startsWith("WORKBENCH_PREPARATION_OWNER=")));
    expect(owner(original)).toHaveLength(1);
    expect(owner(reused)).not.toEqual(owner(original));
    if (builder === "guix") {
      const builds = (result: Awaited<ReturnType<typeof run>>) =>
        result.calls.filter(({ name, args }) => name === "docker" && args[0] === "buildx" && args[1] === "build");
      expect(builds(original)).toHaveLength(1);
      expect(builds(reused)).toHaveLength(0);
      expect(reused.output).toContain("Reusing the verified Guix bootstrap");
      second.env.WORKBENCH_REFRESH_GUIX_BOOTSTRAP = "1";
      const refreshed = await run(second, builder);
      expect(refreshed.code, refreshed.output).toBe(0);
      expect(builds(refreshed)).toHaveLength(1);
      delete second.env.WORKBENCH_REFRESH_GUIX_BOOTSTRAP;
      const recipe = join(second.root, ".devcontainer/guix/Dockerfile");
      writeFileSync(recipe, readFileSync(recipe, "utf8") + "\n# Customized build context\n");
      const custom = await run(second, builder);
      expect(custom.code, custom.output).toBe(0);
      expect(builds(custom).at(-1)?.args.at(-1)).toBe(second.root);
      expect(builds(custom).at(-1)?.args).not.toContain("--label");
    }
  },
);

test.skipIf(process.platform !== "linux").each(["nix", "guix"])(
  "%s missing-manager preparation keeps the Docker manager native and passes the foreign target",
  async (builder) => {
    const f = fixture();
    const architecture = process.arch === "arm64" ? "x64" : "arm64";
    f.env.WORKBENCH_IMAGE_ARCHITECTURE = architecture;
    f.env.FIXTURE_BUILDER = builder;
    writeFileSync(join(f.root, "channels.scm"), "fixture channel pin");
    const result = await run(f, builder);
    expect(result.code, result.output).toBe(0);
    const create = required(
      result.calls.find(
        (call) =>
          call.name === "docker" &&
          call.args[0] === "create" &&
          call.args.some((arg) => arg.startsWith("WORKBENCH_PRIVATE_BUILDER=")),
      ),
      "Builder container",
    );
    expect(create.args).toContain(`linux/${process.arch === "x64" ? "amd64" : "arm64"}`);
    expect(create.args).toContain(`WORKBENCH_IMAGE_ARCHITECTURE=${architecture}`);
  },
);
