"""Record code/data/config SHAs for a run."""

from __future__ import annotations

import hashlib
import platform
import subprocess
import sys
from pathlib import Path

from .config import B, K1, PRIMARY_K, SEED
from .phase_a import write_json
from .run_phase_a import ROOT


def git_sha() -> str:
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT.parents[1]).decode().strip()


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def write_provenance(extra: dict | None = None) -> dict:
    repo = ROOT.parents[1]
    protocol = ROOT / 'PROTOCOL.json'
    blob = {
        'git_sha': git_sha(),
        'branch': subprocess.check_output(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd=repo).decode().strip(),
        'base_attempted': 'origin/master',
        'python': sys.version,
        'platform': platform.platform(),
        'seed': SEED,
        'k1': K1,
        'b': B,
        'primary_k': PRIMARY_K,
        'protocol_sha256': file_hash(protocol),
        'cwd': str(Path.cwd()),
        'extra': extra or {},
    }
    write_json(ROOT / 'results' / 'provenance.json', blob)
    return blob
