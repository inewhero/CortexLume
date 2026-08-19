"""Strict NIfTI statistical-map import for CortexLume functional targets.

The importer intentionally supports a small, declared set of volumetric spaces.
It does not guess a template from image dimensions and never estimates a
registration.  Continuous target values are sampled at Cedalion's official
25,000 MNI vertices only after the header, affine and data pass validation.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import math
import struct
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np

from .template_gate import sha256_file, template_directory


SourceSpace = Literal[
    "MNI152NLin6Asym",
    "NeurosynthMNI152-2mm",
    "MNI152NLin2009cAsym",
]

# The largest accepted grid is 182 × 218 × 182; even float64 data remain below
# 60 MB. This margin permits ordinary NIfTI extensions without allowing a
# malformed gzip member to consume workstation-scale memory.
MAX_COMPRESSED_BYTES = 128 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
MAX_VOXELS = 256_000_000
AFFINE_ATOL = 1e-4
VOXEL_TO_VERTEX_SHA256 = "049a3957ea351b65b20a37794e8801976afbf02ab77a3efe075b67166d904db6"
CEDALION_SHAPE = (193, 239, 263)
CEDALION_AFFINE = np.asarray([
    [1.0, 0.0, 0.0, -96.0],
    [0.0, 1.0, 0.0, -132.0],
    [0.0, 0.0, 1.0, -148.0],
    [0.0, 0.0, 0.0, 1.0],
])

NATIVE_SHAPE = (182, 218, 182)
NATIVE_AFFINE = np.asarray([
    [1.0, 0.0, 0.0, -91.0],
    [0.0, 1.0, 0.0, -126.0],
    [0.0, 0.0, 1.0, -72.0],
    [0.0, 0.0, 0.0, 1.0],
])
FSL_2MM_SHAPE = (91, 109, 91)
FSL_2MM_AFFINE = np.asarray([
    [2.0, 0.0, 0.0, -90.0],
    [0.0, 2.0, 0.0, -126.0],
    [0.0, 0.0, 2.0, -72.0],
    [0.0, 0.0, 0.0, 1.0],
])
FSL_2MM_LAS_AFFINE = np.asarray([
    [-2.0, 0.0, 0.0, 90.0],
    [0.0, 2.0, 0.0, -126.0],
    [0.0, 0.0, 2.0, -72.0],
    [0.0, 0.0, 0.0, 1.0],
])
MNI2009C_SHAPE = (193, 229, 193)
MNI2009C_AFFINE = np.asarray([
    [1.0, 0.0, 0.0, -96.0],
    [0.0, 1.0, 0.0, -132.0],
    [0.0, 0.0, 1.0, -78.0],
    [0.0, 0.0, 0.0, 1.0],
])

_DTYPES: dict[int, tuple[str, int]] = {
    2: ("u1", 8), 4: ("i2", 16), 8: ("i4", 32), 16: ("f4", 32),
    64: ("f8", 64), 256: ("i1", 8), 512: ("u2", 16), 768: ("u4", 32),
}


@dataclass(frozen=True)
class Diagnostic:
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    action: str | None = None

    def to_dict(self) -> dict:
        result = {"severity": self.severity, "code": self.code, "message": self.message}
        if self.action is not None:
            result["action"] = self.action
        return result


@dataclass(frozen=True)
class NiftiVolume:
    data: np.ndarray
    affine: np.ndarray
    shape: tuple[int, int, int]
    units: str
    intent_code: int
    datatype_code: int
    description: str
    endian: str


@dataclass(frozen=True)
class TargetMapValidation:
    accepted: bool
    declared_space: str
    recognized_space: str | None
    shape: tuple[int, ...] | None
    affine: list[list[float]] | None
    units: str | None
    value_min: float | None
    value_max: float | None
    nonzero_voxels: int | None
    sha256: str
    diagnostics: tuple[Diagnostic, ...]

    def to_dict(self) -> dict:
        return {
            "accepted": self.accepted,
            "declaredSpace": self.declared_space,
            "recognizedSpace": self.recognized_space,
            "shape": list(self.shape) if self.shape else None,
            "affine": self.affine,
            "units": self.units,
            "valueMin": self.value_min,
            "valueMax": self.value_max,
            "nonzeroVoxels": self.nonzero_voxels,
            "sha256": self.sha256,
            "diagnostics": [item.to_dict() for item in self.diagnostics],
        }


@dataclass(frozen=True)
class ImportedTargetMap:
    target: dict
    vertex_count: int
    vertex_indices: list[int]
    values: list[float]
    validation: TargetMapValidation
    provenance: dict

    def to_dict(self) -> dict:
        return {
            "target": self.target,
            "vertexCount": self.vertex_count,
            "vertexIndices": self.vertex_indices,
            "values": self.values,
            "provenance": self.provenance,
        }


class NiftiImportError(ValueError):
    pass


def _decode_text(value: bytes) -> str:
    return value.split(b"\0", 1)[0].decode("utf-8", errors="replace").strip()


def _read_payload(raw: bytes, filename: str) -> bytes:
    if len(raw) > MAX_COMPRESSED_BYTES:
        raise NiftiImportError("file_too_large")
    lower = filename.lower()
    if lower.endswith((".dscalar.nii", ".dtseries.nii", ".dlabel.nii", ".pscalar.nii", ".pconn.nii")):
        raise NiftiImportError("cifti_not_supported")
    if lower.endswith(".nii.gz"):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                payload = stream.read(MAX_UNCOMPRESSED_BYTES + 1)
        except (gzip.BadGzipFile, EOFError, OSError) as error:
            raise NiftiImportError("invalid_gzip") from error
        if len(payload) > MAX_UNCOMPRESSED_BYTES:
            raise NiftiImportError("decompressed_file_too_large")
        return payload
    if lower.endswith(".nii"):
        return raw
    raise NiftiImportError("unsupported_extension")


def _qform_affine(header: bytes, endian: str) -> np.ndarray:
    pixdim = struct.unpack_from(f"{endian}8f", header, 76)
    b, c, d = struct.unpack_from(f"{endian}3f", header, 256)
    x, y, z = struct.unpack_from(f"{endian}3f", header, 268)
    a_sq = 1.0 - (b * b + c * c + d * d)
    if a_sq < -1e-5:
        raise NiftiImportError("invalid_qform_quaternion")
    a = math.sqrt(max(0.0, a_sq))
    rotation = np.asarray([
        [a*a+b*b-c*c-d*d, 2*b*c-2*a*d, 2*b*d+2*a*c],
        [2*b*c+2*a*d, a*a+c*c-b*b-d*d, 2*c*d-2*a*b],
        [2*b*d-2*a*c, 2*c*d+2*a*b, a*a+d*d-c*c-b*b],
    ])
    spacing = np.asarray([pixdim[1], pixdim[2], pixdim[3] * (-1.0 if pixdim[0] < 0 else 1.0)])
    affine = np.eye(4)
    affine[:3, :3] = rotation @ np.diag(spacing)
    affine[:3, 3] = [x, y, z]
    return affine


def parse_nifti(raw: bytes, filename: str) -> NiftiVolume:
    payload = _read_payload(raw, filename)
    if len(payload) < 352:
        raise NiftiImportError("truncated_header")
    little = struct.unpack_from("<i", payload, 0)[0]
    big = struct.unpack_from(">i", payload, 0)[0]
    endian = "<" if little == 348 else ">" if big == 348 else ""
    if not endian:
        raise NiftiImportError("not_nifti1")
    magic = payload[344:348]
    if magic not in (b"n+1\0", b"ni1\0"):
        raise NiftiImportError("unsupported_nifti_magic")
    if magic == b"ni1\0":
        raise NiftiImportError("two_file_nifti_not_supported")

    dims = struct.unpack_from(f"{endian}8h", payload, 40)
    ndim = int(dims[0])
    if ndim != 3:
        raise NiftiImportError("image_must_be_3d")
    shape = tuple(int(value) for value in dims[1:4])
    if any(value <= 0 for value in shape) or math.prod(shape) > MAX_VOXELS:
        raise NiftiImportError("invalid_image_shape")
    datatype_code = struct.unpack_from(f"{endian}h", payload, 70)[0]
    bitpix = struct.unpack_from(f"{endian}h", payload, 72)[0]
    if datatype_code not in _DTYPES or _DTYPES[datatype_code][1] != bitpix:
        raise NiftiImportError("unsupported_datatype")
    vox_offset = struct.unpack_from(f"{endian}f", payload, 108)[0]
    if not math.isfinite(vox_offset) or vox_offset < 352 or int(vox_offset) != vox_offset:
        raise NiftiImportError("invalid_voxel_offset")

    qform_code = struct.unpack_from(f"{endian}h", payload, 252)[0]
    sform_code = struct.unpack_from(f"{endian}h", payload, 254)[0]
    sform_affine: np.ndarray | None = None
    qform_affine: np.ndarray | None = None
    if sform_code > 0:
        sform_affine = np.eye(4)
        sform_affine[:3] = np.asarray([
            struct.unpack_from(f"{endian}4f", payload, 280 + row * 16)
            for row in range(3)
        ])
    if qform_code > 0:
        qform_affine = _qform_affine(payload, endian)
    if sform_affine is not None and qform_affine is not None and not np.allclose(
        sform_affine, qform_affine, rtol=0, atol=1e-3,
    ):
        raise NiftiImportError("conflicting_qform_sform")
    affine = sform_affine if sform_affine is not None else qform_affine
    if affine is None:
        raise NiftiImportError("missing_spatial_transform")
    if not np.all(np.isfinite(affine)) or abs(float(np.linalg.det(affine[:3, :3]))) < 1e-8:
        raise NiftiImportError("invalid_affine")

    xyzt_units = payload[123]
    spatial_unit = xyzt_units & 0x07
    units = {1: "m", 2: "mm", 3: "um"}.get(spatial_unit, "unknown")
    dtype = np.dtype(f"{endian}{_DTYPES[datatype_code][0]}")
    count = math.prod(shape)
    end = int(vox_offset) + count * dtype.itemsize
    if end > len(payload):
        raise NiftiImportError("truncated_image_data")
    data = np.frombuffer(payload, dtype=dtype, count=count, offset=int(vox_offset)).reshape(shape, order="F")
    slope = struct.unpack_from(f"{endian}f", payload, 112)[0]
    intercept = struct.unpack_from(f"{endian}f", payload, 116)[0]
    if not math.isfinite(slope) or not math.isfinite(intercept):
        raise NiftiImportError("invalid_scaling")
    slope = 1.0 if slope == 0 else float(slope)
    intercept = float(intercept)
    data = data.astype(np.float32) * slope + intercept
    if not np.all(np.isfinite(data)):
        raise NiftiImportError("non_finite_values")
    return NiftiVolume(
        data=data, affine=affine, shape=shape, units=units,
        intent_code=struct.unpack_from(f"{endian}h", payload, 68)[0],
        datatype_code=datatype_code, description=_decode_text(payload[148:228]), endian=endian,
    )


def _expected_grid(space: SourceSpace) -> tuple[tuple[int, int, int], tuple[np.ndarray, ...]]:
    if space == "MNI152NLin6Asym":
        return NATIVE_SHAPE, (NATIVE_AFFINE,)
    if space == "NeurosynthMNI152-2mm":
        return FSL_2MM_SHAPE, (FSL_2MM_LAS_AFFINE, FSL_2MM_AFFINE)
    return MNI2009C_SHAPE, (MNI2009C_AFFINE,)


def _looks_like_label_image(volume: NiftiVolume, filename: str) -> bool:
    text = f"{filename} {volume.description}".lower()
    if volume.intent_code in (1002, 1003, 1004, 1005):
        return True
    if any(token in text for token in ("dseg", "atlas", "label", "parcellation", "segmentation")):
        return True
    nonzero = volume.data[volume.data != 0]
    if not nonzero.size:
        return False
    sample = nonzero if nonzero.size <= 1_000_000 else nonzero[::max(1, nonzero.size // 1_000_000)]
    return bool(
        np.allclose(sample, np.rint(sample), atol=1e-6)
        and np.unique(sample).size <= 256
        and float(np.max(np.abs(sample))) <= 4096
    )


def validate_target_map(
    raw: bytes,
    filename: str,
    declared_space: SourceSpace,
    *,
    mni2009c_transform: Path | None = None,
) -> tuple[TargetMapValidation, NiftiVolume | None]:
    digest = hashlib.sha256(raw).hexdigest()
    diagnostics: list[Diagnostic] = []
    try:
        volume = parse_nifti(raw, filename)
    except NiftiImportError as error:
        diagnostic = Diagnostic("error", str(error), _parse_error_message(str(error)), _parse_error_action(str(error)))
        return TargetMapValidation(False, declared_space, None, None, None, None, None, None, None, digest, (diagnostic,)), None

    expected_shape, expected_affines = _expected_grid(declared_space)
    shape_ok = volume.shape == expected_shape
    matching_affine = next((
        index for index, candidate in enumerate(expected_affines)
        if np.allclose(volume.affine, candidate, rtol=0, atol=AFFINE_ATOL)
    ), None)
    affine_ok = matching_affine is not None
    recognized_space = declared_space if shape_ok and affine_ok else None
    if declared_space == "NeurosynthMNI152-2mm" and affine_ok:
        recognized_space = "NeurosynthMNI152-2mm-FSL-LAS" if matching_affine == 0 else "NeurosynthMNI152-2mm-CortexLume-RAS"
    if not shape_ok:
        diagnostics.append(Diagnostic(
            "error", "grid_shape_mismatch",
            f"Declared {declared_space} requires shape {expected_shape}; file is {volume.shape}.",
            "Export or resample the statistical map in the selected template before import.",
        ))
    if not affine_ok:
        diagnostics.append(Diagnostic(
            "error", "grid_affine_mismatch",
            f"The voxel-to-RAS affine does not match the locked {declared_space} grid.",
            "Do not edit the header alone; resample from the source image with its valid transform.",
        ))
    if volume.units != "mm":
        diagnostics.append(Diagnostic(
            "error", "spatial_units_not_mm", f"Spatial units are {volume.units}, not millimetres.",
            "Export a NIfTI whose xyzt_units declares millimetres.",
        ))
    if np.count_nonzero(volume.data) == 0:
        diagnostics.append(Diagnostic("error", "empty_map", "The image contains no non-zero target values.", "Choose a thresholded or unthresholded statistical map with non-zero values."))
    if _looks_like_label_image(volume, filename):
        diagnostics.append(Diagnostic(
            "error", "label_atlas_rejected", "This appears to be a label atlas or segmentation, not a continuous statistical target map.",
            "Import a z-, t-, probability-, or effect-size map produced by Compose, NeuroVault, SPM, FSL, or NiMARE.",
        ))
    if declared_space == "MNI152NLin2009cAsym":
        if mni2009c_transform is None or not mni2009c_transform.is_file():
            diagnostics.append(Diagnostic(
                "error", "official_transform_unavailable",
                "MNI152NLin2009cAsym requires CortexLume's locked official transform to MNI152NLin6Asym.",
                "Install the verified TemplateFlow transform asset, or export the map directly in MNI152NLin6Asym.",
            ))
        else:
            diagnostics.append(Diagnostic(
                "error", "transform_application_not_configured",
                "A transform path was supplied, but this build has no verified transform execution manifest.",
                "Use a CortexLume build that pins the transform file, tool, interpolation and output hash.",
            ))
    if declared_space == "NeurosynthMNI152-2mm" and shape_ok and affine_ok:
        diagnostics.append(Diagnostic(
            "warning", "legacy_mni_identity_sampling",
            "The exact FSL/legacy Neurosynth 2 mm MNI152 grid will be sampled directly in MNI152NLin6Asym coordinates.",
            "For a publication-specific map, retain the source database version and map identifier in your project notes.",
        ))
    if not diagnostics:
        diagnostics.append(Diagnostic("info", "validated", "Header, data, units, orientation and locked template grid are valid."))

    errors = any(item.severity == "error" for item in diagnostics)
    nonzero = volume.data[volume.data != 0]
    validation = TargetMapValidation(
        not errors, declared_space, recognized_space,
        volume.shape, volume.affine.round(7).tolist(), volume.units,
        float(np.min(volume.data)), float(np.max(volume.data)), int(nonzero.size), digest,
        tuple(diagnostics),
    )
    return validation, volume


def _parse_error_message(code: str) -> str:
    return {
        "unsupported_extension": "Only single-file .nii and .nii.gz images are accepted.",
        "cifti_not_supported": "CIFTI and fsaverage surface files are not accepted by the volumetric target importer.",
        "image_must_be_3d": "Target maps must be exactly 3D; time series and multi-volume images are not accepted.",
        "missing_spatial_transform": "The image has no valid qform or sform spatial transform.",
        "conflicting_qform_sform": "The qform and sform describe conflicting spatial coordinates.",
        "invalid_scaling": "The NIfTI scaling fields are non-finite.",
        "non_finite_values": "The image contains NaN or infinite values.",
        "unsupported_datatype": "The NIfTI datatype is not a supported real-valued scalar type.",
        "file_too_large": "The compressed file exceeds the safe import limit.",
        "decompressed_file_too_large": "The decompressed image exceeds the safe import limit.",
    }.get(code, f"The NIfTI file failed validation ({code}).")


def _parse_error_action(code: str) -> str:
    if code == "image_must_be_3d":
        return "Select one statistical contrast volume before export."
    if code in ("missing_spatial_transform", "conflicting_qform_sform"):
        return "Re-export from the analysis tool while preserving qform/sform metadata."
    if code == "non_finite_values":
        return "Replace or mask non-finite voxels in the source workflow, then export again."
    if code == "cifti_not_supported":
        return "Export a 3D NIfTI statistical volume in one of the supported MNI templates."
    return "Re-export a valid NIfTI-1 single-file image from the source workflow."


def _load_vertex_mni() -> np.ndarray:
    path = template_directory() / "generated" / "brain_vertex_coordinates.csv"
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    if len(rows) != 25_000:
        raise RuntimeError("vertex_correspondence_count_mismatch")
    indices = np.asarray([int(row["vertex"]) for row in rows])
    if not np.array_equal(indices, np.arange(25_000)):
        raise RuntimeError("vertex_correspondence_order_mismatch")
    vertices = np.asarray([
        [float(row["mni152_r"]), float(row["mni152_a"]), float(row["mni152_s"])]
        for row in rows
    ])
    if not np.all(np.isfinite(vertices)):
        raise RuntimeError("vertex_correspondence_non_finite")
    return vertices


@lru_cache(maxsize=1)
def _load_voxel_to_vertex() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    path = template_directory() / "generated" / "voxel_to_vertex_brain.mtx.gz"
    if sha256_file(path) != VOXEL_TO_VERTEX_SHA256:
        raise RuntimeError("voxel_to_vertex_hash_mismatch")
    with gzip.open(path, "rt", encoding="ascii") as stream:
        if stream.readline().strip() != "%%MatrixMarket matrix coordinate real general":
            raise RuntimeError("voxel_to_vertex_header_mismatch")
        line = stream.readline()
        while line.startswith("%"):
            line = stream.readline()
        rows, columns, entries = (int(value) for value in line.split())
        if (rows, columns, entries) != (math.prod(CEDALION_SHAPE), 25_000, 614_935):
            raise RuntimeError("voxel_to_vertex_shape_mismatch")
        table = np.loadtxt(stream, dtype=np.float64)
    if table.shape != (entries, 3):
        raise RuntimeError("voxel_to_vertex_entry_count_mismatch")
    voxel_indices = table[:, 0].astype(np.int64) - 1
    vertex_indices = table[:, 1].astype(np.int32) - 1
    weights = table[:, 2].astype(np.float32)
    if (
        np.any(voxel_indices < 0) or np.any(voxel_indices >= rows)
        or np.any(vertex_indices < 0) or np.any(vertex_indices >= columns)
        or not np.all(np.isfinite(weights)) or np.any(weights <= 0)
    ):
        raise RuntimeError("voxel_to_vertex_values_invalid")
    return voxel_indices, vertex_indices, weights


def _trilinear_sample(volume: NiftiVolume, points_ras_mm: np.ndarray) -> np.ndarray:
    inverse = np.linalg.inv(volume.affine)
    voxels = (inverse @ np.column_stack((points_ras_mm, np.ones(len(points_ras_mm)))).T).T[:, :3]
    base = np.floor(voxels).astype(np.int64)
    fraction = voxels - base
    values = np.zeros(len(points_ras_mm), dtype=np.float32)
    valid = np.all(base >= 0, axis=1) & np.all(base + 1 < np.asarray(volume.shape), axis=1)
    valid_indices = np.flatnonzero(valid)
    if not valid_indices.size:
        return values
    b = base[valid]
    f = fraction[valid]
    result = np.zeros(len(valid_indices), dtype=np.float64)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                weight = (
                    (f[:, 0] if dx else 1 - f[:, 0])
                    * (f[:, 1] if dy else 1 - f[:, 1])
                    * (f[:, 2] if dz else 1 - f[:, 2])
                )
                result += weight * volume.data[b[:, 0] + dx, b[:, 1] + dy, b[:, 2] + dz]
    values[valid_indices] = result.astype(np.float32)
    return values


def _map_volume_to_cedalion_surface(volume: NiftiVolume) -> np.ndarray:
    voxel_indices, vertex_indices, weights = _load_voxel_to_vertex()
    plane = CEDALION_SHAPE[1] * CEDALION_SHAPE[2]
    i = voxel_indices // plane
    remainder = voxel_indices % plane
    j = remainder // CEDALION_SHAPE[2]
    k = remainder % CEDALION_SHAPE[2]
    points = np.column_stack((i - 96.0, j - 132.0, k - 148.0))
    voxel_values = _trilinear_sample(volume, points)
    numerator = np.bincount(
        vertex_indices, weights=voxel_values.astype(np.float64) * weights, minlength=25_000,
    )
    denominator = np.bincount(vertex_indices, weights=weights, minlength=25_000)
    result = np.zeros(25_000, dtype=np.float32)
    populated = denominator > 0
    result[populated] = (numerator[populated] / denominator[populated]).astype(np.float32)
    return result


def import_target_map(
    raw: bytes,
    filename: str,
    declared_space: SourceSpace,
    *,
    map_name: str | None = None,
    target_id: str | None = None,
    description: str | None = None,
    statistic: str = "continuous-statistic",
    mni2009c_transform: Path | None = None,
) -> ImportedTargetMap:
    validation, volume = validate_target_map(
        raw, filename, declared_space, mni2009c_transform=mni2009c_transform,
    )
    if not validation.accepted or volume is None:
        raise NiftiImportError("target_map_validation_failed")
    # Verify both official correspondence assets. The sparse matrix columns use
    # this exact sequential vertex order; its rows use Cedalion's C-order grid.
    vertices = _load_vertex_mni()
    vertex_values = _map_volume_to_cedalion_surface(volume)
    keep = np.flatnonzero(np.isfinite(vertex_values) & (vertex_values > 0))
    if not keep.size:
        raise NiftiImportError("no_positive_values_on_cortical_surface")
    indices = keep.astype(int).tolist()
    values = vertex_values[keep].astype(float).tolist()
    if indices != sorted(set(indices)):
        raise RuntimeError("surface_vertex_index_invariant_failed")
    label = map_name or Path(filename.removesuffix(".gz")).stem
    provenance = {
        "sourceKind": "nifti-import",
        "sourceSpace": declared_space,
        "statistic": statistic,
        "fileName": Path(filename).name,
        "mapSha256": validation.sha256,
        "validation": validation.to_dict(),
        "sourceShape": list(volume.shape),
        "sourceAffine": volume.affine.round(7).tolist(),
        "sourceUnits": volume.units,
        "interpolation": "trilinear_to_cedalion_grid_then_weighted_mean_via_official_voxel_to_vertex_matrix",
        "targetSpace": "MNI152NLin6Asym",
        "targetSurface": "Cedalion-ICBM152-25k",
        "transform": "identity" if declared_space == "MNI152NLin6Asym" else "legacy_mni_coordinate_sampling",
    }
    target = {
        "id": target_id or f"nifti:{validation.sha256[:16]}",
        "label": label,
    }
    positive_values = np.maximum(vertex_values, 0)
    left = float(np.sum(positive_values[vertices[:, 0] < -2]))
    right = float(np.sum(positive_values[vertices[:, 0] > 2]))
    total = left + right
    target["laterality"] = (
        "bilateral" if total <= 0 or abs(left - right) / total < 0.2
        else "left" if left > right else "right"
    )
    if description:
        target["description"] = description
    return ImportedTargetMap(target, 25_000, indices, values, validation, provenance)


def process_target_map_import(
    raw: bytes,
    filename: str,
    declared_space: SourceSpace,
) -> dict:
    """Return the exact renderer/IPC import contract, including blocked results."""
    validation, _ = validate_target_map(raw, filename, declared_space)
    result = validation.to_dict()
    result["map"] = None
    if not validation.accepted:
        return result
    try:
        imported = import_target_map(raw, filename, declared_space)
    except NiftiImportError as error:
        result["accepted"] = False
        result["diagnostics"].append(Diagnostic(
            "error", str(error),
            "The validated volume has no positive values on the correspondence-backed cortical surface.",
            "Check the contrast sign, threshold and cortical coverage, then export the intended positive target map.",
        ).to_dict())
        return result
    result["map"] = imported.to_dict()
    return result
