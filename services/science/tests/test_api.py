import os

from fastapi.testclient import TestClient

from cortexlume_science.app import app
from cortexlume_science.atlas import atlas_status, query_probability_path, query_probability_volume
from .test_geometry import fixture_layout


os.environ["CORTEXLUME_TOKEN"] = "test-token"
client = TestClient(app)
headers = {"Authorization": "Bearer test-token"}


def test_health_reports_verified_template() -> None:
    response = client.get("/v1/health", headers=headers)
    assert response.status_code == 200
    assert response.json()["templateVerified"] is True


def test_fit_returns_geometric_coordinates_and_region_labels() -> None:
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
    assert {item["status"] for item in body["projections"]} == {"verified"}
    assert {item["claimLevel"] for item in body["projections"]} == {"geometric"}
    optodes = [item for item in body["projections"] if item["subjectKind"] == "optode"]
    assert all(item["underlyingCorticalRegions"][0]["labelEn"] for item in optodes)
    assert all(1 <= len(item["underlyingCorticalRegions"]) <= 3 for item in optodes)


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
