from __future__ import annotations

import base64
import binascii
import logging
import os
import stat as stat_module
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import (
    APPLICATION_VERSION,
    BUILD_METADATA,
    SCIENCE_API_VERSION,
    SIDECAR_PACKAGE_VERSION,
    __version__,
)
from .anatomical_coverage import (
    AnatomicalCoverageError,
    compute_anatomical_coverage,
    compute_anatomical_coverage_summary,
    cortical_region_target,
    list_cortical_regions,
    target_anatomical_profile,
)
from .atlas import atlas_status, query_probability_path, query_probability_volume
from .coverage_limits import ANATOMICAL_COVERAGE_LIMITS, coverage_limit_error
from .geometry import cortex_projection, fit_errors, fitted_positions, inward_depth_target, pair_midpoint
from .models import (
    AtlasLabel,
    AtlasPathQueryBatchRequest,
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
    CROSS_PROCESS_LIMITS,
)
from .quick_targets import QuickTargetError, load_quick_target_pack, quick_target_status
from .target_map_import import MAX_COMPRESSED_BYTES, process_target_map_import
from .template_gate import inspect_template_gate

app = FastAPI(title="CortexLume Science", version=SCIENCE_API_VERSION, docs_url=None, redoc_url=None)


SCIENCE_REQUEST_BYTES = CROSS_PROCESS_LIMITS["scienceRequestBytes"]
ANATOMICAL_COVERAGE_PATHS = frozenset({
    "/v1/coverage/anatomical",
    "/v1/coverage/anatomical-summary",
})
_insecure_auth_warning_emitted = False


def _coverage_error_detail(message: str) -> dict[str, object]:
    marker = "coverage_request_limit_exceeded:"
    if marker in message:
        dimensions = message.split(marker, 1)[1].split(":")
        if len(dimensions) == 3:
            dimension, observed, maximum = dimensions
            try:
                return {
                    "code": "coverage_request_limit_exceeded",
                    "dimension": dimension,
                    "observed": int(observed),
                    "maximum": int(maximum),
                    "message": message,
                }
            except ValueError:
                pass
    return {"code": "coverage_request_limit_exceeded", "message": message}


@app.exception_handler(RequestValidationError)
async def coverage_validation_error_handler(request: Request, exc: RequestValidationError):
    """Expose coverage budget breaches as compact, actionable 413 errors.

    Pydantic's normal 422 response includes the complete invalid input in its
    ``input`` field.  That is both noisy and needlessly echoes a potentially
    multi-megabyte payload, so only the coverage budget error is normalized;
    all other validation failures retain FastAPI's standard response.
    """

    if request.url.path.startswith("/v1/coverage/"):
        marker = "coverage_request_limit_exceeded:"
        for issue in exc.errors():
            message = str(issue.get("msg", ""))
            if marker not in message:
                continue
            return JSONResponse(status_code=413, content={"detail": _coverage_error_detail(message)})
    return await request_validation_exception_handler(request, exc)


def _coverage_limit_detail(observed: int) -> dict[str, object]:
    maximum = ANATOMICAL_COVERAGE_LIMITS["maximumSerializedRequestBytes"]
    message = coverage_limit_error("maximumSerializedRequestBytes", observed, maximum)
    return _coverage_error_detail(message)


@app.middleware("http")
async def enforce_request_budget(request: Request, call_next):
    """Bound request bodies before Pydantic or scientific code sees them.

    A declared ``Content-Length`` is only an early rejection hint: proxies and
    clients can omit it, use chunked transfer encoding, or lie about it.  For
    those requests, consume the ASGI body one chunk at a time and stop as soon
    as the path-specific budget is crossed.  A successful read is cached on
    this ``Request`` so FastAPI receives exactly the same bytes downstream.

    Authentication intentionally runs before any body read.  The sidecar is
    loopback-only, but an unauthenticated client must not be able to make us
    consume even a bounded upload before it is rejected.
    """
    if request.method in {"POST", "PUT", "PATCH"}:
        try:
            authorize(request.headers.get("authorization"))
        except HTTPException as error:
            headers = dict(error.headers or {})
            return JSONResponse(
                status_code=error.status_code,
                content={"detail": error.detail},
                headers=headers,
            )

        is_coverage_request = request.url.path in ANATOMICAL_COVERAGE_PATHS
        request_limit = (
            ANATOMICAL_COVERAGE_LIMITS["maximumSerializedRequestBytes"]
            if is_coverage_request else SCIENCE_REQUEST_BYTES
        )
        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                declared_bytes = int(declared)
                if declared_bytes > request_limit:
                    detail: object = _coverage_limit_detail(declared_bytes) if is_coverage_request else (
                        f"Request exceeds the {SCIENCE_REQUEST_BYTES}-byte science payload limit"
                    )
                    return JSONResponse(
                        status_code=413,
                        content={"detail": detail},
                    )
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})

        # ``Request.body()`` reads until the client closes the stream.  Use the
        # streaming API so a missing/false Content-Length cannot turn into an
        # unbounded read.  Do not retain the chunk that crossed the boundary:
        # it is not needed for the rejection response.
        chunks: list[bytes] = []
        received_bytes = 0
        async for chunk in request.stream():
            if not chunk:
                continue
            received_bytes += len(chunk)
            if received_bytes > request_limit:
                detail = _coverage_limit_detail(received_bytes) if is_coverage_request else (
                    f"Request exceeds the {SCIENCE_REQUEST_BYTES}-byte science payload limit"
                )
                return JSONResponse(
                    status_code=413,
                    content={"detail": detail},
                )
            chunks.append(chunk)

        # Starlette's BaseHTTPMiddleware replays ``_body`` through its wrapped
        # receive callable.  Setting it after a complete stream read therefore
        # makes FastAPI's body parser see the bounded bytes exactly once.
        request._body = b"".join(chunks)  # type: ignore[attr-defined]
    return await call_next(request)


