import json
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parent
report_path = root/'measurements.json'
report = json.loads(report_path.read_text())
report['cache_archives'] = {}
for name in ['reduced', 'full']:
    source = root/name
    archive = root/(name+'.tar.zst')
    start = time.monotonic()
    with archive.open('wb') as stream:
        tar = subprocess.Popen(['tar', '-C', str(source), '-cf', '-', '.'], stdout=subprocess.PIPE)
        try:
            subprocess.run(['zstd', '-q', '-T2', '-3'], stdin=tar.stdout, stdout=stream, check=True)
        finally:
            tar.stdout.close()
        if tar.wait() != 0:
            raise RuntimeError('tar failed')
    row = {'bytes':archive.stat().st_size, 'pack_seconds':round(time.monotonic()-start, 2)}
    restored = root/('restored-'+name)
    restored.mkdir()
    start = time.monotonic()
    subprocess.run(['tar', '--zstd', '-xf', str(archive), '-C', str(restored)], check=True)
    row['restore_seconds'] = round(time.monotonic()-start, 2)
    # Verify every archived byte and link after a genuinely separate restoration.
    for path in source.rglob('*'):
        target = restored/path.relative_to(source)
        if path.is_symlink():
            assert target.is_symlink() and path.readlink() == target.readlink(), str(path)
        elif path.is_file():
            import hashlib
            with path.open('rb') as left, target.open('rb') as right:
                assert hashlib.file_digest(left, 'sha256').digest() == hashlib.file_digest(right, 'sha256').digest(), str(path)
    row['restore_integrity'] = 'passed'
    report['cache_archives'][name] = row
    report_path.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'phase':'archive', 'name':name, **row}), flush=True)
