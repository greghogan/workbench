"""Offline extraction cases; OpenPGP itself is covered by real signature fixtures in Vitest."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bootstrap", sys.argv.pop(1))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
SIGNER = "A" * 40


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        for name, content, target in entries:
            member = tarfile.TarInfo(name)
            member.mode = 0o755
            if target is not None:
                member.type, member.linkname = tarfile.SYMTYPE, target
                tar.addfile(member)
            else:
                data = content.encode()
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
    return gzip.compress(output.getvalue())


class BootstrapCases(unittest.TestCase):
    def install(self, entries, wrong_digest=False, wrong_catalog=False, signer=SIGNER, expect=None):
        with tempfile.TemporaryDirectory(prefix="workbench-bootstrap-cases-") as root:
            root = Path(root)
            bytes_ = archive(entries)
            digest = "0" * 64 if wrong_digest else hashlib.sha256(bytes_).hexdigest()
            asset = {"url": "https://tools.example/node.tar.gz", "sha256": digest,
                     "checksums": {"url": "https://tools.example/sums", "subject": "node.tar.gz",
                                   "signature": {"url": "https://tools.example/sig", "keys": "node.asc", "signers": [SIGNER]}}}
            path = root / "asset.json"
            path.write_text(json.dumps(asset))
            sums = f"{'f' * 64 if wrong_catalog else digest}  node.tar.gz\n".encode()
            def response(url, timeout):
                return io.BytesIO(sums if url.endswith("sums") else b"proof" if url.endswith("sig") else bytes_)
            def verifier(command, **kwargs):
                return subprocess.CompletedProcess(command, 0, f"[GNUPG:] VALIDSIG {signer} 2026-10-09 1 0 4 0 1 8 00 {signer}\n".encode())
            with patch.object(bootstrap.opener, "open", side_effect=response), patch.object(bootstrap.subprocess, "run", side_effect=verifier):
                if expect:
                    with self.assertRaises(expect):
                        bootstrap.install(path, root / "installed")
                    self.assertFalse((root / "installed").exists())
                else:
                    bootstrap.install(path, root / "installed")
                    self.assertEqual((root / "installed/bin/node").read_text(), "runtime")
                    self.assertEqual((root / "installed/bin/alias").read_text(), "runtime")
            self.assertFalse(any(p.name.startswith(".node-bootstrap-") for p in root.iterdir()))

    def test_valid_runtime_and_deferred_alias(self):
        self.install([("node/bin/alias", "", "node"), ("node/bin/node", "runtime", None)])

    def test_wrong_incoming_digest(self):
        self.install([("node/bin/node", "runtime", None)], wrong_digest=True, expect=ValueError)

    def test_unapproved_signer(self):
        self.install([("node/bin/node", "runtime", None)], signer="B" * 40, expect=ValueError)

    def test_wrong_catalog_digest(self):
        self.install([("node/bin/node", "runtime", None)], wrong_catalog=True, expect=ValueError)

    def test_absolute_path(self):
        self.install([("/absolute", "bad", None)], expect=ValueError)

    def test_traversal(self):
        self.install([("node/bin/node", "runtime", None), ("node/../../escaped", "bad", None)], expect=ValueError)

    def test_escaping_deferred_link(self):
        self.install([("node/bin/node", "runtime", None), ("node/bin/alias", "", "../../../asset.json")], expect=ValueError)

    def test_link_cannot_be_another_link_parent(self):
        self.install([("node/bin/node", "runtime", None), ("node/bin/alias", "", "node"), ("node/bin/alias/child", "", "../node")], expect=ValueError)

    def test_duplicate_path(self):
        self.install([("node/bin/node", "runtime", None), ("node/bin/node", "other", None)], expect=ValueError)

    def test_missing_runtime(self):
        self.install([("node/bin/other", "runtime", None)], expect=ValueError)

    def test_decompressed_limit_includes_discarded_padding(self):
        reader = bootstrap.Input(io.BytesIO(b"x" * 100), 10)
        with self.assertRaises(ValueError):
            reader.read(100)

    def test_insecure_redirect(self):
        with self.assertRaises(ValueError):
            bootstrap.HTTPSRedirects().redirect_request(None, None, 302, "", {}, "http://tools.example")

    def test_raw_header_size_limit(self):
        header = bytearray(512)
        header[124:136] = b"77777777777\0"
        header[156] = ord("0")
        with self.assertRaises(ValueError):
            bootstrap.Input(io.BytesIO(header), 1024, guard=True).read()

    def test_raw_header_runtime_size_and_exact_boundary(self):
        for size in [144 * 1024 ** 2, bootstrap.MAX_ENTRY_BYTES]:
            with self.subTest(size=size):
                header = bytearray(512)
                header[124:136] = f"{size:011o}\0".encode()
                header[156] = ord("0")
                self.assertEqual(bootstrap.Input(io.BytesIO(header), 1024, guard=True).read(), header)

    def test_raw_header_just_above_boundary(self):
        header = bytearray(512)
        header[124:136] = f"{bootstrap.MAX_ENTRY_BYTES + 1:011o}\0".encode()
        header[156] = ord("0")
        with self.assertRaises(ValueError):
            bootstrap.Input(io.BytesIO(header), 1024, guard=True).read()

    def test_raw_metadata_size_limit(self):
        header = bytearray(512)
        header[124:136] = b"00001000000\0"
        header[156] = ord("x")
        with self.assertRaises(ValueError):
            bootstrap.Input(io.BytesIO(header), 1024, guard=True).read()

    def test_sparse_logical_size_cannot_bypass_stream_limits(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as tar:
            member = tarfile.TarInfo("node/bin/node")
            member.size = 1
            member.pax_headers = {"GNU.sparse.size": str(1024 ** 4), "GNU.sparse.map": "0,1"}
            tar.addfile(member, io.BytesIO(b"x"))
        with patch.object(sys.modules[__name__], "archive", return_value=gzip.compress(output.getvalue())):
            self.install([], expect=ValueError)


unittest.main()
