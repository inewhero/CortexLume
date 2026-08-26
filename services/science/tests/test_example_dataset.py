from __future__ import annotations

from pathlib import Path

from cortexlume_science.target_map_import import import_target_map, validate_target_map


ROOT = Path(__file__).resolve().parents[3]
NIFTI = ROOT / "examples" / "cases" / "05-nifti-functional-target" / "data" / "bilateral_visual_target_z.nii.gz"


def test_release_example_nifti_passes_strict_validation_and_surface_mapping() -> None:
    raw = NIFTI.read_bytes()
    validation, volume = validate_target_map(raw, NIFTI.name, "NeurosynthMNI152-2mm")
    assert validation.accepted
    assert volume is not None
    assert validation.recognized_space == "NeurosynthMNI152-2mm-CortexLume-RAS"
    imported = import_target_map(raw, NIFTI.name, "NeurosynthMNI152-2mm")
    assert imported.vertex_count == 25_000
    assert len(imported.vertex_indices) == len(imported.values) > 100
    assert imported.provenance["mapSha256"] == validation.sha256
