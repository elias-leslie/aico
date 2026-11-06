"""Verify a signed root update before extracting or executing anything from it."""

from __future__ import annotations

import json
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import tomllib
from pathlib import Path, PurePosixPath

from host_steward import core


def policy():
    with (core.DATA_DIR / "installer.toml").open("rb") as handle:
        return tomllib.load(handle)


def migrate() -> None:
    """Copy valuable private files without displaying them; never replace enrolled material."""
    cfg = policy()["migration"]

    def copy(source: Path, target: Path, mode: int):
        if target.exists() or not source.exists():
            return
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source, target)
        target.chmod(mode)

    copy(Path(cfg["passkey_source"]), Path(cfg["passkey_target"]), 0o600)
    for token in Path(cfg["token_source"]).glob("*.token"):
        copy(token, Path(cfg["token_target"]) / token.name, 0o600)
    copy(Path(cfg["ledger_source"]), Path(cfg["ledger_target"]), 0o444)
    site = Path(cfg["site_target"])
    if not site.exists() and Path(cfg["site_source"]).exists():
        source = json.loads(Path(cfg["site_source"]).read_text())
        core.write_json(site, {"approve_host": source["urls"]["approve_host"]}, mode=0o644)


def install(archive: Path, signature: Path, key: Path, prefix: str, *, execute=subprocess.run, owner=0,
            receipt: Path | None = None) -> None:
    st = key.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != owner or st.st_mode & 0o022:
        raise ValueError("update pin must be a root-owned regular file, not writable by others")
    # Freeze both inputs before checking: the bytes extracted must be exactly the bytes verified.
    with tempfile.TemporaryDirectory(prefix="host-steward-update-") as folder:
        root = Path(folder)
        frozen, sig = root / "update.tar", root / "update.sig"
        frozen.write_bytes(archive.read_bytes())
        sig.write_bytes(signature.read_bytes())
        result = execute(["openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(key),
                          "-in", str(frozen), "-sigfile", str(sig)], capture_output=True, check=False)
        if result.returncode:
            raise ValueError("root update signature is invalid")
        with tarfile.open(frozen) as bundle:
            members = bundle.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                # Git archive includes the two parent directories. Nothing outside the one root package is accepted.
                parent = member.isdir() and str(path) + "/" in ("native/", prefix)
                if path.is_absolute() or ".." in path.parts or not (parent or member.name.startswith(prefix)):
                    raise ValueError("root update contains an unexpected path")
                if not (member.isfile() or member.isdir()):
                    raise ValueError("root update contains a link or special file")
            # git archive of a commit names it in the pax global header; it is inside the signed bytes.
            commit = bundle.pax_headers.get("comment", "")
            bundle.extractall(root / "source", filter="data")
        script = root / "source" / prefix / "install-root.sh"
        env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HS_SIGNATURE_VERIFIED": "1"}
        result = execute(["bash", str(script)], env=env, check=False)
        if result.returncode:
            raise ValueError("the signed root installer failed")
        result = execute(["systemctl", "--no-ask-password", "try-restart", "host-steward-grants.service"], check=False)
        if result.returncode:
            raise ValueError("the updated grants service could not restart")
        # The deploy reads this to install again only when the root sources changed since this commit.
        if receipt is not None:
            sha = commit if re.fullmatch(r"[0-9a-f]{40}", commit) else None
            core.write_json(receipt, {"sha": sha, "installed_at": time.time()}, mode=0o644)
