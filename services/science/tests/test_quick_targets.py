from __future__ import annotations

import csv
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np

import cortexlume_science.quick_targets as quick_targets
from cortexlume_science.quick_targets import QuickTargetError, QuickTargetPack


FIXTURE = Path(__file__).parent / "fixtures" / "quick_targets"
RELEASE = Path(__file__).parents[3] / "assets" / "templates" / "MNI152NLin6Asym" / "generated" / "quick_targets"
VERTICES = RELEASE.parent / "brain_vertex_coordinates.csv"


def test_fixture_pack_is_explicit_and_integrity_gated() -> None:
    pack = QuickTargetPack(FIXTURE)
    provenance = pack.provenance()
    assert provenance["distributionRole"] == "test-fixture"
    assert provenance["space"] == "MNI152NLin6Asym"
    assert provenance["surface"]["vertexCount"] == 25_000
    assert provenance["qc"]["passed"] is True


def test_search_prefers_exact_term_and_supports_synonyms_typos_and_partial_tokens() -> None:
    pack = QuickTargetPack(FIXTURE)
    assert pack.search("working memory")[0]["id"] == "neurosynth:working-memory"
    assert pack.search("short-term memory")[0]["id"] == "neurosynth:working-memory"
    assert pack.search("linguistic")[0]["id"] == "neurosynth:language"
    assert pack.search("movement")[0]["id"] == "neurosynth:motor"
    assert pack.search("lang")[0]["id"] == "neurosynth:language"
    assert pack.search("langauge")[0]["id"] == "neurosynth:language"
    assert pack.search("workng memry")[0]["id"] == "neurosynth:working-memory"
    assert pack.search("not-a-term") == []


def test_release_exact_aliases_suppress_fuzzy_tail_results() -> None:
    pack = QuickTargetPack(RELEASE)
    assert [item["id"] for item in pack.search("olfaction")] == ["neurosynth:olfactory"]
    assert [item["id"] for item in pack.search("color-word interference")] == ["neurosynth:stroop"]


def test_release_exact_label_suppresses_alias_and_fuzzy_matches() -> None:
    pack = QuickTargetPack(RELEASE)
    results = pack.search("vision")
    assert [item["id"] for item in results] == ["neurosynth:vision"]


def test_get_returns_sparse_positive_sorted_unique_vertices() -> None:
    pack = QuickTargetPack(FIXTURE)
    result = pack.get("neurosynth:motor")
    assert result is not None
    indices = np.asarray(result["vertexIndices"])
    values = np.asarray(result["values"])
    assert result["vertexCount"] == 25_000
    assert len(indices) == len(values) > 0
    assert np.all(np.diff(indices) > 0)
    assert len(indices) == len(np.unique(indices))
    assert np.all(np.isfinite(values))
    assert np.all(values > 0)
    assert pack.get("missing") is None


def test_tampered_pack_is_rejected(monkeypatch) -> None:
    original = quick_targets._sha256
    monkeypatch.setattr(
        quick_targets,
        "_sha256",
        lambda path: "tampered" if path.name == "catalog.json" else original(path),
    )
    try:
        QuickTargetPack(FIXTURE)
    except QuickTargetError as error:
        assert str(error) == "quick_target_hash_mismatch:catalog.json"
    else:
        raise AssertionError("tampered pack passed its hash gate")


def test_catalog_map_digest_is_checked_against_sparse_slice(tmp_path: Path) -> None:
    broken = tmp_path / "quick_targets"
    shutil.copytree(FIXTURE, broken)
    catalog_path, manifest_path = broken / "catalog.json", broken / "manifest.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog[0]["mapSha256"] = "0" * 64
    catalog_path.write_text(json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"]["catalog.json"]["sha256"] = hashlib.sha256(catalog_path.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with np.testing.assert_raises_regex(QuickTargetError, "quick_target_map_hash_mismatch"):
        QuickTargetPack(broken)


def test_runtime_loader_blocks_fixture_without_explicit_test_gate(monkeypatch) -> None:
    monkeypatch.setenv("CORTEXLUME_QUICK_TARGET_DIR", str(FIXTURE))
    monkeypatch.delenv("CORTEXLUME_ALLOW_QUICK_TARGET_FIXTURE", raising=False)
    quick_targets.load_quick_target_pack.cache_clear()
    try:
        with np.testing.assert_raises_regex(QuickTargetError, "nonrelease_pack_blocked"):
            quick_targets.load_quick_target_pack()
    finally:
        quick_targets.load_quick_target_pack.cache_clear()


def test_fixture_pack_generation_is_byte_deterministic() -> None:
    # The checked fixture is rebuilt by the script in CI/release validation; this
    # assertion also documents that the compressed maps have a stable digest.
    expected = "b5ffd6fd01b1f1c9e1ef30d0fe3a2d4d979fd92285b647ff8f0b71bcf8f88f58"
    digest = hashlib.sha256((FIXTURE / "maps.npz").read_bytes()).hexdigest()
    assert digest == expected


def test_release_pack_is_locked_and_anatomically_oriented() -> None:
    expected_hashes = {
        "catalog.json": "4fb2d08ce9ce51fd2513735b14bc080a0e7d02ac024382de5a410ba1a4a4248b",
        "maps.npz": "81af86406777cd484d0b39c2cc6ad7219e2e25a22479b87eeb85d565494d1533",
        "manifest.json": "9ea3e0436882d95e345de0e25e45f2fab88c30a269969018a6b6a7d5ff522c0b",
    }
    for name, expected in expected_hashes.items():
        assert hashlib.sha256((RELEASE / name).read_bytes()).hexdigest() == expected

    pack = QuickTargetPack(RELEASE)
    assert pack.manifest["distributionRole"] == "release"
    assert pack.manifest["qc"]["passed"] is True
    assert pack.manifest["qc"]["candidateTermCount"] == 133
    assert pack.manifest["qc"]["termCount"] == 132
    assert pack.manifest["qc"]["excludedTargets"] == [{
        "domain": "Attention & Executive Control",
        "reason": "no-positive-FDR-surface-support",
        "studyCount": 290,
        "subdomain": "Awareness",
        "term": "awareness",
    }]
    assert sum(pack.manifest["qc"]["domainCounts"].values()) == 132
    assert pack.manifest["qc"]["mapSimilarity"]["pairs"] == []

    with VERTICES.open("r", encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))

    def peak_ras(target_id: str) -> tuple[float, float, float]:
        target = pack.get(target_id)
        assert target is not None
        peak = int(np.argmax(target["values"]))
        row = rows[target["vertexIndices"][peak]]
        return float(row["mni152_r"]), float(row["mni152_a"]), float(row["mni152_s"])

    language = pack.get("neurosynth:language")
    assert language is not None and language["target"]["laterality"] == "left"
    assert language["target"]["domain"] == "Language"
    assert pack.search("theory of mind")[0]["id"] == "neurosynth:mentalizing"
    assert peak_ras("neurosynth:language")[0] < -30
    assert peak_ras("neurosynth:visual")[1] < -75
    assert peak_ras("neurosynth:motor")[2] > 40