def authorize(authorization: str | None = Header(default=None)) -> None:
    global _insecure_auth_warning_emitted
    expected = os.environ.get("CORTEXLUME_TOKEN", "").strip()
    if not expected:
        if os.environ.get("CORTEXLUME_ALLOW_INSECURE_DEV_AUTH") != "1":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="CORTEXLUME_TOKEN is required; set CORTEXLUME_ALLOW_INSECURE_DEV_AUTH=1 only for local development",
            )
        # Deliberately noisy: a developer must be able to see that this
        # sidecar is accepting a well-known token. The warning is emitted by
        # the standard server logger and does not disclose a production token.
        if not _insecure_auth_warning_emitted:
            logging.getLogger("cortexlume_science.auth").warning(
                "INSECURE DEVELOPMENT AUTH ENABLED: using the well-known development-token; configure CORTEXLUME_TOKEN for normal use",
            )
            _insecure_auth_warning_emitted = True
        expected = "development-token"
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid sidecar token")


def _read_authorized_nifti_file(file_path: object) -> bytes:
    """Read only a sidecar-staged NIfTI path under the private temp root."""
    if not isinstance(file_path, str) or not file_path:
        raise HTTPException(status_code=422, detail="filePath must be a non-empty absolute path")
    root_config = os.environ.get(
        "CORTEXLUME_NIFTI_TEMP_DIR",
        str(Path(tempfile.gettempdir()) / "cortexlume-nifti"),
    )
    try:
        candidate = Path(file_path)
        if not candidate.is_absolute():
            raise ValueError("path is not absolute")
        root = Path(root_config).resolve(strict=True)
        resolved = candidate.resolve(strict=True)
        if not root.is_dir() or resolved == root:
            raise ValueError("path is not a file below the staging root")
        resolved.relative_to(root)
        # Staging uses an exclusive random filename. Reject a final symlink as
        # an additional guard against a path being substituted between checks.
        if candidate.is_symlink():
            raise ValueError("staged path must not be a symbolic link")
        metadata = resolved.stat()
        if not stat_module.S_ISREG(metadata.st_mode):
            raise ValueError("staged path is not a regular file")
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=403, detail="filePath is outside the authorized NIfTI staging directory") from error
    if metadata.st_size > MAX_COMPRESSED_BYTES:
        raise HTTPException(status_code=413, detail="Target map exceeds the import size limit")
    try:
        with resolved.open("rb") as stream:
            raw = stream.read(MAX_COMPRESSED_BYTES + 1)
    except OSError as error:
        raise HTTPException(status_code=422, detail="The staged NIfTI file could not be read") from error
    if len(raw) > MAX_COMPRESSED_BYTES:
        raise HTTPException(status_code=413, detail="Target map exceeds the import size limit")
    return raw


