"""Geometric anatomical coverage on the locked Cedalion 25k surface.

This module deliberately does not model photon transport. It turns sampled
channel polylines into a bounded geometric kernel, then combines that kernel
with the original Harvard-Oxford cortical atlas memberships. The result is a
surface mosaic for visual placement review, not sensitivity, fluence, a
Jacobian, or a measurement probability.
"""

from __future__ import annotations

import csv
import colorsys
import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from .atlas import ATLAS_SHA256, CORTICAL_ATLAS_ID, cortical_probability_fields
from .coverage_limits import ANATOMICAL_COVERAGE_LIMITS, coverage_limit_error
from .models import (
    AnatomicalCoverageAnalysis,
    AnatomicalCoverageChannel,
    AnatomicalCoverageChannelResult,
    AnatomicalCoverageChannelShare,
    AnatomicalCoverageMosaic,
    AnatomicalCoverageParameters,
    AnatomicalCoverageProvenance,
    AnatomicalCoverageQc,
    AnatomicalCoverageRegion,
    AnatomicalCoverageRequest,
)
from .template_gate import inspect_template_gate, sha256_file, template_directory


VERTEX_COUNT = 25_000
TARGET_SURFACE = "Cedalion-ICBM152-25k"
TEMPLATE_ASSET_VERSION = "templateflow-c906e8d_cedalion-icbm152-26.5.1"
VERTEX_COORDINATES_SHA256 = "8b5c0e45f58f0e5741b6d16dc6cfcb73d9014fe923eee1d7474b86d3f0e5b92c"
SURFACE_MESH_SHA256 = "e4c9033a515fd7693eb07fb80708509352b7f8044f860e690acf52cbc98119f1"
SURFACE_ATLAS_SHA256 = "907d882dfe58d297e9510526fd6eb3a10ebb4d098f8c755362b4e7bb7c3eedab"


class AnatomicalCoverageError(RuntimeError):
    """Raised when a coverage request or one of its locked assets is invalid."""


@lru_cache(maxsize=1)
def load_full_surface_atlas() -> tuple[np.ndarray, tuple[str, ...]]:
    path = template_directory() / "generated" / "harvard_oxford_cortical_surface_25k.npz"
    if sha256_file(path) != SURFACE_ATLAS_SHA256:
        raise AnatomicalCoverageError("coverage_full_surface_atlas_hash_mismatch")
    try:
        with np.load(path, allow_pickle=False) as archive:
            memberships = np.asarray(archive["memberships"], dtype=np.uint8)
            labels = tuple(str(label).strip() for label in archive["labels"])
    except (OSError, KeyError, ValueError) as error:
        raise AnatomicalCoverageError(f"coverage_full_surface_atlas_unavailable:{type(error).__name__}") from error
    if memberships.shape != (VERTEX_COUNT, len(labels)) or not labels:
        raise AnatomicalCoverageError("coverage_full_surface_atlas_shape_mismatch")
    if int(memberships.max()) != 100:
        raise AnatomicalCoverageError("coverage_full_surface_atlas_scale_invalid")
    return memberships, labels


def list_cortical_regions() -> tuple[str, ...]:
    return load_full_surface_atlas()[1]


def cortical_region_target(label: str) -> dict:
    memberships, labels = load_full_surface_atlas()
    matches = [index for index, candidate in enumerate(labels) if candidate.casefold() == label.strip().casefold()]
    if not matches:
        raise AnatomicalCoverageError("unknown_harvard_oxford_cortical_region")
    values_all = memberships[:, matches[0]].astype(np.float64) / 100.0
    indices = np.flatnonzero(values_all > 0).astype(np.int64)
    values = values_all[indices]
    if indices.size == 0:
        raise AnatomicalCoverageError("harvard_oxford_cortical_region_is_empty")
    digest = hashlib.sha256()
    digest.update(indices.astype("<i4").tobytes())
    digest.update(values.astype("<f4").tobytes())
    canonical_label = labels[matches[0]]
    return {
        "target": {
            "id": f"harvard-oxford:{matches[0]}",
            "label": canonical_label,
            "aliases": [],
            "domain": "anatomy",
            "subdomain": "Harvard-Oxford cortical",
            "description": "Original Harvard-Oxford cortical probability sampled on the locked Cedalion 25k surface.",
            "peakRegions": [canonical_label],
        },
        "vertexCount": VERTEX_COUNT,
        "vertexIndices": indices.tolist(),
        "values": values.tolist(),
        "provenance": {
            "sourceKind": "harvard-oxford-region",
            "sourceSpace": "MNI152NLin6Asym",
            "targetSpace": "MNI152NLin6Asym",
            "targetSurface": TARGET_SURFACE,
            "statistic": "Harvard-Oxford probability",
            "mapSha256": digest.hexdigest(),
            "interpolation": "nearest-voxel full original membership",
            "validation": {
                "atlasId": CORTICAL_ATLAS_ID,
                "surfaceAtlasSha256": SURFACE_ATLAS_SHA256,
                "probabilities": "original percent not renormalized",
            },
        },
    }


