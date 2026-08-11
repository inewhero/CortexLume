"""Audit Cedalion ICBM152 geometry-to-MNI correspondence before registration.

This script never estimates a transform. It promotes the correspondence gate
only when the pinned archive, official vertex-MNI assets, target-grid embedding,
and brain-mask overlap all pass their declared tolerances.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.io import mmread


CEDALION_VERSION = "26.5.1"
CEDALION_URL = "https://doc.ibs.tu-berlin.de/cedalion/datasets/26.5.1/hm_icbm152.zip"
CEDALION_SHA256 = "91bb99709b6ceadd41674acc0db6cf26d70dccb57e41797b474aa9ce6aeed3e8"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def obj_vertices(path: Path) -> np.ndarray:
    vertices: list[list[float]] = []
    with path.open("r", encoding="utf-8", errors="strict") as stream:
        for line in stream:
            if line.startswith("v "):
                vertices.append([float(value) for value in line.split()[1:4]])
    result = np.asarray(vertices, dtype=np.float64)
    if result.ndim != 2 or result.shape[1] != 3:
        raise ValueError(f"No valid OBJ vertices in {path}")
    return result


def vertex_mni_table(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    required = {"vertex", "mni152_r", "mni152_a", "mni152_s"}
    if not rows or not required.issubset(rows[0]):
        raise ValueError(f"Missing required columns in {path}: {sorted(required)}")
    indices = np.asarray([int(row["vertex"]) for row in rows], dtype=np.int64)
    coordinates = np.asarray([
        [float(row["mni152_r"]), float(row["mni152_a"]), float(row["mni152_s"])]
        for row in rows
    ])
    return indices, coordinates


def residual_summary(values: np.ndarray) -> dict[str, float]:
    return {
        "meanMm": round(float(np.mean(values)), 6),
        "medianMm": round(float(np.median(values)), 6),
        "p95Mm": round(float(np.percentile(values, 95)), 6),
        "maxMm": round(float(np.max(values)), 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cedalion-dir", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument(
        "--target-template",
        type=Path,
        default=Path("assets/templates/MNI152NLin6Asym/upstream/tpl-MNI152NLin6Asym_res-01_desc-brain_mask.nii.gz"),
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    source = args.cedalion_dir.resolve()
    source_hash = sha256(args.source_archive.resolve()) if args.source_archive else None
    gray_image = nib.load(source / "mask_gray.nii")
    target_image = nib.load(args.target_template.resolve())
    indices, official_mni = vertex_mni_table(source / "brain_vertex_coordinates.csv")
    brain_vertices_ijk = obj_vertices(source / "mask_brain.obj")
    high_vertices_ijk = obj_vertices(source / "cortex_pial_high.obj")
    affine_mni = nib.affines.apply_affine(gray_image.affine, brain_vertices_ijk)

    index_integrity = bool(np.array_equal(indices, np.arange(len(indices))))
    comparable = len(indices) == len(brain_vertices_ijk) and index_integrity
    residuals = np.linalg.norm(official_mni - affine_mni, axis=1) if comparable else None
    fsaverage_indices: np.ndarray
    with (source / "brain_vertex_coordinates.csv").open("r", encoding="utf-8-sig", newline="") as stream:
        fsaverage_indices = np.asarray([
            int(row["fsaverage_vertex"]) for row in csv.DictReader(stream)
        ], dtype=np.int64)
    high_index_integrity = bool(
        len(fsaverage_indices) == len(indices)
        and len(np.unique(fsaverage_indices)) == len(fsaverage_indices)
        and np.all(fsaverage_indices >= 0)
        and np.all(fsaverage_indices < len(high_vertices_ijk))
    )
    high_residuals = np.linalg.norm(
        official_mni - nib.affines.apply_affine(gray_image.affine, high_vertices_ijk[fsaverage_indices]),
        axis=1,
    ) if high_index_integrity else None

    with gzip.open(source / "voxel_to_vertex_brain.mtx.gz", "rb") as stream:
        voxel_to_vertex = mmread(stream).tocoo()
    tissue_counts: dict[str, int] = {}
    tissue_masks: dict[str, np.ndarray] = {}
    tissue_union = np.zeros(gray_image.shape[:3], dtype=bool)
    for tissue_name, filename in {
        "gm": "mask_gray.nii", "wm": "mask_white.nii", "csf": "mask_csf.nii",
        "scalp": "mask_skin.nii", "skull": "mask_bone.nii",
    }.items():
        candidate = source / filename
        if not candidate.exists():
            continue
        tissue_mask = np.asanyarray(nib.load(candidate).dataobj) > 0
        tissue_masks[tissue_name] = tissue_mask
        tissue_counts[tissue_name] = int(np.count_nonzero(tissue_mask))
        tissue_union |= tissue_mask
    brain_union = np.logical_or.reduce([
        tissue_masks[name] for name in ("gm", "wm", "csf") if name in tissue_masks
    ])
    tissue_counts["brainUnion"] = int(np.count_nonzero(brain_union))
    tissue_counts["allTissueUnion"] = int(np.count_nonzero(tissue_union))
    tissue_counts["fullGrid"] = int(np.prod(gray_image.shape[:3]))
    matrix_shape = [int(value) for value in voxel_to_vertex.shape]
    matrix_voxel_axis = next((
        size for size in matrix_shape if size != len(indices)
    ), None) if len(indices) in matrix_shape else None
    matching_tissue_counts = [name for name, count in tissue_counts.items() if count == matrix_voxel_axis]

    same_grid = (
        gray_image.shape[:3] == target_image.shape[:3]
        and np.allclose(gray_image.affine, target_image.affine, atol=1e-6)
    )
    target_from_cedalion_voxel = np.linalg.inv(target_image.affine) @ gray_image.affine
    integer_voxel_embedding = (
        np.allclose(target_from_cedalion_voxel[:3, :3], np.eye(3), atol=1e-6)
        and np.allclose(
            target_from_cedalion_voxel[:3, 3],
            np.rint(target_from_cedalion_voxel[:3, 3]),
            atol=1e-6,
        )
    )
    cedalion_from_target_voxel = np.linalg.inv(gray_image.affine) @ target_image.affine

    def grid_inside(transform: np.ndarray, source_shape: tuple[int, ...], destination_shape: tuple[int, ...]) -> bool:
        corners = np.asarray(np.meshgrid(*[
            [0, size - 1] for size in source_shape
        ], indexing="ij")).reshape(3, -1).T
        embedded = nib.affines.apply_affine(transform, corners)
        return bool(
            np.all(embedded >= -1e-6)
            and np.all(embedded <= np.asarray(destination_shape) - 1 + 1e-6)
        )

    cedalion_inside_target = grid_inside(
        target_from_cedalion_voxel, gray_image.shape[:3], target_image.shape[:3]
    )
    target_inside_cedalion = grid_inside(
        cedalion_from_target_voxel, target_image.shape[:3], gray_image.shape[:3]
    )
    integer_grid_relation = integer_voxel_embedding and target_inside_cedalion
    brain_mask_dice: float | None = None
    if integer_grid_relation:
        offset = np.rint(cedalion_from_target_voxel[:3, 3]).astype(int)
        slices = tuple(
            slice(int(offset[axis]), int(offset[axis] + target_image.shape[axis]))
            for axis in range(3)
        )
        cedalion_brain_on_target = brain_union[slices]
        target_brain = np.asanyarray(target_image.dataobj) > 0
        intersection = int(np.count_nonzero(cedalion_brain_on_target & target_brain))
        denominator = int(np.count_nonzero(cedalion_brain_on_target) + np.count_nonzero(target_brain))
        brain_mask_dice = 2 * intersection / denominator if denominator else 0.0
    residuals_support_identity = bool(
        residuals is not None
        and high_residuals is not None
        and float(np.percentile(residuals, 95)) <= 0.5
        and float(np.percentile(high_residuals, 95)) <= 0.5
    )
    identity_candidate = (
        residuals_support_identity
        and integer_grid_relation
        and brain_mask_dice is not None
        and brain_mask_dice >= 0.95
    )
    identity_accepted = identity_candidate and source_hash == CEDALION_SHA256
    report = {
        "format": "cortexlume-cedalion-correspondence-qc",
        "formatVersion": 1,
        "source": {
            "name": "Cedalion ICBM152 head model",
            "version": CEDALION_VERSION,
            "url": CEDALION_URL,
            "sha256": source_hash,
            "sha256Verified": source_hash == CEDALION_SHA256 if source_hash else None,
        },
        "vertexMni": {
            "rows": len(indices),
            "brainObjVertices": len(brain_vertices_ijk),
            "sequentialVertexIndices": index_integrity,
            "directlyComparable": comparable,
            "affineResiduals": residual_summary(residuals) if residuals is not None else None,
            "highResolutionMesh": {
                "vertices": len(high_vertices_ijk),
                "uniqueMappedIndices": int(len(np.unique(fsaverage_indices))),
                "indexIntegrity": high_index_integrity,
                "mappedAffineResiduals": residual_summary(high_residuals) if high_residuals is not None else None,
            },
        },
        "voxelToVertex": {
            "shape": matrix_shape,
            "nonzeroEntries": int(voxel_to_vertex.nnz),
            "candidateTissueVoxelCounts": tissue_counts,
            "matrixVoxelAxis": matrix_voxel_axis,
            "matchingTissueCounts": matching_tissue_counts,
        },
        "targetGrid": {
            "cedalionShape": list(gray_image.shape[:3]),
            "targetShape": list(target_image.shape[:3]),
            "cedalionAffine": np.asarray(gray_image.affine).round(8).tolist(),
            "targetAffine": np.asarray(target_image.affine).round(8).tolist(),
            "numericallyIdentical": bool(same_grid),
            "targetFromCedalionVoxel": target_from_cedalion_voxel.round(8).tolist(),
            "cedalionFromTargetVoxel": cedalion_from_target_voxel.round(8).tolist(),
            "integerVoxelEmbedding": bool(integer_voxel_embedding),
            "cedalionInsideTarget": cedalion_inside_target,
            "targetInsideCedalion": target_inside_cedalion,
            "relation": "target_is_integer_subgrid_of_cedalion" if integer_grid_relation else "unresolved",
            "cedalionBrainVsTargetMaskDice": round(brain_mask_dice, 6) if brain_mask_dice is not None else None,
        },
        "decision": "identity_accepted" if identity_accepted else (
            "identity_candidate" if identity_candidate else "provenance_or_transform_required"
        ),
        "scienceGatePromoted": identity_accepted,
    }
    serialized = json.dumps(report, indent=2)
    print(serialized)
    if args.report:
        args.report.resolve().write_text(f"{serialized}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