@app.get("/v1/health")
def health(_: None = Header(default=None, alias="x-unused"), authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    gate = inspect_template_gate()
    atlas = atlas_status()
    targets = quick_target_status()
    return {
        "ok": True,
        # Kept for clients using the original health response shape.
        "version": __version__,
        **BUILD_METADATA,
        # Spell these out as well so a future metadata implementation cannot
        # accidentally omit the fields from this compatibility endpoint.
        "applicationVersion": APPLICATION_VERSION,
        "sidecarPackageVersion": SIDECAR_PACKAGE_VERSION,
        "scienceApiVersion": SCIENCE_API_VERSION,
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


@app.get("/v1/targets/catalog")
def list_quick_target_catalog(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    try:
        return load_quick_target_pack().catalog_overview()
    except (OSError, ValueError, KeyError, QuickTargetError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


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


@app.post("/v1/coverage/target-profile")
def functional_target_anatomical_profile(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    try:
        return target_anatomical_profile(
            payload.get("vertexIndices", []),
            payload.get("vertexMasses", []),
            payload.get("minimumAtlasMembership", 0.05),
        )
    except (TypeError, ValueError, AnatomicalCoverageError) as error:
        detail = str(error)
        status_code = 422 if detail.startswith("target_profile_") else 503
        raise HTTPException(status_code=status_code, detail=detail) from error


@app.get("/v1/atlas/cortical-regions")
def atlas_cortical_regions(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    try:
        return {"atlasId": "Harvard-Oxford cortical lateralized", "regions": list(list_cortical_regions())}
    except AnatomicalCoverageError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/v1/atlas/cortical-region-target")
def atlas_cortical_region_target(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    label = payload.get("label")
    if not isinstance(label, str) or not label.strip():
        raise HTTPException(status_code=422, detail="A Harvard-Oxford cortical region label is required")
    try:
        return cortical_region_target(label)
    except AnatomicalCoverageError as error:
        status_code = 404 if str(error) == "unknown_harvard_oxford_cortical_region" else 503
        raise HTTPException(status_code=status_code, detail=str(error)) from error


@app.post("/v1/targets/import")
def import_functional_target(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    file_name = payload.get("fileName")
    declared_space = payload.get("declaredSpace")
    encoded = payload.get("dataBase64")
    file_path = payload.get("filePath")
    if not isinstance(file_name, str) or (encoded is None and file_path is None) or (encoded is not None and file_path is not None):
        raise HTTPException(status_code=422, detail="fileName and exactly one of filePath or dataBase64 are required")
    if declared_space not in ("MNI152NLin6Asym", "NeurosynthMNI152-2mm"):
        raise HTTPException(status_code=422, detail="Unsupported declared target space")
    if file_path is not None:
        raw = _read_authorized_nifti_file(file_path)
    else:
        if not isinstance(encoded, str):
            raise HTTPException(status_code=422, detail="dataBase64 must be a string")
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
    pair_depth_overrides_mm: dict | None = None,
) -> list[ProjectionResult]:
    """Development-only ellipsoid preview; verified geometry is produced by the mesh HeadModel."""
    positions = fitted_positions(request.layout, request.instance)
    status_value = "provisional"
    claim = "development_only"
    atlas = atlas_status()
    flags: list[str] = ["development_ellipsoid_approximation"]
    if not atlas.available:
        flags.append(atlas.issue or "atlas_unavailable")
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
        pair_depth_mm = (pair_depth_overrides_mm or {}).get(pair.id, depth_mm)
        results.append(ProjectionResult(
            instance_id=request.instance.id,
            subject_kind="pair",
            subject_id=pair.id,
            scalp_ras_mm=scalp_midpoint,
            cortical_ras_mm=cortex,
            depth_target_ras_mm=inward_depth_target(cortex, pair_depth_mm) if pair_depth_mm else None,
            underlying_cortical_regions=query_probability_volume(cortex, "cortical", probability_threshold) if atlas.available else [],
            deep_target_structures=query_probability_volume(inward_depth_target(cortex, pair_depth_mm), "subcortical", probability_threshold) if pair_depth_mm and atlas.available else [],
            tissue_at_target=None,
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
            request.settings.default_depth_mm,
            request.settings.atlas_probability_threshold,
            request.settings.pair_depth_overrides_mm,
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


@app.post("/v1/atlas/query-path-batch")
def atlas_query_path_batch(
    request: AtlasPathQueryBatchRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Annotate several channel paths in one sidecar request."""
    authorize(authorization)
    atlas = atlas_status()
    if not atlas.available:
        return {
            "atlasVerified": False,
            "issue": atlas.issue,
            "results": [{"id": item.id, "regions": []} for item in request.items],
        }
    return {
        "atlasVerified": True,
        "issue": None,
        "results": [{
            "id": item.id,
            "regions": [region.model_dump(by_alias=True) for region in query_probability_path(
                item.points, "cortical", request.probability_threshold,
            )],
        } for item in request.items],
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
        if detail.startswith("coverage_request_limit_exceeded"):
            raise HTTPException(status_code=413, detail=_coverage_error_detail(detail)) from error
        if detail.startswith(("coverage_channel_", "coverage_kernel_")):
            raise HTTPException(status_code=422, detail=detail) from error
        raise HTTPException(status_code=503, detail=detail) from error


@app.post("/v1/coverage/anatomical-summary")
def anatomical_coverage_summary(
    request: AnatomicalCoverageRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Return only the compact atlas distribution needed by Agent planning."""
    authorize(authorization)
    try:
        return compute_anatomical_coverage_summary(request)
    except AnatomicalCoverageError as error:
        detail = str(error)
        if detail.startswith("coverage_request_limit_exceeded"):
            raise HTTPException(status_code=413, detail=_coverage_error_detail(detail)) from error
        if detail.startswith(("coverage_channel_", "coverage_kernel_")):
            raise HTTPException(status_code=422, detail=detail) from error
        raise HTTPException(status_code=503, detail=detail) from error


@app.post("/v1/projects/validate")
def validate_project(request: ProjectValidationRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization)
    issues = []
    if request.project.get("format") != "cortexlume-project":
        issues.append("unexpected_project_format")
    if request.project.get("formatVersion") != 2:
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
