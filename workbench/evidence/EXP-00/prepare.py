import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
REPO = Path('/efs/devel/workbench')
ARCHIVE = Path('/home/ec2-user/.cache/workbench/downloads/b5ed9675149cc837c282e9b6962c276c9fa62863d5b2f91537b60848552995b7-LLVM-23.1.2-Linux-X64.tar.xz')
EXPECTED = 'b5ed9675149cc837c282e9b6962c276c9fa62863d5b2f91537b60848552995b7'
FULL = ROOT / 'full'
REDUCED = ROOT / 'reduced'
TOOLS = ['clang', 'clang++', 'clang-cl', 'clang-cpp', 'clang-format', 'clang-tidy', 'clangd',
         'clang-scan-deps', 'clang-apply-replacements', 'llvm-cov', 'llvm-profdata',
         'llvm-ar', 'llvm-ranlib', 'llvm-nm', 'llvm-objcopy', 'llvm-objdump', 'llvm-readelf',
         'llvm-readobj', 'llvm-size', 'llvm-strings', 'llvm-strip', 'llvm-symbolizer',
         'lld', 'ld.lld', 'lld-link', 'ld64.lld']

def log(**values):
    print(json.dumps(values), flush=True)

def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

assert digest(ARCHIVE) == EXPECTED
FULL.mkdir()
started = time.monotonic()
run(['tar', '-xf', str(ARCHIVE), '--strip-components=1', '-C', str(FULL)])
log(phase='extracted', seconds=round(time.monotonic()-started, 2))

def inventory(directory):
    result = {}
    for current, directories, names in os.walk(directory, followlinks=False):
        for name in names + [name for name in directories if (Path(current)/name).is_symlink()]:
            path = Path(current)/name
            stat = path.lstat()
            result[str(path.relative_to(directory))] = {
                'bytes': stat.st_size, 'allocated': stat.st_blocks*512,
                'symlink': os.readlink(path) if path.is_symlink() else None,
                'inode': [stat.st_dev, stat.st_ino],
            }
    return result

all_files = inventory(FULL)
selected = set()
def retain(relative):
    path = FULL / relative
    if not path.exists():
        raise RuntimeError(f'missing required component: {relative}')
    if path.is_dir():
        for item in all_files:
            if item.startswith(relative.rstrip('/')+'/'):
                retain(item)
        return
    if relative in selected:
        return
    selected.add(relative)
    if path.is_symlink():
        target = path.resolve().relative_to(FULL.resolve())
        retain(str(target))

for tool in TOOLS:
    retain('bin/'+tool)
for component in ['lib/clang', 'include/c++', 'include/x86_64-unknown-linux-gnu', 'lib/x86_64-unknown-linux-gnu']:
    retain(component)
# Runtime libraries outside the target directory (e.g. OpenMP) and their aliases.
for path in (FULL/'lib').iterdir():
    if re.match(r'(lib(?:c\+\+|c\+\+abi|unwind|omp|archer|clang_rt)[^/]*|clang_rt[^/]*)\.(?:so(?:\..*)?|a)$', path.name):
        retain(str(path.relative_to(FULL)))
# Retain notices if the upstream binary package contains them.
for item in all_files:
    if re.search(r'(?:^|/)(?:LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*)$', item, re.I):
        retain(item)
# Follow bundled ELF dependencies; system SDK libraries remain in the base OS.
needed = {}
inspected = set()
while selected - inspected:
    for relative in sorted(selected-inspected):
        inspected.add(relative)
        path = FULL/relative
        if path.is_symlink():
            continue
        with path.open('rb') as stream:
            if stream.read(4) != b'\x7fELF':
                continue
        metadata = subprocess.check_output(['readelf', '-d', str(path)], text=True)
        libraries = re.findall(r'\(NEEDED\).*\[([^\]]+)\]', metadata)
        needed[relative] = libraries
        for library in libraries:
            matches = [item for item in all_files if Path(item).name == library]
            for match in matches:
                retain(match)

REDUCED.mkdir()
for relative in sorted(selected):
    source, destination = FULL/relative, REDUCED/relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
    else:
        shutil.copy2(source, destination)

def totals(files):
    seen, groups = set(), {}
    for relative, entry in files.items():
        key = tuple(entry['inode'])
        if key in seen:
            continue
        seen.add(key)
        group = relative.split('/')[0]
        row = groups.setdefault(group, {'bytes':0, 'allocated_bytes':0, 'files':0})
        row['bytes'] += entry['bytes']
        row['allocated_bytes'] += entry['allocated']
        row['files'] += 1
    return {'bytes': sum(row['bytes'] for row in groups.values()),
            'allocated_bytes':sum(row['allocated_bytes'] for row in groups.values()),
            'entries':len(files), 'groups':groups}

removed = {path:values for path,values in all_files.items() if path not in selected}
report = {'llvm_version':'23.1.2', 'upstream_sha256':EXPECTED,
          'upstream_archive_bytes':ARCHIVE.stat().st_size,
          'selection_script_sha256':digest(Path(__file__)),
          'tools':TOOLS, 'full':totals(all_files), 'reduced':totals(inventory(REDUCED)),
          'removed':totals(removed), 'elf_dependencies':needed}
(ROOT/'retained-files.json').write_text(json.dumps(sorted(selected), indent=2)+'\n')
(ROOT/'removed-files.json').write_text(json.dumps(removed, indent=2)+'\n')
(ROOT/'measurements.json').write_text(json.dumps(report, indent=2)+'\n')
log(phase='selection', full=report['full'], reduced=report['reduced'], removed=report['removed'])

# Copy current project inputs, excluding all generated or external storage links.
excluded = shutil.ignore_patterns('.git', 'node_modules', '.venv', '.pnpm-store', 'target',
                                 'build', 'dist', 'coverage', '__pycache__', '.pytest_cache',
                                 '.mypy_cache', '.ruff_cache', '.workbench-storage', 'library')
shutil.copytree(REPO, ROOT/'project', symlinks=True, ignore=excluded)
input_hash = hashlib.sha256()
for path in sorted((ROOT/'project').rglob('*')):
    if path.is_file() and not path.is_symlink():
        input_hash.update(str(path.relative_to(ROOT/'project')).encode()+b'\0')
        input_hash.update(bytes.fromhex(digest(path)))
report['copied_input_sha256'] = input_hash.hexdigest()
for name, version, asset in [('node','24.21.0','6e1db87ef58b8819'),
                             ('cmake','4.4.4','e5bb807f7728cb60'),
                             ('ninja','1.13.2','5749cbc4e6682735')]:
    source = Path('/home/ec2-user/.local/share/workbench/toolchains')/name/version/'linux-x64'/asset
    shutil.copytree(source, ROOT/'tools'/name, symlinks=True)
# Copy the verified vcpkg checkout; all subsequent outputs live in /tmp.
revision = (ROOT/'project/examples/languages/c/.vcpkg-version').read_text().strip()
vcpkg = Path('/home/ec2-user/.local/share/workbench/toolchains/vcpkg')/revision/'linux-x64'
shutil.copytree(vcpkg, ROOT/'vcpkg', symlinks=True)
(ROOT/'measurements.json').write_text(json.dumps(report, indent=2)+'\n')
log(phase='prepared', input_sha256=report['copied_input_sha256'])