def target_anatomical_profile(
    vertex_indices: list[int],
    vertex_masses: list[float],
    minimum_atlas_membership: float = 0.05,
) -> dict:
    """Summarize a sparse, surface-area-weighted target in atlas space.

    The caller supplies the exact mass used by the planner (vertex area ×
    target value), so the explanatory region profile and the optimization
    objective stay numerically aligned.
    """
    indices = np.asarray(vertex_indices, dtype=np.int64)
    masses = np.asarray(vertex_masses, dtype=np.float64)
    if indices.ndim != 1 or masses.shape != indices.shape or indices.size == 0:
        raise AnatomicalCoverageError("target_profile_sparse_shape_invalid")
    if np.any(indices < 0) or np.any(indices >= VERTEX_COUNT) or len(np.unique(indices)) != len(indices):
        raise AnatomicalCoverageError("target_profile_vertex_indices_invalid")
    if not np.all(np.isfinite(masses)) or np.any(masses <= 0):
        raise AnatomicalCoverageError("target_profile_vertex_masses_invalid")
    if not 0 <= minimum_atlas_membership <= 1:
        raise AnatomicalCoverageError("target_profile_membership_threshold_invalid")

    atlas = load_surface_atlas_data()
    label_indices = atlas.atlas_label_indices[indices]
    memberships = atlas.atlas_memberships[indices]
    valid = (
        (label_indices != 255)
        & (memberships > 0)
        & (memberships >= minimum_atlas_membership)
    )
    region_masses: dict[int, float] = {}
    for slot in range(3):
        selected = valid[:, slot]
        for label_index in np.unique(label_indices[selected, slot]):
            label = int(label_index)
            label_mask = selected & (label_indices[:, slot] == label)
            region_masses[label] = region_masses.get(label, 0.0) + float(
                np.dot(masses[label_mask], memberships[label_mask, slot])
            )
    total_region_mass = float(sum(region_masses.values()))
    total_target_mass = float(masses.sum())
    per_vertex_support = np.clip(np.where(valid, memberships, 0.0).sum(axis=1), 0.0, 1.0)
    support_fraction = float(np.dot(masses, per_vertex_support) / total_target_mass)
    ordered_labels = sorted(
        region_masses,
        key=lambda label: (-region_masses[label], atlas.atlas_labels[label].casefold(), label),
    )
    return {
        "atlasId": CORTICAL_ATLAS_ID,
        "atlasSupportFraction": support_fraction,
        "regions": [{
            "atlasId": CORTICAL_ATLAS_ID,
            "labelEn": atlas.atlas_labels[label],
            "massFraction": region_masses[label] / total_region_mass,
        } for label in ordered_labels] if total_region_mass > 0 else [],
    }


@dataclass(frozen=True)
class SurfaceAtlasData:
    vertices_ras_mm: np.ndarray
    atlas_label_indices: np.ndarray
    atlas_memberships: np.ndarray
    atlas_labels: tuple[str, ...]

    def validate(self) -> None:
        if self.vertices_ras_mm.shape != (VERTEX_COUNT, 3):
            raise AnatomicalCoverageError("coverage_surface_vertex_shape_mismatch")
        if self.atlas_label_indices.shape != (VERTEX_COUNT, 3):
            raise AnatomicalCoverageError("coverage_atlas_index_shape_mismatch")
        if self.atlas_memberships.shape != (VERTEX_COUNT, 3):
            raise AnatomicalCoverageError("coverage_atlas_membership_shape_mismatch")
        if not np.all(np.isfinite(self.vertices_ras_mm)):
            raise AnatomicalCoverageError("coverage_surface_vertices_not_finite")
        if not np.all(np.isfinite(self.atlas_memberships)):
            raise AnatomicalCoverageError("coverage_atlas_memberships_not_finite")
        if np.any((self.atlas_memberships < 0) | (self.atlas_memberships > 1)):
            raise AnatomicalCoverageError("coverage_atlas_membership_range_invalid")
        invalid_indices = (self.atlas_label_indices != 255) & (
            (self.atlas_label_indices < 0) | (self.atlas_label_indices >= len(self.atlas_labels))
        )
        if np.any(invalid_indices):
            raise AnatomicalCoverageError("coverage_atlas_label_index_invalid")
        if np.any((self.atlas_label_indices == 255) & (self.atlas_memberships > 0)):
            raise AnatomicalCoverageError("coverage_unlabeled_atlas_membership_nonzero")
        if np.any(np.diff(self.atlas_memberships, axis=1) > 1e-12):
            raise AnatomicalCoverageError("coverage_atlas_top3_order_invalid")


