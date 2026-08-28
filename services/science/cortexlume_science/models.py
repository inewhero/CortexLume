from __future__ import annotations

from math import isclose
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

from .coverage_limits import ANATOMICAL_COVERAGE_LIMITS, CROSS_PROCESS_LIMITS, coverage_limit_error


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Vec2 = tuple[float, float]
Vec3 = tuple[float, float, float]
# Atlas coordinates cross a JSON/NumPy boundary and must have the same finite
# number guarantee as the TypeScript Vec3Schema.  Keep this narrower alias
# local to atlas requests so legacy project geometry remains wire-compatible.
FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]
FiniteVec3 = tuple[FiniteFloat, FiniteFloat, FiniteFloat]


class Optode(ContractModel):
    id: UUID
    label: Annotated[str, Field(min_length=1)]
    type: Literal["source", "detector"]
    uv_mm: Vec2


class Pair(ContractModel):
    id: UUID
    source_id: UUID
    detector_id: UUID
    channel_number: Annotated[int, Field(gt=0)] | None = None
    nominal_distance_mm: Annotated[float, Field(gt=0)]
    short_channel: bool = False


class LayoutDefinition(ContractModel):
    id: UUID
    version: Annotated[int, Field(gt=0)]
    name: Annotated[str, Field(min_length=1)]
    created_at: str
    updated_at: str
    grid_spacing_mm: Annotated[float, Field(gt=0)]
    optodes: list[Optode]
    pairs: list[Pair]


class FitQc(ContractModel):
    converged: bool
    iterations: Annotated[int, Field(ge=0)]
    mean_absolute_error_mm: Annotated[float, Field(ge=0)]
    max_absolute_error_mm: Annotated[float, Field(ge=0)]
    flags: list[str]


class OptodeOverride(ContractModel):
    optode_id: UUID
    uv_mm: Vec2


class LayoutInstance(ContractModel):
    id: UUID
    definition_id: UUID
    anchor_ras_mm: Vec3
    rotation_rad: float
    mapping_rotation_rad: float = 0.0
    visible: bool = True
    locked: bool = True
    overrides: list[OptodeOverride]
    fit_qc: FitQc | None = None


class TemplateRef(ContractModel):
    id: Literal["MNI152NLin6Asym"]
    asset_version: str
    coordinate_convention: Literal["RAS+"]
    units: Literal["mm"]
    verified: bool
    manifest_sha256: str
    scalp_mesh_sha256: str
    cortex_mesh_sha256: str
    atlas_sha256: str


class FitPlacementRequest(ContractModel):
    interaction_id: str
    project_revision: Annotated[int, Field(ge=0)]
    template: TemplateRef
    layout: LayoutDefinition
    instance: LayoutInstance


class AtlasLabel(ContractModel):
    atlas_id: str
    label_en: str
    probability: Annotated[float, Field(ge=0, le=1)]


class ProjectionResult(ContractModel):
    instance_id: UUID | None
    subject_kind: Literal["optode", "pair"]
    subject_id: UUID
    scalp_ras_mm: Vec3 | None
    display_ras_mm: Vec3 | None = None
    cortical_ras_mm: Vec3 | None
    depth_target_ras_mm: Vec3 | None
    underlying_cortical_regions: list[AtlasLabel]
    deep_target_structures: list[AtlasLabel]
    tissue_at_target: str | None
    claim_level: Literal["development_only", "geometric", "modeled"]
    status: Literal["provisional", "verified", "blocked"]
    qc_flags: list[str]


class FitPlacementResponse(ContractModel):
    interaction_id: str
    project_revision: int
    instance: LayoutInstance
    projections: list[ProjectionResult]
    template_verified: bool


class ProjectionSettings(ContractModel):
    mode: Literal["scalp", "cortex"] = "scalp"
    default_depth_mm: Annotated[float, Field(ge=1, le=100)] | None = None
    pair_depth_overrides_mm: dict[UUID, Annotated[float, Field(ge=1, le=100)]] = Field(default_factory=dict)
    atlas_probability_threshold: Annotated[float, Field(ge=0, le=1)] = 0.0
    optode_radius_mm: Annotated[float, Field(ge=1, le=15)] = 3.6


class BatchProjectionRequest(ContractModel):
    template: TemplateRef
    settings: ProjectionSettings
    layout: LayoutDefinition
    instance: LayoutInstance


class ProjectValidationRequest(ContractModel):
    project: dict


class AtlasQueryPoint(ContractModel):
    id: Annotated[str, Field(min_length=1, max_length=128)]
    cortical_ras_mm: FiniteVec3 | None = None
    deep_target_ras_mm: FiniteVec3 | None = None


