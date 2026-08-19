from __future__ import annotations

import importlib.util
import json
from copy import deepcopy
from pathlib import Path

import pytest
import numpy as np


ROOT = Path(__file__).parents[3]
PROFILE = ROOT / "config" / "quick-targets" / "default-v1.json"
SPEC = importlib.util.spec_from_file_location("build_quick_target_pack", ROOT / "scripts" / "build_quick_target_pack.py")
assert SPEC is not None and SPEC.loader is not None
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def test_generated_json_uses_checkout_stable_lf_bytes(tmp_path: Path) -> None:
    output = tmp_path / "manifest.json"
    BUILDER.write_json(output, {"label": "memory", "values": [1, 2, 3]})
    raw = output.read_bytes()
    assert raw.endswith(b"\n")
    assert b"\r\n" not in raw


def test_default_profile_is_versioned_balanced_and_alias_safe() -> None:
    profile, targets = BUILDER.load_profile(PROFILE)
    assert profile["profileId"] == "cortexlume-fnirs-curated-v1"
    assert len(targets) == 133
    domains = {metadata["domain"] for metadata in targets.values()}
    assert domains == {
        "Memory & Learning", "Attention & Executive Control", "Language", "Perception",
        "Sensorimotor", "Emotion & Social Cognition", "Reward & Decision", "Pain & Interoception",
    }
    assert all(metadata["subdomain"] for metadata in targets.values())


def test_profile_rejects_alias_that_is_another_target(tmp_path: Path) -> None:
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))
    profile["targets"][0]["aliases"].append(profile["targets"][1]["term"])
    broken = tmp_path / "broken-profile.json"
    broken.write_text(json.dumps(profile), encoding="utf-8")
    with pytest.raises(ValueError, match="conflicts with profile term"):
        BUILDER.load_profile(broken)


@pytest.mark.parametrize(
    ("section", "field"),
    [
        ("statistic", "name"),
        ("statistic", "sign"),
        ("statistic", "multipleComparisons"),
        ("statistic", "alpha"),
        ("generation", "nimareTagCommit"),
        ("generation", "vertexSampling"),
    ],
)
def test_reuse_gate_rejects_scientific_manifest_tampering(section: str, field: str) -> None:
    manifest = json.loads((ROOT / "assets" / "templates" / "MNI152NLin6Asym" / "generated" / "quick_targets" / "manifest.json").read_text(encoding="utf-8"))
    BUILDER.validate_reuse_scientific_manifest(manifest)
    tampered = deepcopy(manifest)
    tampered[section][field] = "tampered"
    with pytest.raises(ValueError, match="mismatch"):
        BUILDER.validate_reuse_scientific_manifest(tampered)


def test_reuse_gate_checks_qc_and_per_map_digest() -> None:
    pack = ROOT / "assets" / "templates" / "MNI152NLin6Asym" / "generated" / "quick_targets"
    manifest = json.loads((pack / "manifest.json").read_text(encoding="utf-8"))
    catalog = json.loads((pack / "catalog.json").read_text(encoding="utf-8"))
    with np.load(pack / "maps.npz", allow_pickle=False) as archive:
        indices, values, offsets = archive["vertex_indices"], archive["z_values"], archive["offsets"]
    BUILDER.validate_reuse_sparse_data(manifest, catalog, indices, values, offsets)
    failed_qc = deepcopy(manifest)
    failed_qc["qc"]["passed"] = False
    with pytest.raises(ValueError, match="recorded QC"):
        BUILDER.validate_reuse_sparse_data(failed_qc, catalog, indices, values, offsets)
    bad_catalog = deepcopy(catalog)
    bad_catalog[0]["mapSha256"] = "0" * 64
    with pytest.raises(ValueError, match="map digest mismatch"):
        BUILDER.validate_reuse_sparse_data(manifest, bad_catalog, indices, values, offsets)
