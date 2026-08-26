import os
from pathlib import Path

from fastapi.testclient import TestClient

from cortexlume_science.app import app
from cortexlume_science.anatomical_coverage import load_surface_atlas_data
from cortexlume_science.atlas import atlas_status, query_probability_path, query_probability_volume
from cortexlume_science.quick_targets import load_quick_target_pack
from .test_geometry import fixture_layout


os.environ["CORTEXLUME_TOKEN"] = "test-token"
client = TestClient(app)
headers = {"Authorization": "Bearer test-token"}
QUICK_TARGET_FIXTURE = Path(__file__).parent / "fixtures" / "quick_targets"


def test_health_reports_verified_template() -> None:
    response = client.get("/v1/health", headers=headers)
    assert response.status_code == 200
    assert response.json()["templateVerified"] is True


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
    assert [region["labelEn"] for region in compact["regions"]] == [
        region["labelEn"] for region in body["regions"]
    ]
    assert "mosaic" not in compact


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