class AtlasQueryRequest(ContractModel):
    points: Annotated[list[AtlasQueryPoint], Field(min_length=1, max_length=CROSS_PROCESS_LIMITS["atlasBatchPoints"])]
    probability_threshold: Annotated[FiniteFloat, Field(ge=0, le=1)] = 0.0


class AtlasPathQueryRequest(ContractModel):
    points: Annotated[list[FiniteVec3], Field(
        min_length=1,
        max_length=ANATOMICAL_COVERAGE_LIMITS["maximumPathPointsPerChannel"],
    )]
    probability_threshold: Annotated[FiniteFloat, Field(ge=0, le=1)] = 0.0


class AtlasPathQueryBatchItem(ContractModel):
    id: Annotated[str, Field(min_length=1, max_length=128)]
    points: Annotated[list[FiniteVec3], Field(
        min_length=1,
        max_length=ANATOMICAL_COVERAGE_LIMITS["maximumPathPointsPerChannel"],
    )]


class AtlasPathQueryBatchRequest(ContractModel):
    # ``paths`` was used by an early desktop prototype; accept it as an input
    # alias while emitting the canonical ``items`` key on the wire.
    items: Annotated[list[AtlasPathQueryBatchItem], Field(
        min_length=1,
        max_length=CROSS_PROCESS_LIMITS["atlasPathBatchItems"],
        validation_alias=AliasChoices("items", "paths"),
    )]
    probability_threshold: Annotated[FiniteFloat, Field(ge=0, le=1)] = 0.0


class AnatomicalCoverageChannel(ContractModel):
    instance_id: UUID
    pair_id: UUID
    channel_number: Annotated[int, Field(gt=0)] | None = None
    points_ras_mm: Annotated[list[FiniteVec3], Field(
        min_length=2,
        max_length=ANATOMICAL_COVERAGE_LIMITS["maximumPathPointsPerChannel"],
    )]


class AnatomicalCoverageSettings(ContractModel):
    kernel_sigma_mm: Annotated[FiniteFloat, Field(ge=1, le=40)] = 12.0
    support_radius_mm: Annotated[FiniteFloat, Field(ge=2, le=80)] = 24.0
    minimum_atlas_membership: Annotated[FiniteFloat, Field(ge=0, le=1)] = 0.05

    @model_validator(mode="after")
    def support_contains_kernel_sigma(self):
        if self.support_radius_mm < self.kernel_sigma_mm:
            raise ValueError("supportRadiusMm must be at least kernelSigmaMm")
        return self


