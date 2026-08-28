import asyncio
import json
import os
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from cortexlume_science import BUILD_METADATA
from cortexlume_science.app import app
from cortexlume_science.anatomical_coverage import load_surface_atlas_data
from cortexlume_science.atlas import atlas_status, query_probability_path, query_probability_volume
from cortexlume_science.coverage_limits import ANATOMICAL_COVERAGE_LIMITS
from cortexlume_science.quick_targets import load_quick_target_pack
from .test_geometry import fixture_layout


os.environ["CORTEXLUME_TOKEN"] = "test-token"
client = TestClient(app)
headers = {"Authorization": "Bearer test-token"}
QUICK_TARGET_FIXTURE = Path(__file__).parent / "fixtures" / "quick_targets"


def _call_asgi_in_chunks(
    path: str,
    chunks: list[bytes],
    *,
    authorization: str | None = "Bearer test-token",
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Exercise the real ASGI receive path and return responses/read count."""

    async def run() -> tuple[list[dict[str, Any]], int]:
        messages = [
            {"type": "http.request", "body": chunk, "more_body": index < len(chunks) - 1}
            for index, chunk in enumerate(chunks)
        ]
        read_count = 0
        sent: list[dict[str, Any]] = []
        headers_for_scope = [
            (b"content-type", b"application/json"),
            (b"transfer-encoding", b"chunked"),
        ]
        if authorization is not None:
            headers_for_scope.append((b"authorization", authorization.encode("ascii")))
        headers_for_scope.extend(extra_headers or [])
        raw_path = path.encode("ascii")
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": raw_path,
            "query_string": b"",
            "headers": headers_for_scope,
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8000),
            "root_path": "",
        }

        async def receive() -> dict[str, Any]:
            nonlocal read_count
            read_count += 1
            if messages:
                return messages.pop(0)
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            sent.append(message)

        await app(scope, receive, send)
        return sent, read_count

    return asyncio.run(run())


def _response_json(sent: list[dict[str, Any]]) -> dict[str, Any]:
    body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    return json.loads(body)


def test_health_reports_verified_template() -> None:
    response = client.get("/v1/health", headers=headers)
    assert response.status_code == 200
    assert response.json()["templateVerified"] is True
    body = response.json()
    assert body["applicationVersion"] == BUILD_METADATA["applicationVersion"]
    assert body["sidecarPackageVersion"] == BUILD_METADATA["sidecarPackageVersion"]
    assert body["scienceApiVersion"] == BUILD_METADATA["scienceApiVersion"]
    assert len(body["dependencyLockSha256"]) == 64


def test_authentication_fails_closed_without_a_configured_token(monkeypatch) -> None:
    monkeypatch.delenv("CORTEXLUME_TOKEN", raising=False)
    monkeypatch.delenv("CORTEXLUME_ALLOW_INSECURE_DEV_AUTH", raising=False)
    response = client.get("/v1/health")
    assert response.status_code == 503
    assert "CORTEXLUME_TOKEN is required" in response.json()["detail"]


def test_insecure_development_token_requires_explicit_opt_in(monkeypatch, caplog) -> None:
    monkeypatch.delenv("CORTEXLUME_TOKEN", raising=False)
    monkeypatch.setenv("CORTEXLUME_ALLOW_INSECURE_DEV_AUTH", "1")
    response = client.get("/v1/health", headers={"Authorization": "Bearer development-token"})
    assert response.status_code == 200
    assert "INSECURE DEVELOPMENT AUTH ENABLED" in caplog.text


def test_quick_target_search_and_map_endpoints(monkeypatch) -> None:
    monkeypatch.setenv("CORTEXLUME_QUICK_TARGET_DIR", str(QUICK_TARGET_FIXTURE))
    monkeypatch.setenv("CORTEXLUME_ALLOW_QUICK_TARGET_FIXTURE", "1")
    load_quick_target_pack.cache_clear()
    try:
        search = client.get("/v1/targets", headers=headers, params={"q": "working mem"})
        assert search.status_code == 200
        assert search.json()["targets"][0]["id"] == "neurosynth:working-memory"

        synonym = client.get("/v1/targets", headers=headers, params={"q": "short-term memory"})
        assert synonym.status_code == 200
        assert synonym.json()["targets"][0]["id"] == "neurosynth:working-memory"

        typo = client.get("/v1/targets", headers=headers, params={"q": "langauge"})
        assert typo.status_code == 200
        assert typo.json()["targets"][0]["id"] == "neurosynth:language"

        catalog = client.get("/v1/targets/catalog", headers=headers)
        assert catalog.status_code == 200
        assert catalog.json()["count"] == len(catalog.json()["targets"])
        assert {target["id"] for target in catalog.json()["targets"]} >= {"neurosynth:working-memory"}

        response = client.get("/v1/targets/neurosynth:working-memory", headers=headers)
        assert response.status_code == 200
        body = response.json()
        assert body["vertexCount"] == 25_000
        assert len(body["vertexIndices"]) == len(body["values"]) > 0
        assert body["provenance"]["sourceKind"] == "neurosynth-quick"
        assert body["provenance"]["targetSurface"] == "Cedalion-ICBM152-25k"
        assert len(body["provenance"]["mapSha256"]) == 64

        missing = client.get("/v1/targets/neurosynth:missing", headers=headers)
        assert missing.status_code == 404
    finally:
        load_quick_target_pack.cache_clear()


def test_fit_marks_ellipsoid_preview_as_development_only() -> None:
    layout, instance = fixture_layout()
    payload = {
        "interactionId": "test",
        "projectRevision": 2,
        "template": {
            "id": "MNI152NLin6Asym",
            "assetVersion": "development-placeholder-0",
            "coordinateConvention": "RAS+",
            "units": "mm",
            "verified": False,
            "manifestSha256": "UNVERIFIED",
            "scalpMeshSha256": "UNVERIFIED",
            "cortexMeshSha256": "UNVERIFIED",
            "atlasSha256": "UNVERIFIED",
        },
        "layout": layout.model_dump(by_alias=True, mode="json"),
        "instance": instance.model_dump(by_alias=True, mode="json"),
    }
    response = client.post("/v1/placements/fit", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["templateVerified"] is True
    assert {item["status"] for item in body["projections"]} == {"provisional"}
    assert {item["claimLevel"] for item in body["projections"]} == {"development_only"}
    assert all("development_ellipsoid_approximation" in item["qcFlags"] for item in body["projections"])
    optodes = [item for item in body["projections"] if item["subjectKind"] == "optode"]
    assert all(item["underlyingCorticalRegions"][0]["labelEn"] for item in optodes)
    assert all(1 <= len(item["underlyingCorticalRegions"]) <= 3 for item in optodes)


def test_project_validation_accepts_current_v2_and_rejects_legacy_v1() -> None:
    current = client.post("/v1/projects/validate", headers=headers, json={
        "project": {"format": "cortexlume-project", "formatVersion": 2},
    })
    assert current.status_code == 200
    assert current.json() == {"valid": True, "issues": []}

    legacy = client.post("/v1/projects/validate", headers=headers, json={
        "project": {"format": "cortexlume-project", "formatVersion": 1},
    })
    assert legacy.status_code == 200
    assert legacy.json()["issues"] == ["unsupported_project_version"]


def test_probability_volume_matches_fsl_golden_coordinates() -> None:
    assert atlas_status().available is True
    cortical = query_probability_volume((38, -44, 48), "cortical")
    assert [(item.label_en, item.probability) for item in cortical] == [
        ("Right Superior Parietal Lobule", 0.45),
        ("Right Supramarginal Gyrus, posterior division", 0.12),
        ("Right Angular Gyrus", 0.12),
    ]
    left = query_probability_volume((-52, -13, 48), "cortical")
    assert [(item.label_en, item.probability) for item in left] == [
        ("Left Postcentral Gyrus", 0.43),
        ("Left Precentral Gyrus", 0.41),
    ]


def test_atlas_query_endpoint_preserves_raw_percentages() -> None:
    response = client.post("/v1/atlas/query-batch", headers=headers, json={
        "points": [{"id": "golden", "corticalRasMm": [38, -44, 48]}],
        "probabilityThreshold": 0,
    })
    assert response.status_code == 200
    body = response.json()
    assert body["atlasVerified"] is True
    assert body["results"][0]["corticalRegions"][0]["probability"] == 0.45


def test_harvard_oxford_region_catalog_and_sparse_target() -> None:
    catalog = client.get("/v1/atlas/cortical-regions", headers=headers)
    assert catalog.status_code == 200, catalog.text
    regions = catalog.json()["regions"]
    assert "Left Precentral Gyrus" in regions

    response = client.post(
        "/v1/atlas/cortical-region-target",
        headers=headers,
        json={"label": "Left Precentral Gyrus"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["target"]["label"] == "Left Precentral Gyrus"
    assert body["vertexCount"] == 25_000
    assert len(body["vertexIndices"]) == len(body["values"]) > 0
    assert body["vertexIndices"] == sorted(body["vertexIndices"])
    assert 0 < max(body["values"]) <= 1
    assert body["provenance"]["sourceKind"] == "harvard-oxford-region"
    assert body["provenance"]["validation"]["probabilities"] == "original percent not renormalized"

    unknown = client.post(
        "/v1/atlas/cortical-region-target",
        headers=headers,
        json={"label": "Definitely not an atlas region"},
    )
    assert unknown.status_code == 404


def test_anatomical_coverage_endpoint_returns_single_sparse_mosaic() -> None:
    vertices = load_surface_atlas_data().vertices_ras_mm
    payload = {
        "channels": [{
            "instanceId": "00000000-0000-4000-8000-000000000001",
            "pairId": "00000000-0000-4000-8000-000000000011",
            "channelNumber": 1,
            "pointsRasMm": [vertices[0].tolist(), vertices[100].tolist()],
        }],
    }
    response = client.post("/v1/coverage/anatomical", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sourceKind"] == "geometric-anatomical-coverage-prior"
    assert body["vertexCount"] == 25_000
    assert len(body["mosaic"]["vertexIndices"]) > 0
    assert len(body["mosaic"]["vertexIndices"]) == len(body["mosaic"]["regionIndices"])
    assert body["provenance"]["interpretation"].startswith("Geometric anatomical coverage prior")
    assert "sensitivity" not in body["sourceKind"]

    summary = client.post("/v1/coverage/anatomical-summary", headers=headers, json=payload)
    assert summary.status_code == 200, summary.text
    compact = summary.json()
    assert compact["atlasId"] == body["provenance"]["atlasId"]
    assert compact["atlasSupportFraction"] == body["qc"]["atlasSupportFraction"]
    assert compact["regions"] == [{
        "atlasId": region["atlasId"],
        "labelEn": region["labelEn"],
        "massFraction": region["coveredAtlasMassFraction"],
    } for region in body["regions"]]
    assert "mosaic" not in compact


def test_anatomical_coverage_limit_breach_is_compact_413() -> None:
    channels = [{
        "instanceId": f"00000000-0000-4000-8000-{index + 1:012d}",
        "pairId": f"00000000-0000-4000-8000-{index + 10_000:012d}",
        "pointsRasMm": [[0, 0, 0], [1, 0, 0]],
    } for index in range(ANATOMICAL_COVERAGE_LIMITS["maximumChannels"] + 1)]
    response = client.post("/v1/coverage/anatomical", headers=headers, json={"channels": channels})
    assert response.status_code == 413
    assert response.json() == {
        "detail": {
            "code": "coverage_request_limit_exceeded",
            "dimension": "maximumChannels",
            "observed": ANATOMICAL_COVERAGE_LIMITS["maximumChannels"] + 1,
            "maximum": ANATOMICAL_COVERAGE_LIMITS["maximumChannels"],
            "message": (
                "Value error, coverage_request_limit_exceeded:maximumChannels:"
                f"{ANATOMICAL_COVERAGE_LIMITS['maximumChannels'] + 1}:"
                f"{ANATOMICAL_COVERAGE_LIMITS['maximumChannels']}"
            ),
        },
    }


def test_anatomical_coverage_serialized_byte_limit_is_enforced_on_raw_body() -> None:
    payload = {
        "channels": [{
            "instanceId": "00000000-0000-4000-8000-000000000001",
            "pairId": "00000000-0000-4000-8000-000000000011",
            "pointsRasMm": [[0, 0, 0], [1, 0, 0]],
        }],
    }
    canonical = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    maximum = ANATOMICAL_COVERAGE_LIMITS["maximumSerializedRequestBytes"]
    body = canonical + b" " * (maximum + 1 - len(canonical))
    response = client.post(
        "/v1/coverage/anatomical",
        headers={**headers, "Content-Type": "application/json"},
        content=body,
    )
    assert response.status_code == 413
    assert response.json() == {"detail": {
        "code": "coverage_request_limit_exceeded",
        "dimension": "maximumSerializedRequestBytes",
        "observed": len(body),
        "maximum": maximum,
        "message": f"coverage_request_limit_exceeded:maximumSerializedRequestBytes:{len(body)}:{maximum}",
    }}


def test_anatomical_coverage_chunked_body_accepts_exact_limit_and_replays_it() -> None:
    payload = {
        "channels": [{
            "instanceId": "00000000-0000-4000-8000-000000000001",
            "pairId": "00000000-0000-4000-8000-000000000011",
            "pointsRasMm": [[0, 0, 0], [1, 0, 0]],
        }],
    }
    canonical = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    maximum = ANATOMICAL_COVERAGE_LIMITS["maximumSerializedRequestBytes"]
    body = canonical + b" " * (maximum - len(canonical))
    sent, read_count = _call_asgi_in_chunks(
        "/v1/coverage/anatomical",
        [body[:-1], body[-1:]],
    )
    assert _response_json(sent)["sourceKind"] == "geometric-anatomical-coverage-prior"
    assert read_count == 2


def test_anatomical_coverage_chunked_body_stops_at_first_overflow() -> None:
    maximum = ANATOMICAL_COVERAGE_LIMITS["maximumSerializedRequestBytes"]
    first = b"{" * maximum
    sent, read_count = _call_asgi_in_chunks(
        "/v1/coverage/anatomical",
        [first, b"x", b"unread-after-overflow"],
    )
    assert _response_json(sent) == {"detail": {
        "code": "coverage_request_limit_exceeded",
        "dimension": "maximumSerializedRequestBytes",
        "observed": maximum + 1,
        "maximum": maximum,
        "message": f"coverage_request_limit_exceeded:maximumSerializedRequestBytes:{maximum + 1}:{maximum}",
    }}
    assert read_count == 2


def test_anatomical_coverage_false_small_content_length_still_enforces_chunks() -> None:
    maximum = ANATOMICAL_COVERAGE_LIMITS["maximumSerializedRequestBytes"]
    sent, read_count = _call_asgi_in_chunks(
        "/v1/coverage/anatomical",
        [b"{" * maximum, b"x", b"unread-after-overflow"],
        extra_headers=[(b"content-length", b"1")],
    )
    assert _response_json(sent)["detail"]["observed"] == maximum + 1
    assert read_count == 2


def test_unauthenticated_chunked_upload_is_rejected_before_receive(monkeypatch) -> None:
    monkeypatch.delenv("CORTEXLUME_TOKEN", raising=False)
    monkeypatch.delenv("CORTEXLUME_ALLOW_INSECURE_DEV_AUTH", raising=False)
    sent, read_count = _call_asgi_in_chunks(
        "/v1/coverage/anatomical",
        [b"unread-body", b"unread-after-auth"],
        authorization=None,
    )
    assert _response_json(sent) == {
        "detail": "CORTEXLUME_TOKEN is required; set CORTEXLUME_ALLOW_INSECURE_DEV_AUTH=1 only for local development",
    }
    assert sent[0]["status"] == 503
    assert read_count == 0


def test_channel_path_aggregates_only_labeled_cortical_voxels() -> None:
    regions = query_probability_path([(38, -44, 48), (-52, -13, 48), (0, 0, -72)])
    assert [region.label_en for region in regions[:2]] == [
        "Right Superior Parietal Lobule",
        "Left Postcentral Gyrus",
    ]
    response = client.post("/v1/atlas/query-path", headers=headers, json={
        "points": [[38, -44, 48], [-52, -13, 48], [0, 0, -72]],
        "probabilityThreshold": 0,
    })
    assert response.status_code == 200
    assert response.json()["regions"][0]["labelEn"] == "Right Superior Parietal Lobule"
