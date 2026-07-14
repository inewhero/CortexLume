from __future__ import annotations

import os
from math import exp
from typing import Any

from fastapi import FastAPI, Header, HTTPException, status

from . import __version__
from .geometry import cortex_projection, fit_errors, fitted_positions, inward_depth_target, pair_midpoint
from .models import (
    AtlasLabel,
    BatchProjectionRequest,
    FitPlacementRequest,
    FitPlacementResponse,
    FitQc,
    ProjectValidationRequest,
    ProjectionResult,
)
from .template_gate import inspect_template_gate

app = FastAPI(title="CortexLume Science", version=__version__, docs_url=None, redoc_url=None)


CORTICAL_CENTROIDS = [
    ("Frontal Pole", (30, 62, 24), (26, 25, 28)),
    ("Superior Frontal Gyrus", (24, 32, 58), (24, 28, 25)),
    ("Middle Frontal Gyrus", (42, 34, 32), (23, 27, 26)),
    ("Precentral Gyrus", (42, 2, 48), (18, 20, 30)),
    ("Postcentral Gyrus", (44, -20, 50), (18, 20, 30)),
    ("Superior Parietal Lobule", (30, -48, 58), (24, 26, 25)),
    ("Supramarginal Gyrus", (52, -38, 32), (20, 24, 25)),
    ("Superior Temporal Gyrus", (56, -12, 6), (18, 36, 22)),
    ("Middle Temporal Gyrus", (58, -38, -4), (18, 34, 22)),
    ("Lateral Occipital Cortex", (38, -78, 24), (28, 26, 32)),
]

DEEP_CENTROIDS = [
    ("Thalamus", (12, -18, 8), (11, 13, 11)),
    ("Caudate", (13, 10, 12), (9, 15, 13)),
    ("Putamen", (25, 2, 1), (10, 14, 11)),
    ("Globus Pallidus", (21, -4, 0), (8, 10, 9)),
    ("Hippocampus", (27, -27, -12), (12, 20, 10)),
    ("Amygdala", (24, -4, -18), (10, 11, 9)),
    ("Insular Cortex", (38, -3, 5), (9, 24, 20)),
]


def region_probabilities(point, centroids, atlas_id: str) -> list[AtlasLabel]:
    scored = []
    for label, center, spread in centroids:
        for side, sign in (("Left", -1), ("Right", 1)):
            candidate = (sign * abs(center[0]), center[1], center[2])
            squared = sum(((point[index] - candidate[index]) / spread[index]) ** 2 for index in range(3))
            scored.append((f"{side} {label}", exp(-0.5 * squared)))
    total = sum(score for _, score in scored) or 1.0
    scored.sort(key=lambda item: item[1], reverse=True)
    return [AtlasLabel(atlas_id=atlas_id, label_en=label, probability=score / total) for label, score in scored[:3]]