def _load_locked_vertices(path: Path) -> np.ndarray:
    if sha256_file(path) != VERTEX_COORDINATES_SHA256:
        raise AnatomicalCoverageError("coverage_surface_vertex_hash_mismatch")
    vertices = np.empty((VERTEX_COUNT, 3), dtype=np.float64)
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream)
            required = {"vertex", "mni152_r", "mni152_a", "mni152_s"}
            if not reader.fieldnames or not required.issubset(reader.fieldnames):
                raise AnatomicalCoverageError("coverage_surface_vertex_columns_invalid")
            count = 0
            for expected_index, row in enumerate(reader):
                if expected_index >= VERTEX_COUNT or int(row["vertex"]) != expected_index:
                    raise AnatomicalCoverageError("coverage_surface_vertex_order_invalid")
                vertices[expected_index] = (
                    float(row["mni152_r"]),
                    float(row["mni152_a"]),
                    float(row["mni152_s"]),
                )
                count += 1
    except (OSError, UnicodeError, KeyError, TypeError, ValueError) as error:
        if isinstance(error, AnatomicalCoverageError):
            raise
        raise AnatomicalCoverageError(f"coverage_surface_vertices_unavailable:{type(error).__name__}") from error
    if count != VERTEX_COUNT:
        raise AnatomicalCoverageError("coverage_surface_vertex_count_mismatch")
    return vertices


@lru_cache(maxsize=1)
def load_surface_atlas_data() -> SurfaceAtlasData:
    gate = inspect_template_gate()
    if not gate.passed:
        raise AnatomicalCoverageError(f"coverage_template_gate_failed:{','.join(gate.issues)}")
    if gate.manifest.get("assetVersion") != TEMPLATE_ASSET_VERSION:
        raise AnatomicalCoverageError("coverage_template_asset_version_mismatch")
    generated = template_directory() / "generated"
    mesh = generated / "brain_scientific.glb"
    if sha256_file(mesh) != SURFACE_MESH_SHA256:
        raise AnatomicalCoverageError("coverage_surface_mesh_hash_mismatch")
    vertices = _load_locked_vertices(generated / "brain_vertex_coordinates.csv")
    atlas_indices, memberships, labels = cortical_probability_fields(vertices)
    result = SurfaceAtlasData(
        vertices_ras_mm=vertices,
        atlas_label_indices=np.asarray(atlas_indices, dtype=np.int16),
        atlas_memberships=np.asarray(memberships, dtype=np.float64),
        atlas_labels=labels,
    )
    result.validate()
    return result


def _stable_id(channel: AnatomicalCoverageChannel) -> str:
    return f"{channel.instance_id}:{channel.pair_id}"


def _canonical_path_sha256(points: np.ndarray) -> str:
    normalized = [[0.0 if float(value) == 0 else float(value) for value in point] for point in points]
    payload = json.dumps(
        {"coordinateConvention": "RAS+", "units": "mm", "pointsRasMm": normalized},
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _path_length_mm(points: np.ndarray) -> float:
    return float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())


def _squared_distance_to_polyline(vertices: np.ndarray, points: np.ndarray) -> np.ndarray:
    minimum = np.full(vertices.shape[0], np.inf, dtype=np.float64)
    for start, end in zip(points[:-1], points[1:], strict=True):
        segment = end - start
        squared_length = float(np.dot(segment, segment))
        if squared_length <= 1e-12:
            squared = np.einsum("ij,ij->i", vertices - start, vertices - start)
        else:
            offset = vertices - start
            position = np.clip((offset @ segment) / squared_length, 0.0, 1.0)
            nearest = start + position[:, None] * segment
            delta = vertices - nearest
            squared = np.einsum("ij,ij->i", delta, delta)
        np.minimum(minimum, squared, out=minimum)
    return minimum


