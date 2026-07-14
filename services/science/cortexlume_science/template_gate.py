from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TemplateGate:
    passed: bool
    issues: tuple[str, ...]
    manifest: dict


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def template_directory() -> Path:
    configured = os.environ.get("CORTEXLUME_ASSET_DIR")
    if configured:
        return Path(configured).resolve()
    return repository_root() / "assets" / "templates" / "MNI152NLin6Asym"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_template_gate() -> TemplateGate:
    manifest_path = template_directory() / "manifest.json"
    if not manifest_path.exists():
        return TemplateGate(False, ("template_manifest_missing",), {})
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    issues: list[str] = []
    if manifest.get("spaceId") != "MNI152NLin6Asym":
        issues.append("unexpected_space_id")
    if not manifest.get("verified", False):
        issues.append("manifest_not_verified")
    if not manifest.get("scienceGate", {}).get("passed", False):
        issues.append("science_gate_not_passed")
    for name, record in manifest.get("files", {}).items():
        if isinstance(record, dict):
            relative_path = record.get("path", name)
            expected_hash = record.get("sha256")
        else:
            relative_path = name
            expected_hash = record
        asset = template_directory() / relative_path
        if not asset.exists():
            issues.append(f"missing_asset:{relative_path}")
        elif expected_hash and expected_hash != sha256_file(asset):
            issues.append(f"hash_mismatch:{name}")
    return TemplateGate(not issues, tuple(issues), manifest)