def authorize(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get("CORTEXLUME_TOKEN", "development-token")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid sidecar token")


@app.get("/v1/health")
def health(_: None = Header(default=None, alias="x-unused"), authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    gate = inspect_template_gate()
    return {
        "ok": True,
        "version": __version__,
        "templateVerified": gate.passed,
        "templateIssues": list(gate.issues),
    }


@app.get("/v1/template-manifest")
def template_manifest(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    gate = inspect_template_gate()
    return {"verified": gate.passed, "issues": list(gate.issues), "manifest": gate.manifest}


def compute_projections(request: FitPlacementRequest, depth_mm: float | None = None) -> list[ProjectionResult]:
    positions = fitted_positions(request.layout, request.instance)
    status_value = "provisional"
    claim = "geometric"
    flags: list[str] = []
    results: list[ProjectionResult] = []

    for optode in request.layout.optodes:
        scalp = positions[optode.id]
        cortex = cortex_projection(scalp)
        results.append(ProjectionResult(
            instance_id=request.instance.id,
            subject_kind="optode",
            subject_id=optode.id,
            scalp_ras_mm=scalp,
            cortical_ras_mm=cortex,
            depth_target_ras_mm=None,
            underlying_cortical_regions=region_probabilities(cortex, CORTICAL_CENTROIDS, "CortexLume-Cortical-Estimate"),
            deep_target_structures=[],
            tissue_at_target=None,
            claim_level=claim,
            status=status_value,
            qc_flags=flags,
        ))

    for pair in request.layout.pairs:
        source = positions.get(pair.source_id)
        detector = positions.get(pair.detector_id)
        if source is None or detector is None:
            results.append(ProjectionResult(
                instance_id=request.instance.id,
                subject_kind="pair",
                subject_id=pair.id,
                scalp_ras_mm=None,
                cortical_ras_mm=None,
                depth_target_ras_mm=None,
                underlying_cortical_regions=[],
                deep_target_structures=[],
                tissue_at_target=None,
                claim_level=claim,
                status="blocked",
                qc_flags=[*flags, "missing_pair_optode"],
            ))
            continue
        scalp_midpoint = pair_midpoint(source, detector)
        cortex = cortex_projection(scalp_midpoint)
        results.append(ProjectionResult(
            instance_id=request.instance.id,
            subject_kind="pair",
            subject_id=pair.id,
            scalp_ras_mm=scalp_midpoint,
            cortical_ras_mm=cortex,
            depth_target_ras_mm=inward_depth_target(cortex, depth_mm) if depth_mm else None,
            underlying_cortical_regions=region_probabilities(cortex, CORTICAL_CENTROIDS, "CortexLume-Cortical-Estimate"),
            deep_target_structures=region_probabilities(inward_depth_target(cortex, depth_mm), DEEP_CENTROIDS, "CortexLume-Deep-Estimate") if depth_mm else [],
            tissue_at_target="deep target estimate" if depth_mm else "cortical gray matter",
            claim_level=claim,
            status=status_value,
            qc_flags=flags,
        ))
    return results


@app.post("/v1/placements/fit", response_model=FitPlacementResponse, response_model_by_alias=True)
def fit_placement(request: FitPlacementRequest, authorization: str | None = Header(default=None)) -> FitPlacementResponse:
    authorize(authorization)
    positions = fitted_positions(request.layout, request.instance)
    mean_error, max_error = fit_errors(request.layout, positions)
    flags = ["development_fit_only"]
    if mean_error > 2:
        flags.append("mean_distance_distortion")
    if max_error > 5:
        flags.append("max_distance_distortion")
    committed = request.instance.model_copy(update={
        "fit_qc": FitQc(
            converged=True,
            iterations=1,
            mean_absolute_error_mm=mean_error,
            max_absolute_error_mm=max_error,
            flags=flags,
        )
    })
    gate = inspect_template_gate()
    return FitPlacementResponse(
        interaction_id=request.interaction_id,
        project_revision=request.project_revision,
        instance=committed,
        projections=compute_projections(request),
        template_verified=False if not gate.passed else False,
    )


@app.post("/v1/projections/batch")
def batch_projection(request: BatchProjectionRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    fit_request = FitPlacementRequest(
        interaction_id="batch",
        project_revision=0,
        template=request.template,
        layout=request.layout,
        instance=request.instance,
    )
    return {
        "results": [item.model_dump(by_alias=True, mode="json") for item in compute_projections(
            fit_request,
            None,
        )]
    }


@app.post("/v1/projects/validate")
def validate_project(request: ProjectValidationRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    issues = []
    if request.project.get("format") != "cortexlume-project":
        issues.append("unexpected_project_format")
    if request.project.get("formatVersion") != 1:
        issues.append("unsupported_project_version")
    return {"valid": not issues, "issues": issues}


@app.post("/v1/exports/csv")
def export_csv_metadata(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    return {"handledBy": "electron-main", "reason": "file-system authority remains in the desktop main process"}


@app.post("/v1/exports/bids-geometry")
def export_bids_metadata(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    return {"handledBy": "electron-main", "bidsVersion": "1.11.1", "completeDataset": False}