def _channel_kernel(vertices: np.ndarray, points: np.ndarray, sigma_mm: float, radius_mm: float) -> np.ndarray:
    squared_distance = _squared_distance_to_polyline(vertices, points)
    weights = np.exp(-0.5 * squared_distance / (sigma_mm * sigma_mm))
    weights[squared_distance > radius_mm * radius_mm] = 0.0
    if not np.all(np.isfinite(weights)):
        raise AnatomicalCoverageError("coverage_kernel_not_finite")
    return weights


def _stable_region_color(atlas_id: str, label: str) -> str:
    """Return a label-stable display hint; color carries no scientific meaning.

    Atlas table indices are an implementation detail and may change when an
    asset is rebuilt.  Deriving the hue from the canonical atlas identity and
    English label keeps the same region visually stable across rebuilds.
    """
    digest = hashlib.sha256(f"{atlas_id}\0{label}".encode("utf-8")).digest()
    hue = int.from_bytes(digest[:8], "big") / float(1 << 64)
    red, green, blue = colorsys.hls_to_rgb(hue, 0.54, 0.68)
    return f"#{round(red * 255):02X}{round(green * 255):02X}{round(blue * 255):02X}"


def _validate_coverage_resource_limits(request: AnatomicalCoverageRequest) -> None:
    """Re-check the request budget at the computation boundary.

    Pydantic normally performs this validation while parsing the request.  A
    second check keeps the engine safe for callers that use ``model_construct``
    (or otherwise bypass normal validation) and makes the limit a property of
    the scientific computation rather than just an HTTP endpoint.
    """

    limits = ANATOMICAL_COVERAGE_LIMITS
    channel_count = len(request.channels)
    if channel_count > limits["maximumChannels"]:
        raise AnatomicalCoverageError(coverage_limit_error(
            "maximumChannels", channel_count, limits["maximumChannels"]
        ))
    total_path_points = sum(len(channel.points_ras_mm) for channel in request.channels)
    if total_path_points > limits["maximumTotalPathPoints"]:
        raise AnatomicalCoverageError(coverage_limit_error(
            "maximumTotalPathPoints", total_path_points, limits["maximumTotalPathPoints"]
        ))
    total_segments = sum(len(channel.points_ras_mm) - 1 for channel in request.channels)
    if total_segments > limits["maximumTotalSegments"]:
        raise AnatomicalCoverageError(coverage_limit_error(
            "maximumTotalSegments", total_segments, limits["maximumTotalSegments"]
        ))
    serialized_bytes = len(request.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8"))
    if serialized_bytes > limits["maximumSerializedRequestBytes"]:
        raise AnatomicalCoverageError(coverage_limit_error(
            "maximumSerializedRequestBytes",
            serialized_bytes,
            limits["maximumSerializedRequestBytes"],
        ))


class AnatomicalCoverageEngine:
    def __init__(self, surface_atlas: SurfaceAtlasData | None = None):
        self.surface_atlas = surface_atlas or load_surface_atlas_data()
        self.surface_atlas.validate()

    def compute(self, request: AnatomicalCoverageRequest) -> AnatomicalCoverageAnalysis:
        _validate_coverage_resource_limits(request)
        ordered_channels = sorted(request.channels, key=_stable_id)
        stable_ids = [_stable_id(channel) for channel in ordered_channels]
        if len(set(stable_ids)) != len(stable_ids):
            raise AnatomicalCoverageError("coverage_channel_id_duplicate")

        channel_results: list[AnatomicalCoverageChannelResult] = []
        settings = request.settings
        memberships = self.surface_atlas.atlas_memberships
        label_indices = self.surface_atlas.atlas_label_indices
        valid_slots = (
            (label_indices != 255)
            & (memberships > 0)
            & (memberships >= settings.minimum_atlas_membership)
        )

        # Keep only O(vertices) kernel state.  The previous implementation
        # stacked every channel kernel into a channels x vertices matrix,
        # which made a large but valid request allocate hundreds of MiB.
        combined_weights = np.zeros(VERTEX_COUNT, dtype=np.float64)
        dominant_channels = np.zeros(VERTEX_COUNT, dtype=np.int64)
        # Keep per-channel atlas contributions sparse as well.  A dense
        # channel-by-vertex accumulator was the original memory failure; a
        # channel-by-label matrix would still scale with an unexpectedly
        # large/custom atlas.  The dictionaries contain only labels touched
        # by each channel and are populated while that channel kernel is live.
        channel_region_masses: list[dict[int, float]] = [
            {} for _ in ordered_channels
        ]
        for channel_index, (channel, stable_id) in enumerate(zip(ordered_channels, stable_ids, strict=True)):
            path = np.asarray(channel.points_ras_mm, dtype=np.float64)
            if (
                path.shape != (len(channel.points_ras_mm), 3)
                or len(path) > ANATOMICAL_COVERAGE_LIMITS["maximumPathPointsPerChannel"]
                or not np.all(np.isfinite(path))
            ):
                raise AnatomicalCoverageError(f"coverage_channel_path_invalid:{stable_id}")
            path_length = _path_length_mm(path)
            if path_length <= 1e-6:
                raise AnatomicalCoverageError(f"coverage_channel_path_degenerate:{stable_id}")
            channel_results.append(AnatomicalCoverageChannelResult(
                stable_id=stable_id,
                instance_id=channel.instance_id,
                pair_id=channel.pair_id,
                channel_number=channel.channel_number,
                path_point_count=len(path),
                path_length_mm=path_length,
                path_sha256=_canonical_path_sha256(path),
            ))

            channel_weights = _channel_kernel(
                self.surface_atlas.vertices_ras_mm,
                path,
                settings.kernel_sigma_mm,
                settings.support_radius_mm,
            )
            better = channel_weights > combined_weights
            combined_weights[better] = channel_weights[better]
            dominant_channels[better] = channel_index

            # Accumulate only the channel's touched atlas regions while its
            # kernel is live, then let that kernel be released before the next
            # channel is evaluated.  The inverse index keeps this linear in
            # the covered vertices without allocating a C x 25k matrix.
            covered = channel_weights > 0
            for slot in range(3):
                selected = covered & valid_slots[:, slot]
                if not np.any(selected):
                    continue
                labels = label_indices[selected, slot].astype(np.int64, copy=False)
                contributions = channel_weights[selected] * memberships[selected, slot]
                unique_labels, inverse = np.unique(labels, return_inverse=True)
                masses = np.bincount(inverse, weights=contributions)
                per_channel = channel_region_masses[channel_index]
                for label, mass in zip(unique_labels, masses, strict=True):
                    per_channel[int(label)] = per_channel.get(int(label), 0.0) + float(mass)

        geometric_mask = combined_weights > 0
        geometric_vertex_indices = np.flatnonzero(geometric_mask)

        atlas_labeled_mask = geometric_mask & np.any(valid_slots, axis=1)
        mosaic_vertex_indices = np.flatnonzero(atlas_labeled_mask)

        region_masses: dict[int, float] = {}
        for slot in range(3):
            selected = geometric_mask & valid_slots[:, slot]
            if not np.any(selected):
                continue
            labels = label_indices[selected, slot].astype(np.int64, copy=False)
            contributions = combined_weights[selected] * memberships[selected, slot]
            combined_region_masses = np.bincount(
                labels,
                weights=contributions,
                minlength=len(self.surface_atlas.atlas_labels),
            )
            for label in np.flatnonzero(combined_region_masses > 0):
                region_masses[int(label)] = region_masses.get(int(label), 0.0) + float(combined_region_masses[label])

        total_region_mass = float(sum(region_masses.values()))
        sorted_labels = sorted(
            region_masses,
            key=lambda label: (-region_masses[label], self.surface_atlas.atlas_labels[label].casefold(), label),
        )
        label_to_region = {label: index for index, label in enumerate(sorted_labels)}

        if mosaic_vertex_indices.size:
            candidate_memberships = np.where(valid_slots[mosaic_vertex_indices], memberships[mosaic_vertex_indices], -1.0)
            winner_slots = np.argmax(candidate_memberships, axis=1)
            winner_labels = label_indices[mosaic_vertex_indices, winner_slots].astype(np.int64)
            winner_memberships = memberships[mosaic_vertex_indices, winner_slots]
            mosaic_region_indices = np.asarray([label_to_region[int(label)] for label in winner_labels], dtype=np.int64)
            winner_channel_indices = dominant_channels[mosaic_vertex_indices].astype(np.int64)
        else:
            winner_labels = np.empty(0, dtype=np.int64)
            winner_memberships = np.empty(0, dtype=np.float64)
            mosaic_region_indices = np.empty(0, dtype=np.int64)
            winner_channel_indices = np.empty(0, dtype=np.int64)

        regions: list[AnatomicalCoverageRegion] = []
        for region_index, label in enumerate(sorted_labels):
            per_channel = [
                channel_region_masses[channel_index].get(label, 0.0)
                for channel_index in range(len(ordered_channels))
            ]
            contribution_total = float(sum(per_channel))
            channel_shares = [
                AnatomicalCoverageChannelShare(
                    channel_index=channel_index,
                    stable_id=stable_ids[channel_index],
                    geometric_share=float(mass / contribution_total),
                )
                for channel_index, mass in enumerate(per_channel)
                if mass > 0 and contribution_total > 0
            ]
            regions.append(AnatomicalCoverageRegion(
                region_index=region_index,
                atlas_id=CORTICAL_ATLAS_ID,
                label_en=self.surface_atlas.atlas_labels[label],
                color_hex=_stable_region_color(
                    CORTICAL_ATLAS_ID,
                    self.surface_atlas.atlas_labels[label],
                ),
                covered_atlas_mass_fraction=(region_masses[label] / total_region_mass) if total_region_mass > 0 else 0.0,
                weighted_atlas_mass=region_masses[label],
                dominant_vertex_count=int(np.count_nonzero(winner_labels == label)),
                channel_shares=channel_shares,
            ))

        geometric_count = int(np.count_nonzero(geometric_mask))
        labeled_count = int(mosaic_vertex_indices.size)
        geometric_mass = float(combined_weights[geometric_mask].sum())
        per_vertex_atlas_support = np.clip(
            np.where(valid_slots, memberships, 0.0).sum(axis=1),
            0.0,
            1.0,
        )
        support_fraction = (
            float(np.dot(combined_weights[geometric_mask], per_vertex_atlas_support[geometric_mask]) / geometric_mass)
            if geometric_mass > 0 else 0.0
        )
        flags: list[str] = []
        if geometric_count == 0:
            flags.append("no_geometric_surface_coverage")
        elif labeled_count == 0:
            flags.append("no_harvard_oxford_support")
        elif labeled_count < geometric_count:
            flags.append("partial_harvard_oxford_support")

        analysis = AnatomicalCoverageAnalysis(
            channels=channel_results,
            parameters=AnatomicalCoverageParameters(
                kernel_sigma_mm=settings.kernel_sigma_mm,
                support_radius_mm=settings.support_radius_mm,
                minimum_atlas_membership=settings.minimum_atlas_membership,
            ),
            mosaic=AnatomicalCoverageMosaic(
                geometric_vertex_indices=geometric_vertex_indices.tolist(),
                geometric_coverage_weights=combined_weights[geometric_vertex_indices].tolist(),
                vertex_indices=mosaic_vertex_indices.tolist(),
                coverage_weights=combined_weights[mosaic_vertex_indices].tolist(),
                opacity_weights=(combined_weights[mosaic_vertex_indices] * winner_memberships).tolist(),
                region_indices=mosaic_region_indices.tolist(),
                atlas_memberships=winner_memberships.tolist(),
                dominant_channel_indices=winner_channel_indices.tolist(),
            ),
            regions=regions,
            qc=AnatomicalCoverageQc(
                geometric_covered_vertex_count=geometric_count,
                atlas_labeled_vertex_count=labeled_count,
                unlabeled_covered_vertex_count=geometric_count - labeled_count,
                atlas_support_fraction=support_fraction,
                flags=flags,
            ),
            provenance=AnatomicalCoverageProvenance(
                template_asset_version=TEMPLATE_ASSET_VERSION,
                surface_vertex_coordinates_sha256=VERTEX_COORDINATES_SHA256,
                surface_mesh_sha256=SURFACE_MESH_SHA256,
                atlas_id=CORTICAL_ATLAS_ID,
                atlas_index_sha256=ATLAS_SHA256,
            ),
        )
        serialized = analysis.model_dump(mode="json", by_alias=True)
        if not _all_numbers_finite(serialized):
            raise AnatomicalCoverageError("coverage_output_not_finite")
        return analysis


def _all_numbers_finite(value: object) -> bool:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return True
    if isinstance(value, (int, float)):
        return bool(np.isfinite(value))
    if isinstance(value, list):
        return all(_all_numbers_finite(item) for item in value)
    if isinstance(value, dict):
        return all(_all_numbers_finite(item) for item in value.values())
    return True


@lru_cache(maxsize=1)
def load_anatomical_coverage_engine() -> AnatomicalCoverageEngine:
    return AnatomicalCoverageEngine()


def compute_anatomical_coverage(request: AnatomicalCoverageRequest) -> AnatomicalCoverageAnalysis:
    return load_anatomical_coverage_engine().compute(request)
