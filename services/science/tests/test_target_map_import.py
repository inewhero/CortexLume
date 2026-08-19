from __future__ import annotations

import gzip
import struct

import numpy as np
import pytest

from cortexlume_science.target_map_import import (
    FSL_2MM_AFFINE,
    FSL_2MM_LAS_AFFINE,
    FSL_2MM_SHAPE,
    MNI2009C_AFFINE,
    MNI2009C_SHAPE,
    NATIVE_AFFINE,
    NATIVE_SHAPE,
    NiftiImportError,
    import_target_map,
    parse_nifti,
    process_target_map_import,
    validate_target_map,
)


def nifti_bytes(
    shape: tuple[int, ...] = FSL_2MM_SHAPE,
    affine: np.ndarray = FSL_2MM_AFFINE,
    *,
    units: int = 2,
    intent: int = 0,
    description: str = "NiMARE association z map",
    values: tuple[float, float] = (1.25, 3.75),
    gzip_file: bool = True,
) -> bytes:
    header = bytearray(352)
    struct.pack_into("<i", header, 0, 348)
    dimensions = [len(shape), *shape, *([1] * (7 - len(shape)))]
    struct.pack_into("<8h", header, 40, *dimensions)
    struct.pack_into("<h", header, 68, intent)
    struct.pack_into("<h", header, 70, 16)
    struct.pack_into("<h", header, 72, 32)
    spacing = [1.0, *[float(np.linalg.norm(affine[:3, axis])) for axis in range(3)], 1.0, 1.0, 1.0, 1.0]
    struct.pack_into("<8f", header, 76, *spacing)
    struct.pack_into("<f", header, 108, 352.0)
    header[123] = units
    header[148:148 + len(description)] = description.encode("ascii")
    struct.pack_into("<h", header, 254, 4)
    for row in range(3):
        struct.pack_into("<4f", header, 280 + row * 16, *affine[row])
    header[344:348] = b"n+1\0"
    data = np.zeros(shape, dtype="<f4", order="F")
    center = tuple(size // 2 for size in shape)
    widths = tuple(max(1, min(10, size // 4)) for size in shape)
    region = tuple(slice(center[axis] - widths[axis], center[axis] + widths[axis]) for axis in range(3))
    ramp = np.linspace(values[0], values[1], data[region].size, dtype=np.float32).reshape(data[region].shape)
    data[region] = ramp
    payload = bytes(header) + data.tobytes(order="F")
    return gzip.compress(payload) if gzip_file else payload


def codes(validation) -> set[str]:
    return {item.code for item in validation.diagnostics}


def test_accepts_exact_declared_fsl_legacy_grid() -> None:
    raw = nifti_bytes()
    validation, volume = validate_target_map(raw, "working_memory.nii.gz", "NeurosynthMNI152-2mm")
    assert validation.accepted
    assert volume is not None
    assert validation.recognized_space == "NeurosynthMNI152-2mm-CortexLume-RAS"
    assert codes(validation) == {"legacy_mni_identity_sampling"}


def test_accepts_original_fsl_las_grid_without_header_rewrite() -> None:
    raw = nifti_bytes(FSL_2MM_SHAPE, FSL_2MM_LAS_AFFINE)
    validation, volume = validate_target_map(raw, "association-test_z.nii.gz", "NeurosynthMNI152-2mm")
    assert validation.accepted
    assert validation.recognized_space == "NeurosynthMNI152-2mm-FSL-LAS"
    assert volume is not None
    assert np.array_equal(volume.affine, FSL_2MM_LAS_AFFINE)


def test_accepts_native_locked_grid() -> None:
    raw = nifti_bytes(NATIVE_SHAPE, NATIVE_AFFINE)
    validation, _ = validate_target_map(raw, "target_z.nii.gz", "MNI152NLin6Asym")
    assert validation.accepted
    assert codes(validation) == {"validated"}


def test_rejects_declared_space_that_does_not_match_header() -> None:
    validation, _ = validate_target_map(
        nifti_bytes(), "target_z.nii.gz", "MNI152NLin6Asym",
    )
    assert not validation.accepted
    assert {"grid_shape_mismatch", "grid_affine_mismatch"}.issubset(codes(validation))


def test_never_accepts_2009c_without_locked_transform() -> None:
    validation, _ = validate_target_map(
        nifti_bytes(MNI2009C_SHAPE, MNI2009C_AFFINE),
        "space-MNI152NLin2009cAsym_stat-z.nii.gz",
        "MNI152NLin2009cAsym",
    )
    assert not validation.accepted
    assert "official_transform_unavailable" in codes(validation)


@pytest.mark.parametrize("shape", [(91, 109, 91, 2), (91, 109, 91, 1)])
def test_rejects_four_dimensional_images_even_with_one_volume(shape: tuple[int, ...]) -> None:
    validation, _ = validate_target_map(
        nifti_bytes(shape, FSL_2MM_AFFINE), "timeseries.nii.gz", "NeurosynthMNI152-2mm",
    )
    assert not validation.accepted
    assert "image_must_be_3d" in codes(validation)


def test_rejects_atlas_and_integer_label_like_data() -> None:
    validation, _ = validate_target_map(
        nifti_bytes(description="Harvard Oxford label atlas", values=(1.0, 2.0)),
        "atlas_dseg.nii.gz", "NeurosynthMNI152-2mm",
    )
    assert not validation.accepted
    assert "label_atlas_rejected" in codes(validation)


def test_rejects_missing_units() -> None:
    validation, _ = validate_target_map(
        nifti_bytes(units=0), "target.nii.gz", "NeurosynthMNI152-2mm",
    )
    assert not validation.accepted
    assert "spatial_units_not_mm" in codes(validation)


def test_rejects_nan_values() -> None:
    raw = nifti_bytes(values=(float("nan"), 3.0), gzip_file=False)
    validation, _ = validate_target_map(raw, "target.nii", "NeurosynthMNI152-2mm")
    assert not validation.accepted
    assert "non_finite_values" in codes(validation)


def test_rejects_conflicting_qform_and_sform() -> None:
    raw = bytearray(nifti_bytes(gzip_file=False))
    struct.pack_into("<h", raw, 252, 1)
    validation, _ = validate_target_map(bytes(raw), "target.nii", "NeurosynthMNI152-2mm")
    assert not validation.accepted
    assert "conflicting_qform_sform" in codes(validation)


def test_rejects_talairach_or_native_subject_by_grid_mismatch() -> None:
    talairach_affine = FSL_2MM_AFFINE.copy()
    talairach_affine[0, 3] = -88.0
    validation, _ = validate_target_map(
        nifti_bytes(FSL_2MM_SHAPE, talairach_affine),
        "sub-01_space-Talairach_stat.nii.gz", "NeurosynthMNI152-2mm",
    )
    assert not validation.accepted
    assert "grid_affine_mismatch" in codes(validation)


def test_parser_rejects_cifti_and_split_nifti() -> None:
    with pytest.raises(NiftiImportError, match="cifti_not_supported"):
        parse_nifti(b"not-cifti", "map.dscalar.nii")
    raw = bytearray(nifti_bytes(gzip_file=False))
    raw[344:348] = b"ni1\0"
    with pytest.raises(NiftiImportError, match="two_file_nifti_not_supported"):
        parse_nifti(bytes(raw), "map.nii")


def test_maps_valid_volume_to_locked_cedalion_vertex_order() -> None:
    imported = import_target_map(
        nifti_bytes(), "working_memory_z.nii.gz", "NeurosynthMNI152-2mm", map_name="Working memory",
    )
    assert imported.vertex_count == 25_000
    assert imported.vertex_indices == sorted(set(imported.vertex_indices))
    assert len(imported.vertex_indices) == len(imported.values) > 0
    assert np.all(np.isfinite(imported.values))
    assert np.all(np.asarray(imported.values) > 0)
    assert imported.provenance["interpolation"] == "trilinear_to_cedalion_grid_then_weighted_mean_via_official_voxel_to_vertex_matrix"
    assert imported.provenance["mapSha256"] == imported.validation.sha256
    assert imported.provenance["sourceKind"] == "nifti-import"


def test_contract_result_is_sparse_positive_and_camel_cased() -> None:
    result = process_target_map_import(
        nifti_bytes(FSL_2MM_SHAPE, FSL_2MM_LAS_AFFINE),
        "association-test_z.nii.gz",
        "NeurosynthMNI152-2mm",
    )
    assert result["accepted"] is True
    assert result["recognizedSpace"] == "NeurosynthMNI152-2mm-FSL-LAS"
    assert result["map"]["vertexCount"] == 25_000
    indices = result["map"]["vertexIndices"]
    values = result["map"]["values"]
    assert indices == sorted(set(indices))
    assert len(indices) == len(values) > 0
    assert min(values) > 0
    assert result["map"]["provenance"]["targetSurface"] == "Cedalion-ICBM152-25k"
    assert all("action" not in item or isinstance(item["action"], str) for item in result["diagnostics"])