class AnatomicalCoverageRequest(ContractModel):
    channels: Annotated[list[AnatomicalCoverageChannel], Field(
        min_length=1,
        max_length=ANATOMICAL_COVERAGE_LIMITS["maximumChannels"],
    )]
    settings: AnatomicalCoverageSettings = Field(default_factory=AnatomicalCoverageSettings)

    @model_validator(mode="before")
    @classmethod
    def resource_limits_are_checked_before_parsing(cls, value):
        """Reject valid-looking oversized JSON before constructing child models."""

        if not isinstance(value, dict):
            return value
        channels = value.get("channels")
        if not isinstance(channels, list):
            return value
        limits = ANATOMICAL_COVERAGE_LIMITS
        if len(channels) > limits["maximumChannels"]:
            raise ValueError(coverage_limit_error(
                "maximumChannels", len(channels), limits["maximumChannels"]
            ))
        raw_point_counts = [
            len(channel.get("pointsRasMm", []))
            for channel in channels
            if isinstance(channel, dict) and isinstance(channel.get("pointsRasMm"), list)
        ]
        if len(raw_point_counts) == len(channels):
            total_path_points = sum(raw_point_counts)
            if total_path_points > limits["maximumTotalPathPoints"]:
                raise ValueError(coverage_limit_error(
                    "maximumTotalPathPoints", total_path_points, limits["maximumTotalPathPoints"]
                ))
            total_segments = sum(point_count - 1 for point_count in raw_point_counts)
            if total_segments > limits["maximumTotalSegments"]:
                raise ValueError(coverage_limit_error(
                    "maximumTotalSegments", total_segments, limits["maximumTotalSegments"]
                ))
        return value

    @model_validator(mode="after")
    def resource_limits_are_respected(self):
        channel_count = len(self.channels)
        total_path_points = sum(len(channel.points_ras_mm) for channel in self.channels)
        total_segments = sum(len(channel.points_ras_mm) - 1 for channel in self.channels)
        limits = ANATOMICAL_COVERAGE_LIMITS
        if channel_count > limits["maximumChannels"]:
            raise ValueError(coverage_limit_error(
                "maximumChannels", channel_count, limits["maximumChannels"]
            ))
        if total_path_points > limits["maximumTotalPathPoints"]:
            raise ValueError(coverage_limit_error(
                "maximumTotalPathPoints", total_path_points, limits["maximumTotalPathPoints"]
            ))
        if total_segments > limits["maximumTotalSegments"]:
            raise ValueError(coverage_limit_error(
                "maximumTotalSegments", total_segments, limits["maximumTotalSegments"]
            ))
        # ``exclude_none`` mirrors JSON.stringify's omission of an absent
        # optional channelNumber in the TypeScript contract.
        serialized_bytes = len(self.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8"))
        if serialized_bytes > limits["maximumSerializedRequestBytes"]:
            raise ValueError(coverage_limit_error(
                "maximumSerializedRequestBytes",
                serialized_bytes,
                limits["maximumSerializedRequestBytes"],
            ))
        return self


class AnatomicalCoverageChannelResult(ContractModel):
    stable_id: Annotated[str, Field(min_length=1)]
    instance_id: UUID
    pair_id: UUID
    channel_number: Annotated[int, Field(gt=0)] | None = None
    path_point_count: Annotated[int, Field(
        ge=2,
        le=ANATOMICAL_COVERAGE_LIMITS["maximumPathPointsPerChannel"],
    )]
    path_length_mm: Annotated[FiniteFloat, Field(gt=0)]
    path_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class AnatomicalCoverageChannelShare(ContractModel):
    channel_index: Annotated[int, Field(ge=0)]
    stable_id: Annotated[str, Field(min_length=1)]
    geometric_share: Annotated[FiniteFloat, Field(ge=0, le=1)]


class AnatomicalCoverageRegion(ContractModel):
    region_index: Annotated[int, Field(ge=0)]
    atlas_id: Annotated[str, Field(min_length=1)]
    label_en: Annotated[str, Field(min_length=1)]
    color_hex: Annotated[str, Field(pattern=r"^#[A-Fa-f0-9]{6}$")]
    covered_atlas_mass_fraction: Annotated[FiniteFloat, Field(ge=0, le=1)]
    weighted_atlas_mass: Annotated[FiniteFloat, Field(gt=0)]
    dominant_vertex_count: Annotated[int, Field(ge=0)]
    channel_shares: list[AnatomicalCoverageChannelShare]


class AnatomicalCoverageMosaic(ContractModel):
    geometric_vertex_indices: list[Annotated[int, Field(ge=0, lt=25_000)]]
    geometric_coverage_weights: list[Annotated[FiniteFloat, Field(ge=0, le=1)]]
    vertex_indices: list[Annotated[int, Field(ge=0, lt=25_000)]]
    coverage_weights: list[Annotated[FiniteFloat, Field(ge=0, le=1)]]
    opacity_weights: list[Annotated[FiniteFloat, Field(ge=0, le=1)]]
    region_indices: list[Annotated[int, Field(ge=0)]]
    atlas_memberships: list[Annotated[FiniteFloat, Field(ge=0, le=1)]]
    dominant_channel_indices: list[Annotated[int, Field(ge=0)]]

    @model_validator(mode="after")
    def parallel_arrays_are_strict(self):
        length = len(self.vertex_indices)
        if len(self.geometric_coverage_weights) != len(self.geometric_vertex_indices):
            raise ValueError("anatomical coverage geometric arrays must have equal length")
        if any(len(values) != length for values in (
            self.coverage_weights,
            self.opacity_weights,
            self.region_indices,
            self.atlas_memberships,
            self.dominant_channel_indices,
        )):
            raise ValueError("anatomical coverage mosaic arrays must have equal length")
        if any(not isclose(opacity, coverage * membership, abs_tol=1e-6) for opacity, coverage, membership in zip(
            self.opacity_weights, self.coverage_weights, self.atlas_memberships, strict=True
        )):
            raise ValueError("anatomical coverage opacity weights are inconsistent")
        if any(right <= left for left, right in zip(self.vertex_indices, self.vertex_indices[1:], strict=False)):
            raise ValueError("anatomical coverage vertex indices must be unique and strictly increasing")
        if any(right <= left for left, right in zip(
            self.geometric_vertex_indices, self.geometric_vertex_indices[1:], strict=False
        )):
            raise ValueError("anatomical coverage geometric vertex indices must be unique and strictly increasing")
        geometric_weights = dict(zip(
            self.geometric_vertex_indices, self.geometric_coverage_weights, strict=True
        ))
        if any(
            vertex not in geometric_weights or not isclose(
                coverage, geometric_weights[vertex], abs_tol=1e-6
            )
            for vertex, coverage in zip(self.vertex_indices, self.coverage_weights, strict=True)
        ):
            raise ValueError("atlas-labeled coverage must be contained in geometric support")
        return self


class AnatomicalCoverageParameters(AnatomicalCoverageSettings):
    distance_metric: Literal["euclidean-distance-to-polyline"] = "euclidean-distance-to-polyline"
    kernel: Literal["truncated-gaussian"] = "truncated-gaussian"
    channel_combination: Literal["maximum-kernel-weight"] = "maximum-kernel-weight"
    mosaic_assignment: Literal["maximum-harvard-oxford-membership"] = "maximum-harvard-oxford-membership"
    region_aggregation: Literal["coverage-weighted-atlas-membership"] = "coverage-weighted-atlas-membership"
    atlas_membership_aggregation: Literal[
        "sum-retained-top3-without-renormalization"
    ] = "sum-retained-top3-without-renormalization"
    summary_sampling: Literal[
        "vertex-sampled-not-surface-area-integrated"
    ] = "vertex-sampled-not-surface-area-integrated"


class AnatomicalCoverageQc(ContractModel):
    geometric_covered_vertex_count: Annotated[int, Field(ge=0)]
    atlas_labeled_vertex_count: Annotated[int, Field(ge=0)]
    unlabeled_covered_vertex_count: Annotated[int, Field(ge=0)]
    atlas_support_fraction: Annotated[FiniteFloat, Field(ge=0, le=1)]
    flags: list[str]


class AnatomicalCoverageProvenance(ContractModel):
    template_asset_version: Annotated[str, Field(min_length=1)]
    coordinate_convention: Literal["RAS+"] = "RAS+"
    units: Literal["mm"] = "mm"
    surface_vertex_coordinates_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    surface_mesh_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    atlas_id: Annotated[str, Field(min_length=1)]
    atlas_index_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    atlas_sampling: Literal["nearest-voxel-top3-original-membership"] = "nearest-voxel-top3-original-membership"
    interpretation: Literal[
        "Geometric anatomical coverage prior; not photon sensitivity, fluence, or Jacobian."
    ] = "Geometric anatomical coverage prior; not photon sensitivity, fluence, or Jacobian."


class AnatomicalCoverageAnalysis(ContractModel):
    version: Literal[1] = 1
    source_kind: Literal["geometric-anatomical-coverage-prior"] = "geometric-anatomical-coverage-prior"
    target_surface: Literal["Cedalion-ICBM152-25k"] = "Cedalion-ICBM152-25k"
    vertex_count: Literal[25_000] = 25_000
    channels: Annotated[list[AnatomicalCoverageChannelResult], Field(
        min_length=1,
        max_length=ANATOMICAL_COVERAGE_LIMITS["maximumChannels"],
    )]
    parameters: AnatomicalCoverageParameters
    mosaic: AnatomicalCoverageMosaic
    regions: list[AnatomicalCoverageRegion]
    qc: AnatomicalCoverageQc
    provenance: AnatomicalCoverageProvenance

    @model_validator(mode="after")
    def references_are_valid(self):
        previous_stable_id: str | None = None
        for channel in self.channels:
            expected_stable_id = f"{channel.instance_id}:{channel.pair_id}"
            if channel.stable_id != expected_stable_id:
                raise ValueError("anatomical coverage channel stable ID is not canonical")
            if previous_stable_id is not None and channel.stable_id <= previous_stable_id:
                raise ValueError("anatomical coverage channels must have unique, ordered stable IDs")
            previous_stable_id = channel.stable_id
        for index, region in enumerate(self.regions):
            if region.region_index != index:
                raise ValueError("anatomical coverage region indices must be contiguous")
            for share in region.channel_shares:
                if share.channel_index >= len(self.channels):
                    raise ValueError("anatomical coverage channel share index is invalid")
                if self.channels[share.channel_index].stable_id != share.stable_id:
                    raise ValueError("anatomical coverage channel share ID is invalid")
            if not isclose(sum(share.geometric_share for share in region.channel_shares), 1.0, abs_tol=1e-6):
                raise ValueError("anatomical coverage channel shares must sum to one")
        if any(index >= len(self.regions) for index in self.mosaic.region_indices):
            raise ValueError("anatomical coverage mosaic region index is invalid")
        if any(index >= len(self.channels) for index in self.mosaic.dominant_channel_indices):
            raise ValueError("anatomical coverage mosaic channel index is invalid")
        if self.qc.atlas_labeled_vertex_count != len(self.mosaic.vertex_indices):
            raise ValueError("anatomical coverage labeled vertex count is inconsistent")
        if self.qc.geometric_covered_vertex_count != (
            self.qc.atlas_labeled_vertex_count + self.qc.unlabeled_covered_vertex_count
        ):
            raise ValueError("anatomical coverage QC vertex counts are inconsistent")
        if self.regions and not isclose(
            sum(region.covered_atlas_mass_fraction for region in self.regions), 1.0, abs_tol=1e-6
        ):
            raise ValueError("anatomical coverage region mass fractions must sum to one")
        return self
