"""Resource budgets shared by the anatomical-coverage request boundary.

The TypeScript contracts package carries the same values for renderer/MCP
validation.  Keep these values deliberately small enough that a valid request
cannot allocate a channels-by-surface matrix in the science sidecar.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Final


_LIMIT_NAMES = (
    "projectJsonBytes",
    "projectionResults",
    "atlasBatchPoints",
    "atlasPathBatchItems",
    "scienceRequestBytes",
    "scienceResponseBytes",
    "projectOperationTimeoutMs",
    "maximumChannels",
    "maximumPathPointsPerChannel",
    "maximumTotalPathPoints",
    "maximumTotalSegments",
    "maximumSerializedRequestBytes",
)


def _shared_limits_path() -> Path:
    configured = os.environ.get("CORTEXLUME_LIMITS_FILE", "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    # Source checkout: services/science/cortexlume_science -> repository root.
    candidates.append(Path(__file__).resolve().parents[3] / "config" / "cross-process-limits.json")
    # PyInstaller: the spec places the same canonical file under _MEIPASS/config.
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "config" / "cross-process-limits.json")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("Shared cross-process limits asset is missing")


def _load_shared_limits() -> dict[str, int]:
    path = _shared_limits_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Shared cross-process limits asset is invalid: {path}") from error
    if not isinstance(raw, dict) or set(raw) != set(_LIMIT_NAMES):
        raise RuntimeError("Shared cross-process limits asset has an unexpected schema")
    values: dict[str, int] = {}
    for name in _LIMIT_NAMES:
        value = raw[name]
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise RuntimeError(f"Shared cross-process limit is not a positive integer: {name}")
        values[name] = value
    return values


CROSS_PROCESS_LIMITS: Final[dict[str, int]] = _load_shared_limits()
ANATOMICAL_COVERAGE_LIMITS: Final[dict[str, int]] = {
    name: CROSS_PROCESS_LIMITS[name]
    for name in (
        "maximumChannels",
        "maximumPathPointsPerChannel",
        "maximumTotalPathPoints",
        "maximumTotalSegments",
        "maximumSerializedRequestBytes",
    )
}


def coverage_limit_error(dimension: str, observed: int, maximum: int) -> str:
    """Return a stable, machine-readable domain error for a budget breach."""

    return f"coverage_request_limit_exceeded:{dimension}:{observed}:{maximum}"
