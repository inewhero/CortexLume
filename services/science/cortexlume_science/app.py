from __future__ import annotations

import base64
import binascii
import os
from typing import Any

from fastapi import FastAPI, Header, HTTPException, status

from . import __version__
from .anatomical_coverage import AnatomicalCoverageError, compute_anatomical_coverage
from .atlas import atlas_status, query_probability_path, query_probability_volume
from .geometry import cortex_projection, fit_errors, fitted_positions, inward_depth_target, pair_midpoint
from .models import (
    AtlasLabel,
    AtlasPathQueryRequest,
    AtlasQueryRequest,
    AnatomicalCoverageAnalysis,
    AnatomicalCoverageRequest,
    BatchProjectionRequest,
    FitPlacementRequest,
    FitPlacementResponse,
    FitQc,
    ProjectValidationRequest,
    ProjectionResult,
)
from .quick_targets import QuickTargetError, load_quick_target_pack, quick_target_status
from .target_map_import import MAX_COMPRESSED_BYTES, process_target_map_import
from .template_gate import inspect_template_gate

app = FastAPI(title="CortexLume Science", version=__version__, docs_url=None, redoc_url=None)


def authorize(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get("CORTEXLUME_TOKEN", "development-token")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid sidecar token")


@app.get("/v1/health")
def health(_: None = Header(default=None, alias="x-unused"), authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    gate = inspect_template_gate()
    atlas = atlas_status()
    targets = quick_target_status()
    return {
        "ok": True,
        "version": __version__,
        "templateVerified": gate.passed,
        "templateIssues": list(gate.issues),
        "atlasVerified": atlas.available,
        "atlasIssue": atlas.issue,
        "quickTargetsAvailable": targets.available,
        "quickTargetsIssue": targets.issue,
        "quickTargetPackId": targets.pack_id,
    }


@app.get("/v1/targets")
def search_quick_targets(
    q: str = "",
    limit: int = 20,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    if limit < 1 or limit > 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    try:
        pack = load_quick_target_pack()
    except (OSError, ValueError, KeyError, QuickTargetError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "targets": pack.search(q, limit),
        "provenance": pack.provenance(),
    }


@app.get("/v1/targets/{target_id}")
def get_quick_target(
    target_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    try:
        pack = load_quick_target_pack()
    except (OSError, ValueError, KeyError, QuickTargetError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    target = pack.get(target_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Quick Target not found")
    return target


@app.post("/v1/targets/import")
def import_functional_target(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    file_name = payload.get("fileName")
    declared_space = payload.get("declaredSpace")
    encoded = payload.get("dataBase64")
    if not isinstance(file_name, str) or not isinstance(encoded, str):
        raise HTTPException(status_code=422, detail="fileName and dataBase64 are required")
    if declared_space not in ("MNI152NLin6Asym", "NeurosynthMNI152-2mm"):
        raise HTTPException(status_code=422, detail="Unsupported declared target space")
    if len(encoded) > ((MAX_COMPRESSED_BYTES + 2) // 3) * 4:
        raise HTTPException(status_code=413, detail="Target map exceeds the import size limit")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail="Target map payload is not valid base64") from error
    return process_target_map_import(raw, file_name, declared_space)


@app.get("/v1/template-manifest")
def template_manifest(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    gate = inspect_template_gate()
    return {"verified": gate.passed, "issues": list(gate.issues), "manifest": gate.manifest}


def compute_projections(
    request: FitPlacementRequest,
    depth_mm: float | None = None,
    probability_threshold: float = 0.0,
) -> list[ProjectionResult]:
    positions = fitted_positions(request.layout, request.instance)
    gate = inspect_template_gate()
    status_value = "verified" if gate.passed else "provisional"
    claim = "geometric"
    atlas = atlas_status()
    flags: list[str] = [] if atlas.available else [atlas.issue or "atlas_unavailable"]
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
            underlying_cortical_regions=query_probability_volume(cortex, "cortical", probability_threshold) if atlas.available else [],
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
            underlying_cortical_regions=query_probability_volume(cortex, "cortical", probability_threshold) if atlas.available else [],
            deep_target_structures=query_probability_volume(inward_depth_target(cortex, depth_mm), "subcortical", probability_threshold) if depth_mm and atlas.available else [],
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
    flags = []
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
        template_verified=gate.passed,
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
            request.settings.atlas_probability_threshold,
        )]
    }


@app.post("/v1/atlas/query-batch")
def atlas_query_batch(request: AtlasQueryRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    atlas = atlas_status()
    return {
        "atlasVerified": atlas.available,
        "issue": atlas.issue,
        "results": [{
            "id": point.id,
            "corticalRegions": [item.model_dump(by_alias=True) for item in query_probability_volume(
                point.cortical_ras_mm, "cortical", request.probability_threshold
            )] if atlas.available and point.cortical_ras_mm else [],
            "deepStructures": [item.model_dump(by_alias=True) for item in query_probability_volume(
                point.deep_target_ras_mm, "subcortical", request.probability_threshold
            )] if atlas.available and point.deep_target_ras_mm else [],
        } for point in request.points],
    }


@app.post("/v1/atlas/query-path")
def atlas_query_path(request: AtlasPathQueryRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    atlas = atlas_status()
    if not atlas.available:
        return {
            "atlasVerified": False, "issue": atlas.issue, "regions": [],
        }
    return {
        "atlasVerified": True,
        "issue": None,
        "regions": [item.model_dump(by_alias=True) for item in query_probability_path(
            request.points, "cortical", request.probability_threshold
        )],
    }


@app.post(
    "/v1/coverage/anatomical",
    response_model=AnatomicalCoverageAnalysis,
    response_model_by_alias=True,
)
def anatomical_coverage(
    request: AnatomicalCoverageRequest,
    authorization: str | None = Header(default=None),
) -> AnatomicalCoverageAnalysis:
    """Build a visual anatomical-region mosaic from geometric channel paths."""
    authorize(authorization)
    try:
        return compute_anatomical_coverage(request)
    except AnatomicalCoverageError as error:
        detail = str(error)
        if detail.startswith(("coverage_channel_", "coverage_kernel_")):
            raise HTTPException(status_code=422, detail=detail) from error
        raise HTTPException(status_code=503, detail=detail) from error


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
