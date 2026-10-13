"""Authenticate the initial Node runtime before any downloaded executable runs."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import signal
import shutil
import tarfile
import tempfile
import urllib.request


class HTTPSRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if not newurl.startswith("https://"):
            raise ValueError("bootstrap redirect must retain HTTPS")
        return super().redirect_request(request, fp, code, message, headers, newurl)


opener = urllib.request.build_opener(HTTPSRedirects())

# The pinned Node 26 executable is 144 MiB; retain a bounded allowance for its upstream binary.
MAX_ENTRY_BYTES = 256 * 1024 ** 2


def fetch(url, limit):
    if not url.startswith("https://"):
        raise ValueError("bootstrap downloads require HTTPS")
    with opener.open(url, timeout=120) as response:
        result = response.read(limit + 1)
        if len(result) > limit:
            raise ValueError("bootstrap proof exceeds its size limit")
        return result


class Input(io.RawIOBase):
    def __init__(self, stream, limit, digest=False, guard=False):
        self.stream, self.limit, self.bytes = stream, limit, 0
        self.digest = hashlib.sha256() if digest else None
        self.guard = guard
        self.header, self.remaining, self.entries = bytearray(), 0, 0

    def read(self, size=-1):
        chunk = self.stream.read(min(size if size >= 0 else 65536, 65536))
        self.bytes += len(chunk)
        if self.bytes > self.limit:
            raise ValueError("bootstrap stream exceeds its byte limit")
        if self.digest:
            self.digest.update(chunk)
        if self.guard:
            offset = 0
            while offset < len(chunk):
                if self.remaining:
                    length = min(self.remaining, len(chunk) - offset)
                    self.remaining -= length
                    offset += length
                    continue
                length = min(512 - len(self.header), len(chunk) - offset)
                self.header.extend(chunk[offset:offset + length])
                offset += length
                if len(self.header) != 512:
                    continue
                if any(self.header):
                    self.entries += 1
                    size_text = bytes(self.header[124:136]).split(b"\0")[0].strip()
                    if not re.fullmatch(b"[0-7]+", size_text):
                        raise ValueError("unsupported bootstrap tar size encoding")
                    entry_size = int(size_text, 8)
                    if self.entries > 20000 or entry_size > MAX_ENTRY_BYTES:
                        raise ValueError("bootstrap archive entry exceeds its limit")
                    if self.header[156] in b"xgLK" and entry_size > 64 * 1024:
                        raise ValueError("bootstrap archive metadata exceeds its limit")
                    self.remaining = ((entry_size + 511) // 512) * 512
                self.header.clear()
        return chunk


def install(asset_path, destination):
    asset_path, destination = Path(asset_path), Path(destination)
    asset = json.loads(asset_path.read_text())
    catalog = asset["checksums"]
    signature = catalog["signature"]
    if destination.exists():
        raise ValueError("bootstrap destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".node-bootstrap-", dir=destination.parent) as temporary:
        staging = Path(temporary)
        home = staging / "gpg"
        home.mkdir(mode=0o700)
        sums = fetch(catalog["url"], 2 * 1024 ** 2)
        (staging / "checksums").write_bytes(sums)
        (staging / "signature").write_bytes(fetch(signature["url"], 64 * 1024))
        command = ["gpg", "--batch", "--no-options", "--homedir", str(home), "--no-auto-key-retrieve", "--no-autostart"]
        keyring = home / "keys.gpg"
        subprocess.run(command + ["--dearmor", "--output", str(keyring), str(asset_path.parent / signature["keys"])], check=True, capture_output=True, timeout=30)
        command += ["--no-default-keyring", "--keyring", str(keyring), "--no-auto-check-trustdb"]
        verified = subprocess.run(command + ["--status-fd", "1", "--verify", str(staging / "signature"), str(staging / "checksums")], check=True, capture_output=True, timeout=30)
        valid = [line.split() for line in verified.stdout.decode().splitlines() if line.startswith("[GNUPG:] VALIDSIG ")]
        if not any(line[2] in signature["signers"] or line[-1] in signature["signers"] for line in valid):
            raise ValueError("bootstrap signature signer is not approved")
        matches = [digest for digest, name in re.findall(r"^([a-fA-F0-9]{64}) [ *](.+)$", sums.decode(), re.MULTILINE) if name == catalog["subject"]]
        if matches != [asset["sha256"]]:
            raise ValueError("signed bootstrap catalog does not bind the expected digest")
        content = staging / "content"
        content.mkdir(mode=0o700)
        if not asset["url"].startswith("https://"):
            raise ValueError("bootstrap downloads require HTTPS")
        with opener.open(asset["url"], timeout=120) as response:
            incoming = Input(response, 128 * 1024 ** 2, digest=True)
            with gzip.GzipFile(fileobj=incoming) as decoder:
                guarded = Input(decoder, 512 * 1024 ** 2, guard=True)
                with tarfile.open(fileobj=guarded, mode="r|") as archive:
                    names, links = set(), []
                    top = None
                    for member in archive:
                        if member.name.startswith("/") or ".." in member.name.split("/") or "\\" in member.name or any(ord(c) < 32 or ord(c) == 127 for c in member.name):
                            raise ValueError("unsafe bootstrap archive path")
                        member.name = Path(member.name).as_posix()
                        if member.sparse is not None or member.size < 0 or member.size > MAX_ENTRY_BYTES:
                            raise ValueError("bootstrap logical archive entry exceeds its limit")
                        parts = member.name.split("/")
                        top = top or parts[0]
                        if parts[0] != top or member.name in names or not (member.isfile() or member.isdir() or member.issym()):
                            raise ValueError("unsupported bootstrap archive member")
                        names.add(member.name)
                        if member.issym():
                            # Node's npm links are relative; tarfile's data filter also checks containment.
                            if member.linkname.startswith("/"):
                                raise ValueError("absolute bootstrap link")
                            links.append(member)
                        else:
                            # Links are deferred, so no archive member can redirect these writes.
                            target = content / member.name
                            if member.isdir():
                                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                            else:
                                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                                with archive.extractfile(member) as source, target.open("xb") as output:
                                    shutil.copyfileobj(source, output, length=65536)
                                target.chmod(member.mode & 0o755)
                while guarded.read(65536):
                    pass
                if guarded.header or guarded.remaining:
                    raise ValueError("truncated bootstrap archive")
            while incoming.read(65536):
                pass
            if incoming.digest.hexdigest() != asset["sha256"]:
                raise ValueError("Node bootstrap checksum mismatch")
        installed = content / top
        if not (installed / "bin/node").is_file():
            raise ValueError("bootstrap runtime is missing Node")
        link_names = {content / member.name for member in links}
        for member in links:
            target = content / member.name
            if any(parent in link_names for parent in target.parents):
                raise ValueError("bootstrap link has a link as its parent")
            if not Path(os.path.normpath(target.parent / member.linkname)).is_relative_to(installed):
                raise ValueError("bootstrap link escapes installation")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(member.linkname)
        for member in links:
            if not (content / member.name).resolve(strict=True).is_relative_to(installed.resolve()):
                raise ValueError("bootstrap link escapes installation")
        os.rename(installed, destination)


if __name__ == "__main__":
    def timed_out(_signal, _frame):
        raise TimeoutError("bootstrap installation exceeded its deadline")
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(30 * 60)
    install(sys.argv[1], sys.argv[2])
