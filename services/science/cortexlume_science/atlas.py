from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .models import AtlasLabel
from .template_gate import sha256_file, template_directory


ATLAS_VERSION = "TemplateFlow-MNI152NLin6Asym-c906e8d_FSL-HarvardOxford-5.0"
ATLAS_SHA256 = "8591df9e9b37df27748d5ae3c8ca0478201834bac8014950115ba46697c4f6d0"


@dataclass(frozen=True)
class AtlasStatus:
    available: bool
    issue: str | None = None


@lru_cache(maxsize=1)
def _archive() -> dict[str, np.ndarray]:
    path = template_directory() / "generated" / "harvard_oxford_top3_1mm.npz"
    with np.load(path, allow_pickle=False) as archive:
        return {name: archive[name] for name in archive.files}


@lru_cache(maxsize=1)
def atlas_status() -> AtlasStatus:
    try:
        path = template_directory() / "generated" / "harvard_oxford_top3_1mm.npz"
        if sha256_file(path) != ATLAS_SHA256:
            return AtlasStatus(False, "atlas_hash_mismatch")
        archive = _archive()
        expected = (182, 218, 182, 3)
        for name in ("cortical_indices", "cortical_probabilities", "subcortical_indices", "subcortical_probabilities"):
            if archive[name].shape != expected:
                return AtlasStatus(False, f"atlas_shape_mismatch:{name}")
        if not np.allclose(archive["affine"], np.array([
            [1, 0, 0, -91], [0, 1, 0, -126], [0, 0, 1, -72], [0, 0, 0, 1]
        ])):
            return AtlasStatus(False, "atlas_affine_mismatch")
        if int(archive["cortical_probabilities"].max()) != 100:
            return AtlasStatus(False, "cortical_probability_scale_invalid")
        if int(archive["subcortical_probabilities"].max()) != 100:
            return AtlasStatus(False, "subcortical_probability_scale_invalid")
        return AtlasStatus(True)
    except (FileNotFoundError, KeyError, ValueError, OSError) as error:
        return AtlasStatus(False, f"atlas_unavailable:{type(error).__name__}")


def query_probability_volume(
    point_ras_mm: tuple[float, float, float],
    kind: str,
    threshold: float = 0.0,
) -> list[AtlasLabel]:
    archive = _archive()
    inverse = np.linalg.inv(archive["affine"])
    voxel = np.rint(inverse @ np.array([*point_ras_mm, 1.0])).astype(int)[:3]
    shape = archive[f"{kind}_probabilities"].shape[:3]
    if np.any(voxel < 0) or np.any(voxel >= shape):
        return []
    indices = archive[f"{kind}_indices"][tuple(voxel)]
    probabilities = archive[f"{kind}_probabilities"][tuple(voxel)]
    labels = archive[f"{kind}_labels"]
    atlas_id = f"HOCPAL@{ATLAS_VERSION}" if kind == "cortical" else f"HOSPA@{ATLAS_VERSION}"
    results: list[AtlasLabel] = []
    for index, percentage in zip(indices, probabilities, strict=True):
        probability = float(percentage) / 100.0
        if int(index) == 255 or probability <= 0 or probability < threshold:
            continue
        results.append(AtlasLabel(
            atlas_id=atlas_id,
            label_en=str(labels[int(index)]).strip(),
            probability=probability,
        ))
    return results


def query_probability_path(
    points_ras_mm: list[tuple[float, float, float]],
    kind: str = "cortical",
    threshold: float = 0.0,
) -> list[AtlasLabel]:
    """Average atlas membership over the labeled voxels hit by a channel path."""
    totals: dict[tuple[str, str], float] = {}
    labeled_voxels = 0
    for point in points_ras_mm:
        labels = query_probability_volume(point, kind, 0.0)
        if not labels:
            continue
        labeled_voxels += 1
        for label in labels:
            key = (label.atlas_id, label.label_en)
            totals[key] = totals.get(key, 0.0) + label.probability
    if labeled_voxels == 0:
        return []
    return sorted((
        AtlasLabel(atlas_id=atlas_id, label_en=label, probability=total / labeled_voxels)
        for (atlas_id, label), total in totals.items()
        if total / labeled_voxels >= threshold
    ), key=lambda item: item.probability, reverse=True)[:3]
