import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

root = Path('/workspace')
variant = sys.argv[1]
llvm = root/('restored-'+variant)
state = root/('state-'+variant)
state.mkdir()
project = root/('project-'+variant)
shutil.copytree(root/'project', project, symlinks=True)
revision = (project/'examples/languages/c/.vcpkg-version').read_text().strip()
vcpkg = state/'data/toolchains/vcpkg'/revision/'linux-x64'
vcpkg.parent.mkdir(parents=True)
shutil.copytree(root/'vcpkg', vcpkg, symlinks=True)
for path in [state/'home', state/'tmp', state/'cache']:
    path.mkdir()
env = {
    **os.environ,
    'HOME':str(state/'home'), 'TMPDIR':str(state/'tmp'),
    'WORKBENCH_DATA_HOME':str(state/'data'), 'WORKBENCH_CACHE_HOME':str(state/'cache'),
    'WORKBENCH_STORAGE_ROOT':str(state/'cache'), 'WORKBENCH_STORAGE_EXTERNAL':'true',
    'VCPKG_BINARY_SOURCES':'clear', 'VCPKG_DISABLE_METRICS':'1',
    'CMAKE_BUILD_PARALLEL_LEVEL':'2', 'VCPKG_MAX_CONCURRENCY':'2',
    'ASAN_SYMBOLIZER_PATH':str(llvm/'bin/llvm-symbolizer'),
    'PATH':':'.join([str(llvm/'bin'), str(root/'tools/node/bin'),
                     str(root/'tools/cmake/bin'),str(root/'tools/ninja'),
                     '/usr/local/bin','/usr/bin','/bin']),
}
for key in ['CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','LIBRARY_PATH','LD_LIBRARY_PATH',
            'GCC_EXEC_PREFIX','CMAKE_PREFIX_PATH','WORKBENCH_CC','WORKBENCH_CXX',
            'WORKBENCH_ACTIVE_ENVIRONMENT','WORKBENCH_ACTIVE_ROOT','WORKBENCH_REQUIRE_BENCHCTL']:
    env.pop(key, None)
results = {'variant':variant, 'checks':[]}
output = root/('verification-'+variant+'.json')
def run(name, args, cwd=project, capture=False):
    started = time.monotonic()
    print('CHECK '+name, flush=True)
    completed = subprocess.run(args, cwd=cwd, env=env, text=True,
                               stdout=subprocess.PIPE if capture else None,
                               stderr=subprocess.PIPE if capture else None)
    row = {'name':name, 'exit_code':completed.returncode, 'seconds':round(time.monotonic()-started, 2)}
    if capture:
        row.update(stdout=completed.stdout, stderr=completed.stderr)
        print(completed.stdout, flush=True)
        print(completed.stderr, file=sys.stderr, flush=True)
    results['checks'].append(row)
    output.write_text(json.dumps(results, indent=2)+'\n')
    if completed.returncode != 0:
        raise RuntimeError(name+' failed')
    return completed.stdout if capture else ''

assert not Path('/efs').exists(), 'original repository must not be mounted'
assert not Path('/home/ec2-user').exists(), 'global LLVM must not be mounted'
if variant == 'reduced':
    for hidden in ['full', 'reduced', 'restored-full']:
        assert not any((root/hidden).iterdir()), 'unrestored or full LLVM must be inaccessible'
run('platform and OS', ['sh','-c','uname -m; cat /etc/os-release'], capture=True)
run('installed OS packages', ['dpkg-query','-W'], capture=True)
for name in ['clang','clang++','clang-format','clang-tidy','clangd','llvm-cov','llvm-profdata','ld.lld','llvm-ar','llvm-symbolizer']:
    selected = run('path '+name, ['sh','-c','command -v "$1"','tool',name], capture=True).strip()
    assert selected == str(llvm/'bin'/name), selected
    run('version '+name, [name,'--version'], capture=True)
resource = run('Clang resource directory', ['clang','-print-resource-dir'], capture=True).strip()
assert resource.startswith(str(llvm)+'/'), resource
for path in (llvm/'bin').iterdir():
    if path.is_symlink():
        assert path.resolve().is_relative_to(llvm.resolve())
smoke = state/'smoke'
smoke.mkdir()
(smoke/'library.c').write_text('int answer(void) { return 42; }\n')
(smoke/'main.c').write_text('int answer(void); int main(void) { return answer() == 42 ? 0 : 1; }\n')
run('Clang LTO object', ['clang','-flto','-c','library.c','-o','library.o'], cwd=smoke)
run('LLVM bitcode archive', ['llvm-ar','rcs','libanswer.a','library.o'], cwd=smoke)
run('LLVM archive index', ['llvm-ranlib','libanswer.a'], cwd=smoke)
run('LLVM archive symbols', ['llvm-nm','libanswer.a'], cwd=smoke)
run('LLD LTO link', ['clang','-flto','-fuse-ld=lld','main.c','libanswer.a','-o','answer'], cwd=smoke)
run('LLD linked program', [str(smoke/'answer')], cwd=smoke)
(smoke/'runtime.cpp').write_text('#include <iostream>\n#include <vector>\nint main() { std::vector<int> v{20,22}; std::cout << v[0]+v[1] << "\\n"; }\n')
run('Bundled libc++ compile and link', ['clang++','-std=c++20','-stdlib=libc++',
    '-Wl,-rpath,'+str(llvm/'lib/x86_64-unknown-linux-gnu'),'runtime.cpp','-o','runtime'], cwd=smoke)
assert run('Bundled libc++ program', [str(smoke/'runtime')], cwd=smoke, capture=True).strip() == '42'
for language in ['c','cpp']:
    relative = 'examples/languages/'+language
    cwd = project/relative
    run(language+' configured commit gate', ['node','bin/workbench.mjs','checks','run','--environment','native','--path',relative])
    run(language+' coverage floors', ['node','bin/workbench.mjs','checks','run','--environment','native','--path',relative,'--role','coverage'])
    run(language+' release', ['node','bin/workbench.mjs','checks','run','--environment','native','--path',relative,'--role','release'])
    run(language+' release smoke outside checkout', ['node',str(project/'scripts/check-release.mjs')], cwd=cwd)
    databases = sorted((state/'cache/builds').rglob('debug/compile_commands.json'))
    candidates = []
    for database in databases:
        contents = json.loads(database.read_text())
        if any(str(cwd) in entry['file'] for entry in contents):
            candidates.append(database)
    assert len(candidates) == 1, candidates
    source = cwd/('src/count.c' if language=='c' else 'src/count.cpp')
    run(language+' clangd semantic check', ['clangd','--check='+str(source),'--compile-commands-dir='+str(candidates[0].parent),'--log=verbose'])
results['status'] = 'passed'
output.write_text(json.dumps(results, indent=2)+'\n')
print('VERIFICATION PASSED '+variant, flush=True)
