from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Vec2 = tuple[float, float]
Vec3 = tuple[float, float, float]


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
    atlas_probability_threshold: Annotated[float, Field(ge=0, le=1)] = 0.1
    optode_radius_mm: Annotated[float, Field(ge=1, le=15)] = 3.6


class BatchProjectionRequest(ContractModel):
    template: TemplateRef
    settings: ProjectionSettings
    layout: LayoutDefinition
    instance: LayoutInstance


class ProjectValidationRequest(ContractModel):
    project: dict
